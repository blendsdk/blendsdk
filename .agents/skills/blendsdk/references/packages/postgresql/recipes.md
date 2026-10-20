> **Package**: `blendsdk/postgresql`

# postgresql Advanced Patterns

This document collects end-to-end solutions that combine the building blocks introduced in Core Concepts: transactions, statement builders, query hooks, compiled expressions, and lifecycle management. Each section presents a concrete production problem — checkout flows, ingestion pipelines, job queues, reporting, service lifecycle — with a complete implementation, the reasoning behind the pattern, and the constraints to keep in mind.

The patterns covered are:

- [Transactional Units of Work](#transactional-units-of-work) — multiple builders and raw SQL in one all-or-nothing transaction
- [Reusable Hook Pipelines](#reusable-hook-pipelines) — composable `beforeQuery`/`afterQuery` policies shared across every write and read path
- [Conditional Filters with the Expression API](#conditional-filters-with-the-expression-api) — optional, grouped, injection-safe predicates for maintenance jobs and reads
- [Idempotent Writes: Check-then-Act and Native Upserts](#idempotent-writes-check-then-act-and-native-upserts) — exactly-one-row semantics for retried or duplicated input
- [Job Claiming with SKIP LOCKED](#job-claiming-with-skip-locked) — a work queue on top of the `jobs` table with guarded updates and stall recovery
- [Report Queries with Result Shaping](#report-queries-with-result-shaping) — named-parameter aggregation shaped at the result boundary
- [Service Lifecycle and Pool Management](#service-lifecycle-and-pool-management) — pool sizing, fail-fast startup, and deterministic shutdown

All examples assume the referenced tables exist on the server; each interface models the columns it uses. Import every symbol you use — all symbols shown below are public exports of `blendsdk/postgresql` (or, where noted, of `blendsdk/expression`).

---

## Transactional Units of Work

### When to use it

- Two or more writes that must succeed or fail **as a group** — order placement, funds transfer, provisioning.
- A write that must be **guarded by a read** — checking stock, balances, or quotas before mutating.
- Any flow where a partially applied change would corrupt business state and manual `BEGIN`/`COMMIT` orchestration would be error-prone.

### The pattern

`withTransaction()` pins one pooled client and runs `BEGIN` → work → `COMMIT`, rolling back and rethrowing when the callback throws. Every builder call on the callback's `txDb` handle — and every raw `executeQuery` — joins the same server-side transaction. The example below composes an INSERT builder, a locking SELECT, an UPDATE builder, and a second INSERT builder into a single checkout operation.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface OrderRow {
  id?: number;
  user_id: number;
  status: string;
  total: string;
}

interface OrderItemRow {
  id?: number;
  order_id: number;
  product_id: number;
  quantity: number;
  unit_price: string;
}

interface ProductRow {
  id?: number;
  name: string;
  stock: number;
  price: string;
}

interface CartLine {
  productId: number;
  quantity: number;
}

class InsufficientStockError extends Error {
  public readonly productId: number;
  public readonly available: number;
  public readonly requested: number;

  constructor(productId: number, available: number, requested: number) {
    super(`Product ${productId}: requested ${requested}, only ${available} in stock`);
    this.name = 'InsufficientStockError';
    this.productId = productId;
    this.available = available;
    this.requested = requested;
  }
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

async function placeOrder(userId: number, lines: CartLine[]): Promise<number> {
  // Deterministic lock ordering prevents deadlocks between concurrent checkouts
  const sortedLines = [...lines].sort((a, b) => a.productId - b.productId);

  return db.withTransaction(async (txDb) => {
    // 1. Create the order header; RETURNING provides the generated id
    const order = await txDb
      .insert<OrderRow>('orders')
      .values({ user_id: userId, status: 'pending', total: '0.00' })
      .returning(['id'])
      .executeReturnSingle();

    if (!order?.id) {
      throw new Error('Order insert did not return an id');
    }

    let total = 0;

    for (const line of sortedLines) {
      // 2. Lock the product row for the rest of the transaction
      const { records } = await txDb.executeQuery<ProductRow>(
        `SELECT id, name, stock, price
           FROM products
          WHERE id = :id
          FOR UPDATE`,
        { id: line.productId }
      );

      const product = records[0];
      if (!product) {
        throw new Error(`Unknown product: ${line.productId}`);
      }
      if (product.stock < line.quantity) {
        throw new InsufficientStockError(line.productId, product.stock, line.quantity);
      }

      total += Number(product.price) * line.quantity;

      // 3. Decrement stock and record the line item
      await txDb
        .update<ProductRow, { id?: number }>('products')
        .values({ stock: product.stock - line.quantity })
        .filter({ id: line.productId })
        .execute();

      await txDb
        .insert<OrderItemRow>('order_items')
        .values({
          order_id: order.id,
          product_id: line.productId,
          quantity: line.quantity,
          unit_price: product.price,
        })
        .execute();
    }

    // 4. Finalize the total; any failure above rolls back everything
    await txDb
      .update<OrderRow, { id?: number }>('orders')
      .values({ total: total.toFixed(2) })
      .filter({ id: order.id })
      .execute();

    return order.id;
  });
}

try {
  const orderId = await placeOrder(42, [
    { productId: 7, quantity: 2 },
    { productId: 3, quantity: 1 },
  ]);
  console.log(`Order ${orderId} placed successfully`);
} catch (error) {
  if (error instanceof InsufficientStockError) {
    console.error(`Checkout rejected: ${error.message}`);
  } else {
    throw error;
  }
} finally {
  await db.disconnect();
}
```

Each builder chain compiles to parameterized SQL the named-parameter compiler can bind safely:

```typescript fragment
// insert<OrderRow>('orders').values({...}).returning(['id'])
// → INSERT INTO orders (user_id, status, total) VALUES (:user_id, :status, :total) RETURNING id

// update<ProductRow, ...>('products').values({ stock }).filter({ id })
// → UPDATE products SET stock = :v_stock WHERE id = :p1

// update<OrderRow, ...>('orders').values({ total }).filter({ id })
// → UPDATE orders SET total = :v_total WHERE id = :p1
```

### Why this pattern is valuable

- **Atomicity without manual bookkeeping.** `BEGIN`, `COMMIT`, `ROLLBACK`, and client release are handled for you; an exception anywhere in the flow — a failed query, a domain rule violation, a bug — removes every write, including the order row whose `id` was already returned to your code.
- **Consistency through client pinning.** All statements run on one client, so the `FOR UPDATE` lock taken by the SELECT is still held by the later UPDATE. This closes the oversell race that a read-then-write across pooled connections would leave open.
- **Fewer round trips.** `RETURNING` delivers generated ids and affected rows in the same statement, no follow-up SELECT needed.

### Caveats and performance notes

- **The instance is busy during a transaction.** `transactionClient` is pinned, so use only the `txDb` handle inside the callback, never fire concurrent queries on the same instance, and never start a nested `withTransaction()` — it would join the outer transaction's client unintentionally.
- **Keep transactions short.** Locks live until commit; long transactions block other writers. Do validation, HTTP calls, and computation outside the transaction and touch the database only for the unit of work itself.
- **Sort lock acquisition.** Acquiring row locks in a deterministic order (here: ascending product ids) prevents deadlock cycles between concurrent transactions.
- **A failed transaction does not poison the instance.** The client is always released in a `finally` block, and the original error is the one you see — a failing rollback is logged, not rethrown over it.

---

## Reusable Hook Pipelines

### When to use it

- The same normalization, hashing, or sanitization rules apply to **every** write of a table, and repeating them inline on each chain invites omissions.
- Outputs must be shielded — passwords and tokens removed, decimals parsed, dates formatted — before records reach application code.
- You want data-protection policy expressed as small, testable functions instead of scattered inline callbacks.

### The pattern

Compose hook factories into a per-resource policy, then let repository functions own the only chains that touch the table. `beforeQuery` transforms the parameter map (values only — keys are fixed by the statement), and `afterQuery` transforms the returned rows.

```typescript
import { createHash } from 'node:crypto';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

type ParamMap = Record<string, unknown>;
type ParamHook = (params: ParamMap) => ParamMap;
type RecordHook<T> = (records: T[]) => T[];

interface UserRow {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

interface NewUser {
  name: string;
  email: string;
  password_hash: string;
}

function composeParamHooks(...hooks: ParamHook[]): ParamHook {
  return (params) => hooks.reduce((current, hook) => hook(current), params);
}

// --- Reusable parameter hooks ----------------------------------------------

const trimStrings: ParamHook = (params) => {
  const next: ParamMap = {};
  for (const [key, value] of Object.entries(params)) {
    next[key] = typeof value === 'string' && !key.includes('password') ? value.trim() : value;
  }
  return next;
};

const canonicalizeEmail: ParamHook = (params) => {
  const next = { ...params };
  for (const key of ['email', 'v_email']) {
    const value = next[key];
    if (typeof value === 'string') {
      next[key] = value.toLowerCase();
    }
  }
  return next;
};

const digestPassword: ParamHook = (params) => {
  const next = { ...params };
  for (const key of ['password_hash', 'v_password_hash']) {
    const value = next[key];
    if (typeof value === 'string') {
      next[key] = createHash('sha256').update(value).digest('hex');
    }
  }
  return next;
};

// --- Reusable record hooks --------------------------------------------------

const shieldUserSecrets: RecordHook<UserRow> = (records) =>
  records.map((record) => {
    const safe = { ...record };
    delete safe.password_hash;
    return safe;
  });

// --- Repository functions: the only chains that touch the table -------------

const userWritePolicy = composeParamHooks(trimStrings, canonicalizeEmail, digestPassword);

async function createUser(db: PostgreSQLDatabase, values: NewUser): Promise<UserRow | null> {
  return db
    .insert<UserRow>('users')
    .values(values)
    .beforeQuery(userWritePolicy)
    .afterQuery(shieldUserSecrets)
    .returning('*')
    .executeReturnSingle();
}

async function renameUser(
  db: PostgreSQLDatabase,
  id: number,
  values: { name: string; email: string }
): Promise<UserRow | null> {
  return db
    .update<UserRow, { id?: number }>('users')
    .values(values)
    .filter({ id })
    .beforeQuery(userWritePolicy)
    .afterQuery(shieldUserSecrets)
    .returning('*')
    .executeReturnSingle();
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const created = await createUser(db, {
    name: '  Ada Lovelace  ',
    email: 'ADA@EXAMPLE.COM',
    password_hash: 'correct horse battery staple',
  });

  if (created?.id) {
    console.log(`Created ${created.name} <${created.email}>`);

    const renamed = await renameUser(db, created.id, {
      name: 'Ada Byron',
      email: 'ada.byron@EXAMPLE.COM',
    });

    if (renamed) {
      console.log(`Renamed to ${renamed.name} <${renamed.email}>`);
    }
  }
} finally {
  await db.disconnect();
}
```

The hook pipeline runs identically for INSERT and UPDATE, even though the parameter namespaces differ — that difference is absorbed once, in the hook factories:

```typescript fragment
// INSERT parameters (column names):
//   { name: '  Ada Lovelace  ', email: 'ADA@EXAMPLE.COM', password_hash: 'correct horse...' }
// → { name: 'Ada Lovelace', email: 'ada@example.com', password_hash: 'e3b0c442...' }

// UPDATE parameters (values are v_-prefixed, filters are p1…pN):
//   { v_name: 'Ada Byron', v_email: 'ada.byron@EXAMPLE.COM', p1: 1 }
// → { v_name: 'Ada Byron', v_email: 'ada.byron@example.com', p1: 1 }
```

Before this pattern, every call site re-implemented the policy inline — one omission leaks a plaintext secret or stores an unnormalized email:

```typescript fragment
// Before: policy duplicated at every call site
await db
  .insert<UserRow>('users')
  .values({ name, email, password_hash })
  .beforeQuery((params) => {
    const next = { ...params };
    if (typeof next.email === 'string') next.email = next.email.toLowerCase();
    return next; // ← hashing forgotten on this call site
  });

// After: one repository function owns the policy for the table
await createUser(db, { name: 'Ada Lovelace', email: 'ADA@EXAMPLE.COM', password_hash: 'secret' });
```

### Why this pattern is valuable

- **One choke point per resource.** Every write path flows through `userWritePolicy`; a new rule (audit timestamps, PII redaction) is added in one place and applies everywhere instantly.
- **Testable, pure functions.** Each hook is a plain `ParamMap → ParamMap` or `T[] → T[]` function that can be unit-tested without a database.
- **Safe-by-default reads.** `shieldUserSecrets` guarantees `password_hash` never leaves the repository layer, even if a caller forgets to project columns.

### Caveats and performance notes

- **Transform values, not keys.** Placeholders are generated from the keys you pass to `.values()` / `.filter()`; renaming or deleting a key inside a hook leaves its placeholder unbound and breaks compilation. Handle both `email` and `v_email` spellings instead of renaming.
- **Know what each operation passes.** INSERT: `{ ...columnNames }`. UPDATE: `v_`-prefixed values plus `p1…pN` filters. DELETE: only `p1…pN` filters. Write hooks that tolerate empty arrays for `afterQuery`.
- **Order matters in composition.** Here `trimStrings` runs before `canonicalizeEmail`, and `digestPassword` consumes the raw value last.
- **Errors propagate.** An exception inside a hook rejects the statement and rolls back an enclosing transaction — treat hooks as transactional code.
- **The digest is illustrative.** SHA-256 demonstrates the pipeline; use a dedicated password KDF (argon2, bcrypt, scrypt) for real credentials.
- **Hooks registered on a builder are per-statement.** Route all access through repository functions (or `executeQuery` options for raw SQL) so no call site bypasses the policy.

---

## Conditional Filters with the Expression API

### When to use it

- Filter criteria are **partially optional** — an operations console where "deactivate users inactive for N days, optionally including those who never logged in" arrives as a form payload.
- Predicates need **groups** — `status IN (...) OR expires_at < now`, or `last_login < cutoff OR last_login IS NULL`.
- Maintenance statements must stay parameterized; string-concatenated `WHERE` clauses are not acceptable.

### The pattern

Keep simple equality filters in `.filter()`, and switch to `.filterByExpression()` the moment conditions are optional or grouped. The callback receives the expression builder; build the predicate with reassignment so it works regardless of builder internals, and always include a guard clause that keeps the statement safe to rerun.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
  email_verified?: boolean;
  last_login?: Date | null;
}

interface UserFilter {
  id?: number;
  active?: boolean;
  email?: string;
  email_verified?: boolean;
  last_login?: Date;
}

interface SessionFilter {
  id?: number;
  status?: string;
  expires_at?: Date;
}

interface StaleAccountCriteria {
  inactiveSinceDays: number;
  includeNeverLoggedIn: boolean;
  onlyVerified: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

async function deactivateStaleAccounts(criteria: StaleAccountCriteria): Promise<UserRow[]> {
  const cutoff = new Date(Date.now() - criteria.inactiveSinceDays * 86_400_000);

  return db
    .update<UserRow, UserFilter>('users')
    .values({ active: false })
    .filterByExpression((q) => {
      // Guard clause: only touch rows that are still active (idempotent reruns)
      let condition = q.where('active').equals(true);

      if (criteria.includeNeverLoggedIn) {
        condition = condition.and((group) =>
          group.where('last_login').lessThan(cutoff).or('last_login').isNull()
        );
      } else {
        condition = condition.and('last_login').lessThan(cutoff);
      }

      if (criteria.onlyVerified) {
        condition = condition.and('email_verified').equals(true);
      }

      return condition;
    })
    .returning(['id', 'email', 'active'])
    .executeReturnAll();
}

async function purgeSessions(): Promise<number> {
  const now = new Date();

  return db
    .delete<SessionFilter>('sessions')
    .filterByExpression((q) =>
      q.where('status').in(['expired', 'revoked']).or('expires_at').lessThan(now)
    )
    .executeReturnCount();
}

try {
  const deactivated = await deactivateStaleAccounts({
    inactiveSinceDays: 90,
    includeNeverLoggedIn: true,
    onlyVerified: false,
  });
  console.log(`Deactivated ${deactivated.length} stale account(s)`);

  const purged = await purgeSessions();
  console.log(`Purged ${purged} session(s)`);
} finally {
  await db.disconnect();
}
```

For reads, compile a standalone expression from `blendsdk/expression` and pass it to the SELECT builder's `.byExpression()` — same predicate vocabulary, parameterized the same way:

```typescript
import { query } from 'blendsdk/expression';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const expression = query<UserRow>()
    .where('active')
    .equals(true)
    .and('email')
    .like('%example.com')
    .compile();

  const result = await db
    .from<UserRow>('users')
    .select(['id', 'name', 'email'])
    .byExpression(expression)
    .execute();

  const users = result?.records ?? [];
  for (const user of users) {
    console.log(`${user.id}: ${user.name} <${user.email}>`);
  }
  console.log(`Matched ${users.length} user(s)`);
} finally {
  await db.disconnect();
}
```

The difference from the anti-pattern is structural — values are always bound as parameters:

```typescript fragment
// Before: assembled SQL with interpolated values — injection-prone and untyped
let sql = 'UPDATE users SET active = false WHERE active = true';
if (inactiveSinceDays > 0) {
  sql += ` AND last_login < '${cutoff.toISOString()}'`; // value lives inside the SQL text
}

// After: the same predicate travels as bound parameters (p1, p2, …)
// UPDATE users SET active = :v_active
//  WHERE active = :p1 AND (last_login < :p2 OR last_login IS NULL)
```

### Why this pattern is valuable

- **Optional criteria without string building.** Each `if` adds a typed clause; nothing is concatenated, so `' OR 1=1 --` in a form field is just a value.
- **Groups and null semantics on demand.** `.and(group => group.where(...).or(...))` and `.isNull()` / `.isNotNull()` express exactly the SQL you mean, including the `NULL`-safe "never logged in" case that a plain comparison would silently miss.
- **Rerun safety.** The `active = true` guard makes the maintenance job idempotent: a second run reports zero affected rows instead of re-flipping rows already handled.
- **One vocabulary everywhere.** Write statements take a callback (`filterByExpression`); reads take a compiled expression (`byExpression`) — both compile to the same cached SQL fragment plus `p1…pN` parameters.

### Caveats and performance notes

- **Never run a maintenance statement without a guard or count check.** A callback that adds no clause — or `.filter({})` — produces an unconditioned `UPDATE`/`DELETE` touching every row. Combine guard clauses with `executeReturnCount()` / `executeReturnAll()` to confirm the blast radius.
- **Compile per request.** Expression values are captured when the expression is compiled; build it inside the function that handles the request, not in module scope.
- **Parameter names.** Exclusion and inclusion all use the same `p1…pN` namespace — never reference them by name in application code; treat them as opaque.
- **Index the predicate columns.** Maintenance jobs scan by `last_login`, `status`, or `expires_at`; keep those indexed so sweeps stay cheap on large tables.
- **Column and direction are not parameterizable.** Operators and identifiers are part of the query text; only values are bound.

---

## Idempotent Writes: Check-then-Act and Native Upserts

### When to use it

- Input can arrive **more than once** — webhook retries, at-least-once message delivery, double-clicked UI actions, replayed ETL batches.
- You need "create if absent, otherwise update" semantics keyed by an external identifier.
- Two implementations trade off differently: a portable check-then-act transaction, or PostgreSQL's native `INSERT … ON CONFLICT` for hot paths.

### The pattern

The correctness guarantee is a **unique constraint** on the natural key — the code merely decides whether to read first or let the database resolve the conflict. Both variants below can compose with other statements inside the same transaction.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface ProfileRow {
  id?: number;
  external_id: string;
  name: string;
  plan: string;
  synced_at?: Date;
}

interface ProfileInput {
  externalId: string;
  name: string;
  plan: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

// Variant A — check-then-act inside one transaction (portable, more round trips)
async function syncProfileTransactional(input: ProfileInput): Promise<number> {
  return db.withTransaction(async (txDb) => {
    const { records } = await txDb.executeQuery<{ id: number }>(
      'SELECT id FROM profiles WHERE external_id = :external_id',
      { external_id: input.externalId }
    );

    const existing = records[0];
    if (existing) {
      await txDb
        .update<ProfileRow, { id?: number }>('profiles')
        .values({ name: input.name, plan: input.plan, synced_at: new Date() })
        .filter({ id: existing.id })
        .execute();
      return existing.id;
    }

    const created = await txDb
      .insert<ProfileRow>('profiles')
      .values({
        external_id: input.externalId,
        name: input.name,
        plan: input.plan,
        synced_at: new Date(),
      })
      .returning(['id'])
      .executeReturnSingle();

    if (!created?.id) {
      throw new Error('Profile insert did not return an id');
    }
    return created.id;
  });
}

// Variant B — native upsert: one statement, race-safe by construction
async function syncProfileUpsert(input: ProfileInput): Promise<number> {
  const { records } = await db.executeQuery<{ id: number }>(
    `INSERT INTO profiles (external_id, name, plan, synced_at)
          VALUES (:external_id, :name, :plan, :synced_at)
     ON CONFLICT (external_id)
     DO UPDATE SET name = EXCLUDED.name,
                   plan = EXCLUDED.plan,
                   synced_at = EXCLUDED.synced_at
     RETURNING id`,
    {
      external_id: input.externalId,
      name: input.name,
      plan: input.plan,
      synced_at: new Date(),
    }
  );

  const upserted = records[0];
  if (!upserted) {
    throw new Error('Upsert returned no row');
  }
  return upserted.id;
}

try {
  const firstId = await syncProfileTransactional({
    externalId: 'acct_001',
    name: 'Acme',
    plan: 'pro',
  });

  const secondId = await syncProfileUpsert({
    externalId: 'acct_001',
    name: 'Acme Renamed',
    plan: 'enterprise',
  });

  console.log(firstId === secondId
    ? `Profile ${firstId} synced twice with identical identity`
    : 'Unexpected: duplicates were created');
} finally {
  await db.disconnect();
}
```

The unique constraint is the actual protection against duplicates — add it before relying on either variant:

```typescript fragment
// The natural key must be backed by a unique constraint:
// CREATE UNIQUE INDEX profiles_external_id_key ON profiles (external_id);
```

### Why this pattern is valuable

- **Retry-tolerant ingestion.** Deliveries can be replayed indefinitely; the natural key collapses them to one row. Variant A returns the same `id` on every replay because it finds the existing row; variant B returns the same `id` because the conflict path reuses it.
- **Two tools for one job.** Check-then-act composes naturally with additional reads and writes in the same transaction; the native upsert resolves the race in a single round trip with no window at all.
- **`EXCLUDED` eliminates duplication.** The proposed row's values are available in `DO UPDATE` without repeating the parameters or juggling aliases.

### Caveats and performance notes

- **The unique constraint is not optional.** Without it, concurrent check-then-act calls can both miss the SELECT and both INSERT, producing duplicates. With it, one of two racing transactions fails with a unique-violation (SQLSTATE `23505`) — catch it and retry once; the retry takes the update path against the committed row.
- **Under `READ COMMITTED`, the race window is real.** The transaction narrows it (the row is committed before the check completes in the common case), but only the constraint closes it. On hot paths prefer Variant B; the conflict is resolved inside the statement.
- **Wrap multi-step work, not single statements.** `syncProfileUpsert` is atomic on its own — don't pay for an explicit transaction unless you compose it with other statements (an audit insert, a builder chain); then run everything through `txDb`.
- **Validate `RETURNING` results.** A missing row where one is expected signals a schema or permission problem; throwing fails the unit of work cleanly instead of propagating `undefined`.
- **`ON CONFLICT` requires PostgreSQL 9.5+** and a unique index or constraint on the conflict target.

---

## Job Claiming with SKIP LOCKED

### When to use it

- Background workers must pull jobs from a table **without double-processing**, even when several replicas poll simultaneously.
- Crashed or stalled workers must be recovered without manual intervention.
- You want queue semantics without operating a separate broker — the queue lives in the same database, and job completion can join other transactions.

### The pattern

Combine three mechanisms: `FOR UPDATE SKIP LOCKED` to select a candidate without blocking other workers, a **guarded UPDATE** (`filter({ id, status: 'queued' })`) whose predicate makes the claim a compare-and-set, and a **stall sweeper** that returns jobs stuck in `running` past a visibility timeout.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface JobRow {
  id?: number;
  queue: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  worker_id?: string | null;
  started_at?: Date | null;
}

interface JobFilter {
  id?: number;
  queue?: string;
  status?: string;
  started_at?: Date;
}

interface ClaimedJob {
  id: number;
  payload: Record<string, unknown>;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

async function claimNextJob(queue: string, workerId: string): Promise<ClaimedJob | null> {
  return db.withTransaction(async (txDb) => {
    // SKIP LOCKED: workers never block each other and never see locked rows
    const { records } = await txDb.executeQuery<ClaimedJob>(
      `SELECT id, payload, attempts
         FROM jobs
        WHERE queue = :queue AND status = 'queued'
        ORDER BY id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      { queue }
    );

    const candidate = records[0];
    if (!candidate) {
      return null;
    }

    // Guarded update: only flips a still-queued row (compare-and-set)
    const claimed = await txDb
      .update<JobRow, JobFilter>('jobs')
      .values({
        status: 'running',
        worker_id: workerId,
        started_at: new Date(),
        attempts: candidate.attempts + 1,
      })
      .filter({ id: candidate.id, status: 'queued' })
      .returning(['id'])
      .executeReturnAll();

    return claimed.length === 1 ? { ...candidate, attempts: candidate.attempts + 1 } : null;
  });
}

async function completeJob(jobId: number): Promise<void> {
  await db
    .delete<JobFilter>('jobs')
    .filter({ id: jobId })
    .execute();
}

async function requeueStalledJobs(stallMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - stallMinutes * 60_000);

  const requeued = await db
    .update<JobRow, JobFilter>('jobs')
    .values({ status: 'queued', worker_id: null, started_at: null })
    .filterByExpression((q) =>
      q.where('status').equals('running').and('started_at').lessThan(cutoff)
    )
    .returning(['id'])
    .executeReturnAll();

  return requeued.length;
}

try {
  const workerId = `worker-${process.pid}`;
  let processed = 0;

  for (let index = 0; index < 5; index++) {
    const job = await claimNextJob('emails', workerId);
    if (!job) {
      break;
    }

    try {
      console.log(`Processing job ${job.id} on attempt ${job.attempts} — payload keys: ${Object.keys(job.payload).join(', ')}`);
      await completeJob(job.id);
      processed += 1;
    } catch (error) {
      const nextStatus = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
      await db
        .update<JobRow, JobFilter>('jobs')
        .values({ status: nextStatus, worker_id: null, started_at: null })
        .filter({ id: job.id })
        .execute();
      console.error(
        `Job ${job.id} failed on attempt ${job.attempts}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  const recovered = await requeueStalledJobs(15);
  console.log(`Processed ${processed} job(s); requeued ${recovered} stalled job(s)`);
} finally {
  await db.disconnect();
}
```

### Why this pattern is valuable

- **Horizontal scaling without coordination.** Any number of workers can poll concurrently; `SKIP LOCKED` makes each claim a non-blocking, exactly-once *selection*, and the guarded update makes it an exactly-once *claim*.
- **Short transactions, no long locks.** The claim transaction commits immediately after the status flip; job processing happens outside, so row locks never span the work itself — precisely the discipline `withTransaction` is designed for.
- **Crash recovery built in.** A worker that dies mid-job leaves a `running` row; `requeueStalledJobs` returns it to the queue after the visibility timeout, and the attempt counter drives a dead-letter transition after `MAX_ATTEMPTS`.
- **Everything stays parameterized.** Even the queue name and cutoff travel as named parameters.

### Caveats and performance notes

- **At-least-once semantics.** The visibility timeout must exceed the longest legitimate job duration, or a slow job gets requeued while still running. Design handlers to be idempotent (or dedupe on a payload key).
- **Keep the claim transaction minimal.** `FOR UPDATE` locks are held until commit; only the SELECT and the guarded UPDATE belong in it.
- **Index for the claim query.** A partial index such as `CREATE INDEX jobs_queued_idx ON jobs (queue, id) WHERE status = 'queued'` keeps polling cheap and lets finished jobs be pruned.
- **Ordering is FIFO by id.** Swap to a `priority` column if fairness requires it.
- **`SKIP LOCKED` requires PostgreSQL 9.5+.** Polling is the transport here; `LISTEN`/`NOTIFY` notification is a complementary optimization, not a replacement for the claim protocol.
- **Cap and surface retries.** Without the `failed` transition, poison messages cycle forever between `queued` and `running`.

---

## Report Queries with Result Shaping

### When to use it

- Dashboards and exports need server-side aggregation — `COUNT`, `SUM`, `AVG`, `GROUP BY` — that the single-table statement builders intentionally don't cover.
- Query inputs are dynamically chosen (date ranges, optional status filters) and must stay parameterized.
- The wire format from PostgreSQL (numerics as strings, timestamps as `Date`) needs normalizing before it reaches domain code.

### The pattern

Use `executeQuery` with named parameters for the aggregation, and attach the shaping logic as the `afterQuery` option so the function returns a domain-ready type instead of raw driver output.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

interface RevenueByDay {
  day: Date;
  order_count: number;
  gross_total: number;
  avg_order_value: number;
}

interface RevenueQueryParams {
  fromDay: Date;
  toDay: Date;
  status: string | null;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

async function revenueByDay(params: RevenueQueryParams): Promise<RevenueByDay[]> {
  const result: PostgreSQLQueryResult<RevenueByDay> = await db.executeQuery<RevenueByDay>(
    `SELECT date_trunc('day', placed_at) AS day,
            COUNT(*)::int                AS order_count,
            SUM(total)::numeric          AS gross_total,
            AVG(total)::numeric          AS avg_order_value
       FROM orders
      WHERE placed_at >= :from_day
        AND placed_at < :to_day
        AND (:status_filter::text IS NULL OR status = :status)
      GROUP BY 1
      ORDER BY 1`,
    {
      from_day: params.fromDay,
      to_day: params.toDay,
      status: params.status,
      status_filter: params.status,
    },
    {
      // PostgreSQL returns numeric aggregates as strings; convert at the boundary
      afterQuery: (records) =>
        records.map((record) => ({
          ...record,
          gross_total: Number(record.gross_total),
          avg_order_value: Number(record.avg_order_value),
        })),
    }
  );

  return result.records;
}

try {
  const report = await revenueByDay({
    fromDay: new Date('2024-01-01T00:00:00Z'),
    toDay: new Date('2024-02-01T00:00:00Z'),
    status: 'completed',
  });

  for (const row of report) {
    console.log(
      `${row.day.toISOString().slice(0, 10)}: ${row.order_count} orders, ` +
        `gross ${row.gross_total.toFixed(2)}, avg ${row.avg_order_value.toFixed(2)}`
    );
  }
} finally {
  await db.disconnect();
}
```

The `fields` metadata on the raw result is useful for diagnostics — verifying which columns a query actually produced, or driving dynamic export headers:

```typescript fragment
const result = await db.executeQuery('SELECT id, status, total FROM orders');
console.log(result.fields.map((field) => field.name)); // ['id', 'status', 'total']
```

### Why this pattern is valuable

- **The database does the heavy lifting.** A full month of revenue reduces to a handful of rows in one round trip; application code never streams raw orders.
- **Optional filters stay parameterized.** The `:status_filter::text IS NULL OR status = :status` technique switches a predicate on and off without touching the SQL text — no branching between two query strings.
- **Shaping lives at the boundary.** `afterQuery` converts driver representations (numeric strings) to domain types (`number`) in one place, so `revenueByDay` returns exactly `RevenueByDay[]` — callers never see `'125000.00'`.

### Caveats and performance notes

- **Numerics arrive as strings.** `numeric`/`decimal` columns and aggregates are string-encoded by the driver; convert in `afterQuery` (or cast to `float8` in SQL when precision loss is acceptable). `integer` casts (`::int`) come back as numbers directly.
- **`afterQuery` in `executeQuery` is skipped for empty result sets.** An empty report never invokes the hook — your mapping code can assume at least one row, but design the returned value to handle `[]` downstream.
- **Use the builders for CRUD, raw SQL for reporting.** `insert`/`update`/`delete`/`from` target single-table operations; joins, window functions, and `GROUP BY` belong in `executeQuery`.
- **Mind time zones.** `date_trunc` operates in the server session's `TimeZone`; pass explicit `from`/`to` instants (as shown) rather than relying on `now()` inside the query, and index the timestamp column being ranged over.
- **Heavy dashboards deserve more than indexes.** If a report runs constantly, consider a materialized view refreshed by a scheduled job — the shaping pattern applies to it unchanged.

---

## Service Lifecycle and Pool Management

### When to use it

- Any long-running service, worker fleet, or CLI that owns its `PostgreSQLDatabase` instance.
- Environments where pool exhaustion (`max` × replica count vs. server `max_connections`) or slow failure during outages is a concern.
- Processes that need deterministic shutdown — draining the pool instead of dropping connections.

### The pattern

Size the pool for the workload, **fail fast** at startup with a connectivity probe, and always close the pool on the way out. The complete example below is a standalone process that verifies connectivity, does a unit of work, and shuts down on every path, including crashes.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
  poolConfig: {
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  },
};

const db = new PostgreSQLDatabase(config);

async function run(): Promise<void> {
  // Fail fast: surface connectivity problems at startup, not mid-request
  await db.executeQuery('SELECT 1');

  const { records } = await db.executeQuery<{ now: Date }>('SELECT now() AS now');
  console.log(`Worker ${process.pid} connected at ${records[0].now.toISOString()}`);

  const tables = await db.executeQuery<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name`
  );
  console.log(`Visible public tables: ${tables.rowCount}`);
}

try {
  await run();
} catch (error) {
  console.error('Startup check failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // Deterministic shutdown, even on the crash path
  await db.disconnect();
  console.log('Pool closed');
}
```

Once `disconnect()` has been called, the shutdown guard rejects all new work — useful to know when racing a shutdown against in-flight requests:

```typescript fragment
await db.disconnect();

await db.executeQuery('SELECT 1');
// → rejects: "Cannot execute query: database is shutting down"

await db.withTransaction(async () => true);
// → rejects: "Cannot start transaction: database is shutting down"
```

For standalone processes, signal handling can be delegated to the adapter — but **never** when a framework owns the process lifecycle:

```typescript fragment
// Standalone only. Do NOT combine with blendsdk/webafx: the WebApplication has its own
// SIGTERM/SIGINT handling, and duplicate handlers cause unpredictable shutdown behavior.
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'app',
  pass: 'secret',
  enableGracefulShutdown: true, // registers SIGINT/SIGTERM → disconnect() → process.exit()
});
```

Pool sizing is a per-process decision that adds up across replicas — plan it against the server budget:

| Workload | Suggested `poolConfig` | Rationale |
| --- | --- | --- |
| HTTP API (per instance) | `{ max: 10, connectionTimeoutMillis: 5000 }` | Bounded concurrency, fail fast during outages; instances × max must fit `max_connections` with headroom |
| Worker fleet (per replica) | `{ max: 4, idleTimeoutMillis: 30000 }` | Workers are mostly sequential; many replicas multiply the pool — keep each small |
| CLI / one-off scripts | `{ max: 1 }` | No concurrency; always call `disconnect()` in a `finally` block |

### Why this pattern is valuable

- **Fail fast beats fail weird.** A `SELECT 1` probe at startup surfaces misconfiguration at deploy time; without it, the first failure appears on a user request. A positive `connectionTimeoutMillis` prevents hangs when the server is unreachable.
- **Deterministic shutdown.** `disconnect(timeoutMs)` first blocks new work via the `isShuttingDown` guard, then races `pool.end()` against a timer — drains gracefully when possible, force-releases clients as a last resort, and always settles.
- **Coexistence with the framework.** When the database is managed by a `WebApplication` from `blendsdk/webafx`, shutdown flows through the framework: create the adapter, leave `enableGracefulShutdown` off, and call `disconnect()` from the application's shutdown hook. ⚠️ Enabling both signal handler sets causes conflicts and unpredictable shutdown behavior.

### Caveats and performance notes

- **`max` is per process.** Total connections = replicas × `max`. A fleet of 20 workers with `max: 10` asks for 200 connections before any HTTP tier is counted.
- **The default `connectionTimeoutMillis` is `0`** (wait forever). Services should always set a positive value so a dead server produces errors, not hangs.
- **The disconnect timeout has a hard floor.** If `pool.end()` does not finish within `timeoutMs` (default 10 000 ms), remaining clients are force-released — potentially interrupting active queries. Keep the timeout above your longest expected query.
- **Disconnect is terminal.** `isShuttingDown` is never reset; to reconnect, create a new `PostgreSQLDatabase` instance.
- **`disconnect()` is safe on an idle instance.** Calling it on a database that never ran a query resolves cleanly — handy in error paths where startup failed early.

---

## Composing the Patterns

In a real service these patterns stack rather than compete:

- **Repository layer** — hook pipelines (Pattern 2) own every builder chain; call sites see domain functions, never statements.
- **Service layer** — multi-step operations wrap in `withTransaction` (Pattern 1); idempotent ingestion uses the unique-constraint discipline (Pattern 4).
- **Background jobs** — workers claim via `SKIP LOCKED` + guarded updates (Pattern 5); maintenance sweeps use guarded expression filters with count checks (Pattern 3).
- **Read side** — typed projections and compiled expressions (Pattern 3) for CRUD reads; raw `executeQuery` with result shaping (Pattern 6) for reporting.
- **Edges** — pool sizing and shutdown live at the process boundary (Pattern 7); under `blendsdk/webafx`, expose `disconnect()` through the framework's lifecycle instead of enabling signal handlers.

Each pattern is independently useful; together they cover the full lifecycle of a PostgreSQL-backed BlendSDK service — from pool configuration and parameterized writes to transactional workflows, guarded maintenance, and deterministic shutdown.

---

# postgresql Common Scenarios

A task-oriented collection of "how do I…" answers for `blendsdk/postgresql`, each with a complete, runnable TypeScript example. The scenarios are ordered from basic connectivity through everyday data operations to configuration, lifecycle management, and troubleshooting. For a feature tour see the Overview; for the concepts behind these recipes see Core Concepts.

The examples use the same illustrative schema:

```sql
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  age           INTEGER,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE sessions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Scenarios in this document:**

- [How do I connect to a PostgreSQL database and run my first query?](#how-do-i-connect-to-a-postgresql-database-and-run-my-first-query)
- [How do I execute a query with parameters safely?](#how-do-i-execute-a-query-with-parameters-safely)
- [How do I run multiple statements atomically in a transaction?](#how-do-i-run-multiple-statements-atomically-in-a-transaction)
- [How do I insert a row and get the generated record back?](#how-do-i-insert-a-row-and-get-the-generated-record-back)
- [How do I update specific rows and read the updated values?](#how-do-i-update-specific-rows-and-read-the-updated-values)
- [How do I delete rows and return the deleted data?](#how-do-i-delete-rows-and-return-the-deleted-data)
- [How do I select specific columns and rename them with aliases?](#how-do-i-select-specific-columns-and-rename-them-with-aliases)
- [How do I build complex WHERE conditions?](#how-do-i-build-complex-where-conditions)
- [How do I transform parameter values before a query runs?](#how-do-i-transform-parameter-values-before-a-query-runs)
- [How do I strip or reshape fields in query results?](#how-do-i-strip-or-reshape-fields-in-query-results)
- [How do I handle queries that match no rows?](#how-do-i-handle-queries-that-match-no-rows)
- [How do I update or delete every row in a table?](#how-do-i-update-or-delete-every-row-in-a-table)
- [How do I configure the connection pool?](#how-do-i-configure-the-connection-pool)
- [How do I shut the database down cleanly?](#how-do-i-shut-the-database-down-cleanly)
- [How do I fix the "no values provided" error?](#how-do-i-fix-the-no-values-provided-error)

---

## How do I connect to a PostgreSQL database and run my first query?

Create one `PostgreSQLDatabase` instance per database, configured with a `PostgreSQLConfig`. The constructor is lazy — it builds a connection pool that connects on demand — so it never throws for an unreachable server (the first query rejects instead, and `disconnect()` still resolves cleanly). A single instance is safe to share across your application: concurrent queries run on separate pooled connections.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const { records, rowCount } = await db.executeQuery<{ version: string }>(
    'SELECT version() AS version'
  );

  console.log(`Connected — server version: ${records[0].version} (${rowCount} row)`);
} finally {
  await db.disconnect();
}
```

Two details worth knowing up front:

- A `port` provided as a string (`port: '5432'`) is accepted and coerced with `Number()` during construction.
- Connection failures surface on the first query, not at construction — and a failed connect does not break shutdown:

```typescript fragment
const db = new PostgreSQLDatabase({ ...config, host: 'invalid-host', port: 9999 });

await db.executeQuery('SELECT 1'); // rejects — the pool connects lazily on first use
await db.disconnect();             // still resolves cleanly
```

---

## How do I execute a query with parameters safely?

Write SQL with `:name` placeholders and pass a parameter object to `executeQuery()`. The `yesql` compiler turns each placeholder into a positional parameter sent to PostgreSQL separately from the SQL text, so values are never interpolated into the statement — malicious input is treated as a literal. The generic type parameter describes the returned rows, and the result also carries `rowCount` and column `fields` metadata.

```typescript
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLQueryResult,
} from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
  active: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const result: PostgreSQLQueryResult<UserRow> = await db.executeQuery<UserRow>(
    `SELECT id, name, active
       FROM users
      WHERE name = :name AND active = :active`,
    { name: "O'Reilly", active: true }
  );

  for (const user of result.records) {
    console.log(user.id, user.name);
  }

  console.log(`rows: ${result.rowCount}`);
  console.log(`columns: ${result.fields.map((field) => field.name).join(', ')}`);
} finally {
  await db.disconnect();
}
```

Parameterization is what makes injection attempts harmless — the malicious string below becomes a parameter value, not SQL:

```typescript fragment
const maliciousInput = "'; DROP TABLE users; --";

const { records, rowCount } = await db.executeQuery<UserRow>(
  'SELECT id, name FROM users WHERE name = :name',
  { name: maliciousInput }
);
// rowCount: 0 — the string is treated as a literal value; the table is untouched
```

Add an explicit cast when PostgreSQL must know a parameter's type — for example with `jsonb`, arrays, or timestamps:

```typescript fragment
const { records } = await db.executeQuery<{ json_val: { theme: string } }>(
  `SELECT :json_val::jsonb AS json_val`,
  { json_val: { theme: 'dark' } }
);
```

Statements without placeholders — including DDL — are executed the same way; just omit the parameter object:

```typescript fragment
await db.executeQuery(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id      BIGSERIAL PRIMARY KEY,
    message TEXT NOT NULL
  )
`);
```

---

## How do I run multiple statements atomically in a transaction?

Wrap the unit of work in `db.withTransaction(async (txDb) => { ... })`: the adapter issues `BEGIN`, runs your callback on a single pinned client, then `COMMIT`s on success or `ROLLBACK`s when the callback throws — rethrowing the original error and always returning the client to the pool. Execute every statement through the callback's `txDb` argument so it participates in the transaction, and do not start a nested `withTransaction()` inside the callback.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  // Committed: both statements succeed or neither is applied
  const created = await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(
      'INSERT INTO users (name, email) VALUES (:name, :email)',
      { name: 'Ada Lovelace', email: 'ada@example.com' }
    );

    const { records } = await txDb.executeQuery<UserRow>(
      'SELECT id, name, email FROM users WHERE email = :email',
      { email: 'ada@example.com' }
    );

    return records[0];
  });

  console.log(`Committed user ${created.id}: ${created.name}`);

  // Rolled back: throwing inside the callback undoes every statement in it
  try {
    await db.withTransaction(async (txDb) => {
      await txDb.executeQuery(
        'INSERT INTO users (name, email) VALUES (:name, :email)',
        { name: 'Grace Hopper', email: 'grace@example.com' }
      );

      throw new Error('something went wrong after the insert');
    });
  } catch (error) {
    console.error('Rolled back:', error instanceof Error ? error.message : error);
  }
} finally {
  await db.disconnect();
}
```

Any rejection inside the callback also triggers the rollback — a constraint violation, a failed business rule you raise with `throw`, or a query error. After a rolled-back transaction, the instance is immediately usable again.

---

## How do I insert a row and get the generated record back?

Build the INSERT with `db.insert<T>(table).values({ ... })`, add `.returning('*')` (or a column list), and finish with `executeReturnSingle()` to receive the stored row — including server-generated values such as `id` and `created_at`. Each key in the values object becomes a column and a `:key` placeholder; when only the row count matters, omit `RETURNING` and use `executeReturnCount()`.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  age?: number;
  created_at?: Date;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const created = await db
    .insert<UserRow>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com', age: 36 })
    .returning('*')
    .executeReturnSingle();

  if (created) {
    console.log(
      `Created user ${created.id}: ${created.name} at ${created.created_at?.toISOString()}`
    );
  }

  const insertedCount = await db
    .insert<UserRow>('users')
    .values({ name: 'Alan Turing', email: 'alan@example.com' })
    .executeReturnCount();

  console.log(`Inserted ${insertedCount} user(s)`);
} finally {
  await db.disconnect();
}
```

Request only the columns you need — `executeReturnSingle()` then resolves with a record shaped by the `RETURNING` list:

```typescript fragment
const minimal = await db
  .insert<UserRow>('users')
  .values({ name: 'Grace Hopper', email: 'grace@example.com' })
  .returning(['id', 'name'])
  .executeReturnSingle();
// minimal: { id, name } | null
```

The builder validates itself: executing without calling `.values()` — or calling it with an empty object — throws a descriptive error instead of emitting invalid SQL (see [How do I fix the "no values provided" error?](#how-do-i-fix-the-no-values-provided-error)).

---

## How do I update specific rows and read the updated values?

Use `db.update<T, F>(table)` with `.values()` for the `SET` clause and `.filter()` for the `WHERE` clause, and chain `.returning()` to read the updated rows back. SET values and filter values live in separate parameter namespaces — values are named `v_<column>`, filters `p1…pN` — so updating and filtering on the same column never collides.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

interface UserFilter {
  email?: string;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const deactivated = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: false })
    .filter({ email: 'ada@example.com' })
    .returning(['id', 'email', 'active'])
    .executeReturnSingle();

  if (deactivated) {
    console.log(`Deactivated ${deactivated.email} (id ${deactivated.id})`);
  }

  const affected = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: true })
    .filter({ active: false })
    .executeReturnCount();

  console.log(`Reactivated ${affected} user(s)`);
} finally {
  await db.disconnect();
}
```

The two parameter namespaces in action:

```typescript fragment
const statement = db
  .update<UserRow, UserFilter>('users')
  .values({ active: true })
  .filter({ active: false });
// SQL:    UPDATE users SET active = :v_active WHERE active = :p1
// Params: { v_active: true, p1: false }
```

Omitting `.filter()` — or passing an empty object — updates every row; see [How do I update or delete every row in a table?](#how-do-i-update-or-delete-every-row-in-a-table).

---

## How do I delete rows and return the deleted data?

Build the statement with `db.delete<F>(table)`, narrow it with `.filter()`, and add `.returning()` to read the deleted rows. `executeReturnAll()` resolves with every deleted row, `executeReturnSingle()` with the first one (or `null`), and `executeReturnCount()` with just the number of rows removed.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  user_id?: number;
  status?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const removedForUser = await db
    .delete<SessionFilter>('sessions')
    .filter({ user_id: 42 })
    .returning(['user_id', 'status'])
    .executeReturnAll();

  console.log(`Removed ${removedForUser.length} session(s) for user 42`);
  for (const session of removedForUser) {
    console.log(`- ${session.user_id}: ${session.status}`);
  }

  const expiredCount = await db
    .delete<SessionFilter>('sessions')
    .filter({ status: 'expired' })
    .executeReturnCount();

  console.log(`Removed ${expiredCount} expired session(s)`);
} finally {
  await db.disconnect();
}
```

Check whether anything matched before acting on the result:

```typescript fragment
const deleted = await db
  .delete<SessionFilter>('sessions')
  .filter({ user_id: 42 })
  .returning('*')
  .executeReturnSingle();

if (deleted === null) {
  console.log('No session matched — nothing was deleted');
}
```

---

## How do I select specific columns and rename them with aliases?

`db.from<T>(table)` returns a SELECT builder: `.select()` produces `SELECT *`, `.select(['id', 'name'])` fetches an explicit column list, and `.select({ alias: 'expression' })` renames columns or defines computed expressions. Finish with `.execute()`; `db.selectAll(table)` is shorthand for `SELECT *`.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  age?: number;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  // SELECT * FROM users
  const all = await db.from<UserRow>('users').select().execute();
  console.log(`all users: ${all?.rowCount ?? 0}`);

  // SELECT id, name FROM users — only these columns are fetched
  const partial = await db.from<UserRow>('users').select(['id', 'name']).execute();
  console.log(`partial: ${partial?.rowCount ?? 0}`);

  // SELECT id AS user_id, name || ' <' || email || '>' AS display FROM users
  const aliased = await db
    .from<UserRow>('users')
    .select({
      user_id: 'id',
      display: "name || ' <' || email || '>'",
    })
    .execute();

  for (const row of aliased?.records ?? []) {
    console.log(row);
  }
} finally {
  await db.disconnect();
}
```

A few behaviors worth knowing:

- The last `.select()` call wins — chaining replaces the column list rather than appending to it.
- Alias expressions are passed through to SQL as-is, so any valid PostgreSQL expression — `COUNT(*)`, `CASE WHEN … END`, `settings->>'theme'` — can be aliased.

```typescript fragment
// Shorthand for "SELECT * FROM users"
const result = await db.selectAll('users').execute();
```

---

## How do I build complex WHERE conditions?

`.filter({ ... })` compiles simple equality conditions joined with `AND`. For anything richer — `IN` lists, `LIKE` patterns, `BETWEEN` ranges, `IS NULL` checks, or grouped `AND`/`OR` logic — use `.filterByExpression((q) => ...)` on UPDATE and DELETE builders, or compile an expression with the SDK's expression package and pass it to `.byExpression()` on SELECT builders. The compiled condition and its parameters are cached per statement, so query text and parameters are produced from a single compilation.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  age?: number;
  active?: boolean;
}

interface UserFilter {
  name?: string;
  email?: string;
  age?: number;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  // WHERE age > 65 AND active = true
  const deactivated = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: false })
    .filterByExpression((q) => q.where('age').greaterThan(65).and('active').equals(true))
    .executeReturnCount();

  console.log(`Deactivated ${deactivated} senior user(s)`);

  // WHERE email LIKE '%@stale.example.com'
  const removed = await db
    .delete<UserFilter>('users')
    .filterByExpression((q) => q.where('email').like('%@stale.example.com'))
    .executeReturnCount();

  console.log(`Removed ${removed} decommissioned account(s)`);
} finally {
  await db.disconnect();
}
```

Conditions chain with `.and()` / `.or()`; pass a callback to group nested logic, which compiles to parenthesized SQL:

```typescript fragment
// Groups compile to: active = true AND (age > 65 OR name LIKE '%Smith%')
await db
  .update<UserRow, UserFilter>('users')
  .values({ active: false })
  .filterByExpression((q) =>
    q
      .where('active')
      .equals(true)
      .and((nested) => nested.where('age').greaterThan(65).or('name').like('%Smith%'))
  )
  .execute();
```

Expression builders support the following operators:

| Condition | Expression call |
| --- | --- |
| Equality | `.where('status').equals('active')` |
| Greater than / less than | `.where('age').greaterThan(18)` · `.where('age').lessThan(65)` |
| Inclusive range | `.where('age').between(18, 65)` |
| Membership | `.where('status').in(['active', 'pending'])` |
| Pattern match | `.where('email').like('%@example.com')` |
| Null checks | `.where('deleted_at').isNull()` · `.where('deleted_at').isNotNull()` |
| Combine / group | `.and(…)` · `.or(…)` — pass a callback to group nested conditions |

SELECT statements receive a compiled expression from `query()` in `blendsdk/expression` through `.byExpression()`:

```typescript fragment
import { query } from 'blendsdk/expression';

const expression = query<UserRow>()
  .where('active')
  .equals(true)
  .and((q) => q.where('age').greaterThan(18).or('age').lessThan(65))
  .compile();

const result = await db
  .from<UserRow>('users')
  .select(['id', 'name', 'age'])
  .byExpression(expression)
  .execute();
```

---

## How do I transform parameter values before a query runs?

Register a builder `.beforeQuery((params) => ...)` hook to transform the parameter map right before the SQL is compiled — normalizing inputs, hashing secrets, or adapting values to database formats. The hook receives the full parameter map and returns the map the compiler will use; the same transform is available per call as the `beforeQuery` option of `executeQuery()`.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const created = await db
    .insert<UserRow>('users')
    .values({
      name: 'Grace Hopper',
      email: 'GRACE@EXAMPLE.COM',
      password_hash: 'plain-secret',
    })
    .beforeQuery((params) => {
      const transformed = { ...params };
      if (typeof transformed.email === 'string') {
        transformed.email = transformed.email.toLowerCase();
      }
      if (typeof transformed.password_hash === 'string') {
        transformed.password_hash = `hash(${transformed.password_hash})`;
      }
      return transformed;
    })
    .returning(['id', 'email'])
    .executeReturnSingle();

  if (created) {
    console.log(`Stored ${created.email}`); // grace@example.com
  }
} finally {
  await db.disconnect();
}
```

On INSERT, parameter keys are column names. On UPDATE, SET values are `v_`-prefixed and filter values show up as `p1`, `p2`, …:

```typescript fragment
interface UserFilter {
  email?: string;
}

await db
  .update<UserRow, UserFilter>('users')
  .values({ password_hash: 'new-secret' })
  .filter({ email: 'ADA@EXAMPLE.COM' })
  .beforeQuery((params) => {
    const transformed = { ...params };
    if (typeof transformed.v_password_hash === 'string') {
      transformed.v_password_hash = `hash(${transformed.v_password_hash})`;
    }
    if (typeof transformed.p1 === 'string') {
      transformed.p1 = transformed.p1.toLowerCase();
    }
    return transformed;
  })
  .execute();
```

The per-call variant on `executeQuery()`:

```typescript fragment
await db.executeQuery(
  'SELECT id, name FROM users WHERE email = :email',
  { email: 'ADA@EXAMPLE.COM' },
  {
    beforeQuery: (params) => {
      const transformed = { ...params };
      if (typeof transformed.email === 'string') {
        transformed.email = transformed.email.toLowerCase();
      }
      return transformed;
    },
  }
);
```

Hooks run at execution time — a hook that throws rejects the operation (and rolls back the surrounding transaction) exactly like a query error.

---

## How do I strip or reshape fields in query results?

Register a builder `.afterQuery((records) => ...)` hook to transform rows after execution and before they reach your code — removing sensitive fields, converting representations, or adding computed properties. The hook receives the row array and returns the array to use; with `executeQuery()`, it runs only when the query returned at least one row.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const created = await db
    .insert<UserRow>('users')
    .values({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password_hash: 'hash(secret)',
    })
    .afterQuery((records) =>
      records.map((record) => {
        const safe = { ...record };
        delete safe.password_hash;
        return safe;
      })
    )
    .returning('*')
    .executeReturnSingle();

  if (created) {
    console.log(`Created ${created.name} — password hash hidden by the hook`);
    console.log(created.password_hash); // undefined — removed before leaving the hook
  }
} finally {
  await db.disconnect();
}
```

The same transform as a per-call option of `executeQuery()`:

```typescript fragment
const result = await db.executeQuery<UserRow>(
  'SELECT id, name, email, password_hash FROM users WHERE email = :email',
  { email: 'ada@example.com' },
  {
    afterQuery: (records) =>
      records.map((record) => {
        const safe = { ...record };
        delete safe.password_hash;
        return safe;
      }),
  }
);
```

On builders, the hook runs whenever rows are extracted by `executeReturnSingle()`, `executeReturnAll()`, or the underlying `execute()`. The two hooks compose — combine `beforeQuery` (normalize and hash on the way in) with `afterQuery` (mask on the way out) on the same statement.

---

## How do I handle queries that match no rows?

The statement terminators have well-defined empty behavior: `executeReturnSingle()` resolves with `null`, `executeReturnAll()` with an empty array, `executeReturnCount()` with `0`, and `executeQuery()` with an empty `records` array and `rowCount: 0`. Check these values instead of assuming a row exists.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

interface UserFilter {
  email?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  // executeReturnSingle() → null when no row matches
  const missing = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: false })
    .filter({ email: 'nobody@example.com' })
    .returning('*')
    .executeReturnSingle();

  console.log(`updated row: ${missing === null ? 'none' : missing.email}`);

  // executeReturnAll() → [] when no row matches
  const removed = await db
    .delete<UserFilter>('users')
    .filter({ email: 'nobody@example.com' })
    .returning('*')
    .executeReturnAll();

  console.log(`deleted rows: ${removed.length}`); // 0

  // executeReturnCount() → 0 when no row matches
  const deletedCount = await db
    .delete<UserFilter>('users')
    .filter({ email: 'nobody@example.com' })
    .executeReturnCount();

  console.log(`deleted count: ${deletedCount}`); // 0

  // executeQuery() → { records: [], rowCount: 0, fields: [] }
  const { records, rowCount } = await db.executeQuery<UserRow>(
    'SELECT * FROM users WHERE email = :email',
    { email: 'nobody@example.com' }
  );

  console.log(`query rows: ${rowCount}, records: ${records.length}`); // 0, 0
} finally {
  await db.disconnect();
}
```

A failed match is not an error — nothing is rejected and nothing is rolled back. `executeReturnSingle()` returning `null` simply means "no row matched your filter".

---

## How do I update or delete every row in a table?

Omit `.filter()` entirely — or pass an empty object — and the statement has no `WHERE` clause, so it affects every row (`UPDATE users SET active = :v_active`, `DELETE FROM sessions`). This is intentional bulk behavior: there is no implicit scoping, so always confirm that a missing filter is really what you mean.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

interface UserFilter {
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  // UPDATE users SET active = :v_active — no WHERE clause
  const affected = await db
    .update<UserRow, UserFilter>('users')
    .values({ active: false })
    .executeReturnCount();

  console.log(`Deactivated ${affected} user(s)`);

  // DELETE FROM sessions — empty filter, no WHERE clause
  const removed = await db.delete<{}>('sessions').filter({}).executeReturnCount();

  console.log(`Deleted ${removed} session(s)`);
} finally {
  await db.disconnect();
}
```

The generated SQL makes the difference explicit:

```typescript fragment
await db.update<UserRow, UserFilter>('users').values({ active: false }).execute();
// → UPDATE users SET active = :v_active              (no WHERE — all rows)

await db.delete<{}>('sessions').filter({}).execute();
// → DELETE FROM sessions                             (no WHERE — all rows)
```

Use `.returning()` with `executeReturnAll()` if you want to audit which rows a bulk operation affected:

```typescript fragment
const deleted = await db.delete<{}>('sessions').filter({}).returning('*').executeReturnAll();
// deleted: every removed row — useful for audit logging before a bulk delete
```

---

## How do I configure the connection pool?

Pass a `poolConfig` object inside `PostgreSQLConfig`; its values are forwarded to the underlying `pg.Pool`. Omitted properties keep the driver defaults (`max: 10`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 0`), and omitting `poolConfig` entirely is fully supported.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  poolConfig: {
    max: 20,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 5000,
  },
};

const db = new PostgreSQLDatabase(config);

try {
  const { rowCount } = await db.executeQuery('SELECT 1');
  console.log(`Query executed on a pooled connection (${rowCount} row)`);
} finally {
  await db.disconnect();
}
```

Pool options and their driver defaults:

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `max?` | `number` | `10` | Maximum number of clients the pool keeps open |
| `idleTimeoutMillis?` | `number` | `30000` | Milliseconds an idle client waits before being closed |
| `connectionTimeoutMillis?` | `number` | `0` (no timeout) | Milliseconds to wait for a new client before failing |

Partial configuration is fine — every property is optional:

```typescript fragment
const db = new PostgreSQLDatabase({
  host: 'localhost',
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  poolConfig: { max: 15 }, // idleTimeoutMillis and connectionTimeoutMillis keep their defaults
});
```

Size `max` to cover your peak concurrent queries against this instance; a small `connectionTimeoutMillis` makes requests fail fast instead of queueing indefinitely under saturation.

---

## How do I shut the database down cleanly?

Call `await db.disconnect(timeoutMs?)` before the process exits: it rejects new work (queries with `Cannot execute query: database is shutting down`, transactions with `Cannot start transaction: database is shutting down`), then ends the pool — force-releasing any remaining clients if the timeout (default 10 000 ms) expires, so the call still resolves. It is safe even if no connection was ever used.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

await db.executeQuery('SELECT 1');

// Graceful shutdown with a 5-second ceiling; forced client release afterwards if needed
await db.disconnect(5000);
console.log('Pool closed');

// Once shutdown starts, new work is rejected
try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message); // "Cannot execute query: database is shutting down"
  }
}

try {
  await db.withTransaction(async (txDb) => txDb.executeQuery('SELECT 1'));
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message); // "Cannot start transaction: database is shutting down"
  }
}
```

For standalone processes — services not managed by a framework — you can let the adapter handle signals itself:

```typescript fragment
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  enableGracefulShutdown: true, // registers SIGINT/SIGTERM handlers that disconnect() and exit
});
```

⚠️ **Warning:** do NOT enable `enableGracefulShutdown` when the database is managed by a `WebApplication` from `blendsdk/webafx` — the framework registers its own SIGINT/SIGTERM handling, and two sets of signal handlers conflict and produce unpredictable shutdown behavior. Only enable it for standalone usage outside the web framework.

---

## How do I fix the "no values provided" error?

The INSERT and UPDATE builders refuse to create invalid SQL: executing without calling `.values()`, or calling it with an empty object, throws `Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.` Guard before building — when the change set is empty, skip the statement entirely.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

interface UserUpdate {
  name?: string;
  email?: string;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

async function applyUpdate(id: number, changes: UserUpdate): Promise<number> {
  if (Object.keys(changes).length === 0) {
    return 0; // Nothing to change — do not build the statement at all
  }

  return db
    .update<UserRow, { id: number }>('users')
    .values(changes)
    .filter({ id })
    .executeReturnCount();
}

try {
  const updated = await applyUpdate(1, { active: false });
  console.log(`Updated ${updated} row(s)`);

  // Building with no values throws a descriptive error, not invalid SQL
  try {
    await db.update<UserRow, { id: number }>('users').values({}).filter({ id: 1 }).execute();
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      // Cannot build UPDATE statement for table "users": no values provided.
      // Call .values() with at least one column before executing.
    }
  }
} finally {
  await db.disconnect();
}
```

Notes:

- The error is raised when the statement is executed (the query string is generated then), not when `.values({})` is called.
- The DELETE builder has no such requirement — it never needs columns to set.
- `null` is a valid value for a column (`values({ notes: null })`); only an empty values object is rejected.

---

# postgresql Examples Library

This library collects copy-paste ready examples for every feature area of `blendsdk/postgresql`, modeled on the package's own integration tests. Each example is complete and self-contained: it includes all imports, a full `PostgreSQLConfig` for a local server, and its own setup. Examples that need tables create `TEMP` tables inside a transaction, so they run as-is without leaving schema or data behind.

**Categories**

- [Connection and Configuration](#connection-and-configuration)
- [Query Execution](#query-execution)
- [Transactions](#transactions)
- [INSERT Statement Builder](#insert-statement-builder)
- [UPDATE Statement Builder](#update-statement-builder)
- [DELETE Statement Builder](#delete-statement-builder)
- [SELECT Queries with FromStatement](#select-queries-with-fromstatement)
- [Query Hooks](#query-hooks)
- [Error Handling](#error-handling)

---

## Connection and Configuration

Creating the adapter, tuning the pool, and controlling the connection lifecycle.

### Creating a Database Instance and Running a Query

Constructing `PostgreSQLDatabase` builds the connection pool but does not open a connection — the first query acquires a client on demand, and `disconnect()` in a `finally` block guarantees the pool is closed.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const { records, rowCount } = await db.executeQuery<{ greeting: string; server_time: Date }>(
    'SELECT :name AS greeting, now() AS server_time',
    { name: 'world' }
  );

  console.log(`${records[0].greeting} — server time ${records[0].server_time.toISOString()}`);
  console.log(`rowCount: ${rowCount}`);
} finally {
  await db.disconnect();
}

// → world — server time 2024-05-14T09:30:00.000Z
// → rowCount: 1
```

### Tuning the Connection Pool

Pass a `poolConfig` to override the driver defaults: `max` (default 10), `idleTimeoutMillis` (default 30 000), and `connectionTimeoutMillis` (default 0 — no connect timeout).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  poolConfig: {
    max: 20, // at most 20 clients in the pool
    idleTimeoutMillis: 60000, // retire idle clients after 60 seconds
    connectionTimeoutMillis: 5000, // fail fast if a client cannot connect within 5 seconds
  },
};

const db = new PostgreSQLDatabase(config);

try {
  // Concurrent queries draw from the pool up to the configured maximum
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      db.executeQuery<{ num: string }>('SELECT :num AS num', { num: index })
    )
  );

  console.log(results.map((result) => result.records[0].num).join(', '));
  // → 0, 1, 2, 3, 4, 5, 6, 7, 8, 9
} finally {
  await db.disconnect();
}
```

### Graceful Shutdown for Standalone Processes

Setting `enableGracefulShutdown: true` registers `SIGINT`/`SIGTERM` handlers that disconnect the database and exit the process — no explicit `disconnect()` call is needed.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

/**
 * ⚠️ Standalone processes only. Do NOT enable this when the database is
 * managed by a WebApplication from blendsdk/webafx, which registers its own
 * SIGTERM/SIGINT handlers — two sets of handlers conflict and produce
 * unpredictable shutdown behavior.
 */
const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  enableGracefulShutdown: true,
};

const db = new PostgreSQLDatabase(config);

const { records } = await db.executeQuery<{ pid: number }>('SELECT pg_backend_pid() AS pid');
console.log(`Connected on backend ${records[0].pid}. Press Ctrl-C to trigger graceful shutdown.`);

// On SIGINT/SIGTERM the adapter logs the signal, closes the pool, and exits:
// → Received SIGINT. Closing database connections...
// → Database connections closed successfully.
```

### Disconnecting and the Shutdown Guard

Once `disconnect()` is called, the `isShuttingDown` flag rejects every further query and transaction. `disconnect()` accepts an optional timeout — the default ceiling is 10 000 ms.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

// Prime the pool with one query, then close it with a 5-second ceiling
await db.executeQuery('SELECT 1');
await db.disconnect(5000);

// Every operation after disconnect() is rejected by the shutdown guard
try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  if (error instanceof Error) {
    console.log(error.message);
    // → Cannot execute query: database is shutting down
  }
}

try {
  await db.withTransaction(async () => 'never runs');
} catch (error) {
  if (error instanceof Error) {
    console.log(error.message);
    // → Cannot start transaction: database is shutting down
  }
}
```

---

## Query Execution

Raw, parameterized SQL through `executeQuery()` — the engine underneath every statement builder.

### Queries with Named Parameters

SQL uses `:name` placeholders that the `yesql` compiler turns into safe positional parameters. A bare parameter comes back as text, so cast with `::type` when you want typed values back.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const { records, rowCount } = await db.executeQuery<{
    name: string;
    age: number;
    active: boolean;
  }>(
    `SELECT
       :name::text      AS name,
       :age::integer    AS age,
       :active::boolean AS active`,
    { name: 'john', age: 42, active: true }
  );

  console.log(records[0]);
  // → { name: 'john', age: 42, active: true }
  console.log(`rowCount: ${rowCount}`);
  // → rowCount: 1
} finally {
  await db.disconnect();
}
```

### Parameterization Prevents SQL Injection

Values are passed to the server separately from the SQL text, so a malicious payload is treated as a literal value — never as executable SQL.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const maliciousInput = "'; DROP TABLE users; --";

  const { records } = await db.executeQuery<{ echo: string }>(
    'SELECT :input::text AS echo',
    { input: maliciousInput }
  );

  console.log(records[0].echo === maliciousInput);
  // → true — the payload is a plain value, never part of the SQL text
} finally {
  await db.disconnect();
}
```

### Reading Column Metadata

The resolved `PostgreSQLQueryResult<R>` exposes the `pg` driver's field definitions through `fields`, alongside the typed `records` and the `rowCount`.

```typescript
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLQueryResult,
} from 'blendsdk/postgresql';

interface ProfileRow {
  id: number;
  name: string;
  active: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const result: PostgreSQLQueryResult<ProfileRow> = await db.executeQuery<ProfileRow>(
    'SELECT 1 AS id, :name::text AS name, true AS active',
    { name: 'test' }
  );

  console.log(result.fields.map((field) => field.name).join(', '));
  // → id, name, active

  console.log(`rows: ${result.rowCount}`);
  // → rows: 1
} finally {
  await db.disconnect();
}
```

### Handling Empty Result Sets

When no rows match, `executeQuery()` resolves with empty `records`, a `rowCount` of `0`, and empty `fields` — no field metadata is available without rows.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface WidgetRow {
  id: number;
  name: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE empty_result_widgets (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL
      )
    `);

    const result = await txDb.executeQuery<WidgetRow>(
      'SELECT * FROM empty_result_widgets WHERE id = :id',
      { id: 999 }
    );

    console.log(result.records);
    // → []
    console.log(result.rowCount);
    // → 0
    console.log(result.fields);
    // → [] (no rows means no column metadata either)
  });
} finally {
  await db.disconnect();
}
```

### Working with Complex Data Types

Cast parameters to their column types: `numeric` values return as strings, `timestamp` values as `Date` objects, and `jsonb` as parsed JavaScript values.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface ComplexRow {
  text_val: string;
  int_val: number;
  float_val: string; // numeric columns are returned as strings
  bool_val: boolean;
  date_val: Date;
  json_val: { key: string; nested: { count: number } };
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const { records } = await db.executeQuery<ComplexRow>(
    `SELECT
       :text_val::text      AS text_val,
       :int_val::integer    AS int_val,
       :float_val::numeric  AS float_val,
       :bool_val::boolean   AS bool_val,
       :date_val::timestamp AS date_val,
       :json_val::jsonb     AS json_val`,
    {
      text_val: 'hello world',
      int_val: 42,
      float_val: 3.14,
      bool_val: true,
      date_val: new Date('2023-01-01'),
      json_val: { key: 'value', nested: { count: 123 } },
    }
  );

  console.log(records[0]);
  // → {
  //     text_val: 'hello world',
  //     int_val: 42,
  //     float_val: '3.14',                                  // numeric comes back as a string
  //     bool_val: true,
  //     date_val: 2023-01-01T00:00:00.000Z,                 // Date object
  //     json_val: { key: 'value', nested: { count: 123 } }  // parsed JSONB
  //   }
} finally {
  await db.disconnect();
}
```

---

## Transactions

`withTransaction(fn)` issues `BEGIN`, runs the callback on one pinned client, then `COMMIT`s on success or `ROLLBACK`s on failure — always releasing the client.

### Committing a Unit of Work

Everything executed through the callback's database argument — raw queries and builder operations — runs inside the same server-side transaction.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
  email: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const created = await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE tx_example_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL
      )
    `);

    await txDb.executeQuery(
      'INSERT INTO tx_example_users (name, email) VALUES (:name, :email)',
      { name: 'John Doe', email: 'john@example.com' }
    );

    const { records } = await txDb.executeQuery<UserRow>(
      'SELECT id, name, email FROM tx_example_users WHERE email = :email',
      { email: 'john@example.com' }
    );

    return records[0];
  });

  console.log(`Committed user ${created.id}: ${created.name} <${created.email}>`);
  // → Committed user 1: John Doe <john@example.com>

  // The callback resolved, so COMMIT was issued and the row persisted
  const { rowCount } = await db.executeQuery(
    'SELECT 1 FROM tx_example_users WHERE email = :email',
    { email: 'john@example.com' }
  );
  console.log(`Rows visible after commit: ${rowCount}`);
  // → Rows visible after commit: 1
} finally {
  await db.disconnect();
}
```

### Rolling Back on Error

When the callback throws, a `ROLLBACK` is issued, the error is rethrown, and the client returns to the pool — the instance stays fully usable.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  // Set up the table and an initial row outside the transaction so the
  // rollback can be verified afterwards
  await db.executeQuery(`
    CREATE TEMP TABLE tx_rollback_products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      price DECIMAL(10,2) NOT NULL
    )
  `);

  await db.executeQuery(
    'INSERT INTO tx_rollback_products (name, price) VALUES (:name, :price)',
    { name: 'Initial Product', price: 10.0 }
  );

  try {
    await db.withTransaction(async (txDb) => {
      await txDb.executeQuery(
        'INSERT INTO tx_rollback_products (name, price) VALUES (:name, :price)',
        { name: 'Should Be Rolled Back', price: 20.0 }
      );

      // Throwing rejects the transaction — the INSERT above is rolled back
      throw new Error('Simulated failure');
    });
  } catch (error) {
    if (error instanceof Error) {
      console.log(`Rolled back: ${error.message}`);
      // → Rolled back: Simulated failure
    }
  }

  const { rowCount } = await db.executeQuery('SELECT 1 FROM tx_rollback_products');
  console.log(`Rows after rollback: ${rowCount}`);
  // → Rows after rollback: 1
} finally {
  await db.disconnect();
}
```

### Multiple Operations in a Single Transaction

Inserts, updates, and aggregate reads are all atomic within one transaction. Note that `COUNT` and `SUM` come back as strings (`bigint` / `numeric`).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const summary = await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE tx_example_orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(100) NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending'
      )
    `);

    await txDb.executeQuery(
      'INSERT INTO tx_example_orders (customer_name, total) VALUES (:name, :total)',
      { name: 'Alice', total: 100.5 }
    );

    await txDb.executeQuery(
      'INSERT INTO tx_example_orders (customer_name, total) VALUES (:name, :total)',
      { name: 'Bob', total: 75.25 }
    );

    await txDb.executeQuery(
      'UPDATE tx_example_orders SET status = :status WHERE customer_name = :name',
      { status: 'confirmed', name: 'Alice' }
    );

    const { records } = await txDb.executeQuery<{
      order_count: string;
      total_sum: string;
      confirmed_count: string;
    }>(`
      SELECT
        COUNT(*) AS order_count,
        SUM(total) AS total_sum,
        COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_count
      FROM tx_example_orders
    `);

    return records[0];
  });

  console.log(summary);
  // → { order_count: '2', total_sum: '175.75', confirmed_count: '1' }
} finally {
  await db.disconnect();
}
```

---

## INSERT Statement Builder

`db.insert<T>(tableName)` returns a fluent builder: each key in `.values()` becomes a column and a `:named` parameter, with optional `RETURNING` support.

### Inserting a Row

The keys of the `.values()` object become the column list, and each value is bound as a named parameter — never string-interpolated.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE insert_example_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL
      )
    `);

    await txDb
      .insert<UserRow>('insert_example_users')
      .values({ name: 'Integration Test', email: 'integration@example.com' })
      .execute();

    const { rowCount } = await txDb.executeQuery(
      'SELECT 1 FROM insert_example_users WHERE email = :email',
      { email: 'integration@example.com' }
    );

    console.log(`Rows inserted: ${rowCount}`);
    // → Rows inserted: 1
  });
} finally {
  await db.disconnect();
}
```

### Reading Back the Inserted Row with RETURNING

Append `.returning('*')` and terminate with `executeReturnSingle()` to get the created row (including server-generated values like `id` and `created_at`) — or `null` when nothing was returned.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  created_at?: Date;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE insert_returning_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const created = await txDb
      .insert<UserRow>('insert_returning_users')
      .values({ name: 'Returning Test', email: 'returning@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (created) {
      console.log(`Created user ${created.id}: ${created.name} <${created.email}>`);
      // → Created user 1: Returning Test <returning@example.com>
    }
  });
} finally {
  await db.disconnect();
}
```

### Restricting the RETURNING Columns

Pass an explicit column list instead of `'*'` to keep the returned shape minimal — the resulting record contains only the listed columns.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  age?: number;
  created_at?: Date;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE insert_columns_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        age INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const created = await txDb
      .insert<UserRow>('insert_columns_users')
      .values({ name: 'Selective Return', email: 'selective@example.com', age: 25 })
      .returning(['id', 'name', 'email'])
      .executeReturnSingle();

    console.log(created);
    // → { id: 1, name: 'Selective Return', email: 'selective@example.com' }
    // No age, no created_at — only the listed columns are returned
  });
} finally {
  await db.disconnect();
}
```

### Counting Inserted Rows

`executeReturnCount()` resolves with the number of affected rows — useful when you do not need the row data itself.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE insert_count_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL
      )
    `);

    const inserted = await txDb
      .insert<UserRow>('insert_count_users')
      .values({ name: 'Count Test', email: 'count@example.com' })
      .executeReturnCount();

    console.log(`Inserted ${inserted} row(s)`);
    // → Inserted 1 row(s)
  });
} finally {
  await db.disconnect();
}
```

---

## UPDATE Statement Builder

`db.update<T, F>(tableName)` builds `UPDATE` statements: `.values()` produces the `SET` clause with `:v_`-prefixed parameters, while `.filter()` produces the `WHERE` clause with `p1…pN` parameters.

### Updating a Row with a Filter

Value parameters are prefixed with `v_` (`name = :v_name`) and filter parameters are named `p1…pN`, so a column can be updated and filtered at the same time without parameter collisions.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  age?: number;
}

interface UserFilter {
  id?: number;
  email?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE update_example_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        age INTEGER
      )
    `);

    await txDb.executeQuery(
      'INSERT INTO update_example_users (name, email, age) VALUES (:name, :email, :age)',
      { name: 'Original Name', email: 'update@example.com', age: 25 }
    );

    await txDb
      .update<UserRow, UserFilter>('update_example_users')
      .values({ name: 'Updated Name', age: 26 })
      .filter({ email: 'update@example.com' })
      .execute();

    const { records } = await txDb.executeQuery<{ name: string; age: number }>(
      'SELECT name, age FROM update_example_users WHERE email = :email',
      { email: 'update@example.com' }
    );

    console.log(records[0]);
    // → { name: 'Updated Name', age: 26 }
  });
} finally {
  await db.disconnect();
}
```

### Reading Back the Updated Row with RETURNING

Multiple filter conditions are joined with `AND`; `.returning('*')` plus `executeReturnSingle()` yields the updated row.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface ProductRow {
  id?: number;
  name: string;
  price: number;
  category: string;
  in_stock?: boolean;
}

interface ProductFilter {
  category?: string;
  in_stock?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE update_returning_products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        category VARCHAR(50) NOT NULL,
        in_stock BOOLEAN DEFAULT true
      )
    `);

    await txDb.executeQuery(
      'INSERT INTO update_returning_products (name, price, category, in_stock) VALUES (:name, :price, :category, :in_stock)',
      { name: 'Test Product', price: 29.99, category: 'Electronics', in_stock: true }
    );

    const updated = await txDb
      .update<ProductRow, ProductFilter>('update_returning_products')
      .values({ price: 24.99, in_stock: false })
      .filter({ category: 'Electronics', in_stock: true })
      .returning('*')
      .executeReturnSingle();

    if (updated) {
      // PostgreSQL returns DECIMAL columns as strings at runtime
      console.log(`Updated ${updated.name}: ${updated.price} (in stock: ${updated.in_stock})`);
      // → Updated Test Product: 24.99 (in stock: false)
    }
  });
} finally {
  await db.disconnect();
}
```

### Bulk Update Without a Filter

When no filter — or an empty filter object — is provided, the `WHERE` clause is omitted and every row in the table is updated.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE update_bulk_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        active BOOLEAN DEFAULT true
      )
    `);

    await txDb.executeQuery(
      'INSERT INTO update_bulk_users (name) VALUES (:name1), (:name2), (:name3)',
      { name1: 'User 1', name2: 'User 2', name3: 'User 3' }
    );

    // No filter → "UPDATE update_bulk_users SET active = :v_active"
    await txDb
      .update<{ active: boolean }, {}>('update_bulk_users')
      .values({ active: false })
      .execute();

    const { records } = await txDb.executeQuery<{ count: string }>(
      'SELECT COUNT(*) AS count FROM update_bulk_users WHERE active = false'
    );

    console.log(`Deactivated rows: ${records[0].count}`);
    // → Deactivated rows: 3
  });
} finally {
  await db.disconnect();
}
```

### Updating with an Expression Filter

`filterByExpression()` receives the expression builder for the filter type, so the `WHERE` clause can be built with the BlendSDK expression API instead of a plain object.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  age: number;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE update_expression_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        age INTEGER NOT NULL,
        active BOOLEAN DEFAULT true
      )
    `);

    await txDb.executeQuery(
      `INSERT INTO update_expression_users (name, age) VALUES
         ('Teen User', 15),
         ('Adult User', 30)`
    );

    await txDb
      .update<UserRow, { age?: number }>('update_expression_users')
      .values({ active: false })
      .filterByExpression((q) => q.where('age').lessThan(18))
      .execute();

    const { records } = await txDb.executeQuery<{ name: string; active: boolean }>(
      'SELECT name, active FROM update_expression_users ORDER BY age'
    );

    console.log(records);
    // → [ { name: 'Teen User', active: false }, { name: 'Adult User', active: true } ]
  });
} finally {
  await db.disconnect();
}
```

---

## DELETE Statement Builder

`db.delete<F>(tableName)` builds `DELETE` statements whose `WHERE` clause is typed by `F`, with optional `RETURNING` support.

### Deleting Rows with a Filter

Filter keys are compiled into parameterized conditions named `p1…pN` — multiple keys are joined with `AND`.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE delete_example_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        active BOOLEAN DEFAULT true
      )
    `);

    await txDb.executeQuery(
      'INSERT INTO delete_example_users (name, email) VALUES (:name, :email)',
      { name: 'Delete Test', email: 'delete@example.com' }
    );

    await txDb
      .delete<UserFilter>('delete_example_users')
      .filter({ email: 'delete@example.com' })
      .execute();

    const { rowCount } = await txDb.executeQuery(
      'SELECT 1 FROM delete_example_users WHERE email = :email',
      { email: 'delete@example.com' }
    );

    console.log(`Remaining matching rows: ${rowCount}`);
    // → Remaining matching rows: 0
  });
} finally {
  await db.disconnect();
}
```

### Reading Back Deleted Rows with RETURNING

`.returning('*')` makes the deleted row available; `executeReturnSingle()` resolves with it, or `null` when no row matched the filter.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRecord {
  id?: number;
  name?: string;
  email?: string;
  age?: number;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE delete_returning_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        age INTEGER
      )
    `);

    await txDb.executeQuery(
      'INSERT INTO delete_returning_users (name, email, age) VALUES (:name, :email, :age)',
      { name: 'Single Return Test', email: 'single@example.com', age: 25 }
    );

    const deleted = await txDb
      .delete<UserRecord>('delete_returning_users')
      .filter({ email: 'single@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (deleted) {
      console.log(`Deleted ${deleted.name} <${deleted.email}>`);
      // → Deleted Single Return Test <single@example.com>
    }
  });
} finally {
  await db.disconnect();
}
```

### Bulk Delete Without a Filter

An empty filter object compiles to no `WHERE` clause — every row is removed. Omitting the `.filter()` call entirely has the same effect.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE delete_bulk_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        active BOOLEAN DEFAULT true
      )
    `);

    await txDb.executeQuery(
      'INSERT INTO delete_bulk_users (name) VALUES (:name1), (:name2), (:name3)',
      { name1: 'User 1', name2: 'User 2', name3: 'User 3' }
    );

    // filter({}) → "DELETE FROM delete_bulk_users" (no WHERE clause)
    await txDb.delete<{}>('delete_bulk_users').filter({}).execute();

    const { records } = await txDb.executeQuery<{ count: string }>(
      'SELECT COUNT(*) AS count FROM delete_bulk_users'
    );

    console.log(`Remaining rows: ${records[0].count}`);
    // → Remaining rows: 0
  });
} finally {
  await db.disconnect();
}
```

### Counting Deleted Rows

`executeReturnCount()` resolves with the number of deleted rows — the natural terminator for cleanup-style deletes.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE delete_count_items (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL
      )
    `);

    await txDb.executeQuery(
      `INSERT INTO delete_count_items (name, category) VALUES
         ('Count Test 1', 'Count Category'),
         ('Count Test 2', 'Count Category'),
         ('Count Test 3', 'Other Category')`
    );

    const removed = await txDb
      .delete<{ category: string }>('delete_count_items')
      .filter({ category: 'Count Category' })
      .executeReturnCount();

    console.log(`Deleted rows: ${removed}`);
    // → Deleted rows: 2
  });
} finally {
  await db.disconnect();
}
```

---

## SELECT Queries with FromStatement

Read queries use the inherited `db.from<T>()` and `db.selectAll()` factories. Columns are chosen with `.select()`, rows are filtered with `.byExpression()`, and the statement terminates with `.execute()`.

### Selecting All Columns

Calling `.select()` with no arguments produces `SELECT *`; the returned result contains fully typed records.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
  email: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE select_all_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL
      )
    `);

    await txDb.executeQuery(
      `INSERT INTO select_all_users (name, email) VALUES
         ('User One', 'user1@example.com'),
         ('User Two', 'user2@example.com'),
         ('User Three', 'user3@example.com')`
    );

    const result = await txDb.from<UserRow>('select_all_users').select().execute();

    if (!result) {
      throw new Error('SELECT returned no result');
    }

    for (const user of result.records) {
      console.log(`${user.id}: ${user.name} <${user.email}>`);
    }
    // → 1: User One <user1@example.com>
    // → 2: User Two <user2@example.com>
    // → 3: User Three <user3@example.com>

    console.log(`rowCount: ${result.rowCount}`);
    // → rowCount: 3
  });
} finally {
  await db.disconnect();
}
```

### Selecting Specific Columns

Pass a column list to `.select()` — the records contain exactly those columns and nothing else.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface ProductSummary {
  id: number;
  name: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE select_column_products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL
      )
    `);

    await txDb.executeQuery(
      `INSERT INTO select_column_products (name, category) VALUES
         ('Product A', 'Category 1'),
         ('Product B', 'Category 2'),
         ('Product C', 'Category 1')`
    );

    const result = await txDb
      .from<ProductSummary>('select_column_products')
      .select(['id', 'name'])
      .execute();

    if (!result) {
      throw new Error('SELECT returned no result');
    }

    console.log(result.records);
    // → [ { id: 1, name: 'Product A' },
    //     { id: 2, name: 'Product B' },
    //     { id: 3, name: 'Product C' } ]
    // Records contain only id and name — no category
  });
} finally {
  await db.disconnect();
}
```

### Column Aliases and Computed Expressions

Pass an object to `.select()` to alias columns or compute expressions — the keys become the record's field names.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserAlias {
  user_id: number;
  full_name: string;
  user_age: number;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE select_alias_users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(50) NOT NULL,
        last_name VARCHAR(50) NOT NULL,
        age INTEGER
      )
    `);

    await txDb.executeQuery(
      `INSERT INTO select_alias_users (first_name, last_name, age) VALUES
         ('John', 'Doe', 25),
         ('Jane', 'Smith', 30)`
    );

    const result = await txDb
      .from<UserAlias>('select_alias_users')
      .select({
        user_id: 'id',
        full_name: "first_name || ' ' || last_name",
        user_age: 'age',
      })
      .execute();

    if (!result) {
      throw new Error('SELECT returned no result');
    }

    for (const row of result.records) {
      console.log(`${row.user_id}: ${row.full_name} (${row.user_age})`);
    }
    // → 1: John Doe (25)
    // → 2: Jane Smith (30)
  });
} finally {
  await db.disconnect();
}
```

### Filtering with Compiled Expressions

Compile a `WHERE` expression with the expression builder from `blendsdk/expression` (the same engine that powers `.filter()`), then hand it to the statement with `.byExpression()`.

```typescript
import { query } from 'blendsdk/expression';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
  age: number;
  active: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE select_expression_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        age INTEGER NOT NULL,
        active BOOLEAN DEFAULT true
      )
    `);

    await txDb.executeQuery(
      `INSERT INTO select_expression_users (name, age, active) VALUES
         ('Active 25', 25, true),
         ('Inactive 25', 25, false),
         ('Active 30', 30, true)`
    );

    const expression = query<UserRow>()
      .where('active')
      .equals(true)
      .and('age')
      .equals(25)
      .compile();

    const result = await txDb
      .from<UserRow>('select_expression_users')
      .select()
      .byExpression(expression)
      .execute();

    if (!result) {
      throw new Error('SELECT returned no result');
    }

    console.log(result.records);
    // → [ { id: 1, name: 'Active 25', age: 25, active: true } ]
  });
} finally {
  await db.disconnect();
}
```

---

## Query Hooks

`beforeQuery` transforms the parameter map before compilation; `afterQuery` transforms result rows. Both are available on every statement builder and as per-call options on `executeQuery()`.

### Normalizing Input and Masking Output

`beforeQuery` normalizes the email and hashes the password before the SQL is compiled; `afterQuery` strips the hash from the returned row. On INSERT, parameter keys match column names directly.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
  role?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE hooks_combined_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        role VARCHAR(20) DEFAULT 'user'
      )
    `);

    const created = await txDb
      .insert<UserRow>('hooks_combined_users')
      .values({
        name: 'Combined Test',
        email: 'COMBINED@EXAMPLE.COM',
        password_hash: 'plaintext123',
      })
      .beforeQuery((params) => {
        const transformed: Record<string, unknown> = { ...params };

        if (typeof transformed.email === 'string') {
          transformed.email = transformed.email.toLowerCase();
        }
        if (typeof transformed.password_hash === 'string') {
          transformed.password_hash = `bcrypt_${transformed.password_hash}`;
        }

        return transformed;
      })
      .afterQuery((records) =>
        records.map((record) => {
          const safe = { ...record };
          delete safe.password_hash;
          return safe;
        })
      )
      .returning('*')
      .executeReturnSingle();

    if (created) {
      console.log(created);
      // → { id: 1,
      //     name: 'Combined Test',
      //     email: 'combined@example.com',   // normalized by beforeQuery
      //     role: 'user' }                   // password_hash masked by afterQuery
    }
  });
} finally {
  await db.disconnect();
}
```

### Masking Sensitive Fields Across Multiple Rows

`afterQuery` also runs for `executeReturnAll()`, so masking can be applied uniformly to every returned record.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface MaskedUser {
  id?: number;
  name?: string;
  email?: string;
  password_hash?: string;
  secret_token?: string;
  public_info?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE hooks_mask_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255),
        secret_token VARCHAR(255),
        public_info VARCHAR(100)
      )
    `);

    await txDb.executeQuery(
      `INSERT INTO hooks_mask_users (name, email, password_hash, secret_token, public_info) VALUES
         ('User 1', 'user1@example.com', 'hash1', 'token1', 'info1'),
         ('User 2', 'user2@example.com', 'hash2', 'token2', 'info2')`
    );

    const safeRecords = await txDb
      .delete<MaskedUser>('hooks_mask_users')
      .filter({})
      .afterQuery((records) =>
        records.map((record) => {
          const safe = { ...record };
          delete safe.password_hash;
          delete safe.secret_token;
          return safe;
        })
      )
      .returning('*')
      .executeReturnAll();

    for (const record of safeRecords) {
      console.log(record);
    }
    // → { id: 1, name: 'User 1', email: 'user1@example.com', public_info: 'info1' }
    // → { id: 2, name: 'User 2', email: 'user2@example.com', public_info: 'info2' }
  });
} finally {
  await db.disconnect();
}
```

### Transforming Filter Parameters with beforeQuery

Filter parameters from `.filter()` are named `p1…pN` in compilation order — a DELETE or FROM statement can normalize user input before it reaches the server. (On UPDATE, value parameters carry the `v_` prefix instead.)

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface AccountRecord {
  id?: number;
  name?: string;
  email?: string;
  status?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery(`
      CREATE TEMP TABLE hooks_filter_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'active'
      )
    `);

    await txDb.executeQuery(
      'INSERT INTO hooks_filter_users (name, email) VALUES (:name, :email)',
      { name: 'Filter Test', email: 'filter@example.com' }
    );

    const deleted = await txDb
      .delete<AccountRecord>('hooks_filter_users')
      .filter({ email: 'FILTER@EXAMPLE.COM' })
      .beforeQuery((params) => {
        const transformed: Record<string, unknown> = { ...params };

        // The single filter key compiled to the parameter p1
        if (typeof transformed.p1 === 'string') {
          transformed.p1 = transformed.p1.toLowerCase();
        }

        return transformed;
      })
      .returning('*')
      .executeReturnSingle();

    if (deleted) {
      console.log(`Deleted ${deleted.email} (${deleted.name})`);
      // → Deleted filter@example.com (Filter Test)
    }
  });
} finally {
  await db.disconnect();
}
```

### Per-Call Hooks with executeQuery

`executeQuery()` accepts the same two hooks through its options object — `afterQuery` is skipped when the query returns no rows.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const result = await db.executeQuery<{ name: string }>(
    'SELECT :name::text AS name',
    { name: 'grace' },
    {
      // Runs before the SQL is compiled — replaces the supplied parameter value
      beforeQuery: (params) => ({ ...params, name: 'ada lovelace' }),
      // Runs after execution — transforms the rows for the caller
      afterQuery: (records) => records.map((record) => ({ name: record.name.toUpperCase() })),
    }
  );

  console.log(result.records[0].name);
  // → ADA LOVELACE
} finally {
  await db.disconnect();
}
```

---

## Error Handling

Failed queries and unreachable servers reject cleanly; the instance releases its client and stays usable, and `disconnect()` resolves even when no connection was ever established.

### Recovering from a Failed Query

A rejected query releases its pooled client in a `finally` block, so the same instance keeps working afterwards.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  try {
    await db.executeQuery('THIS IS NOT VALID SQL');
  } catch (error) {
    if (error instanceof Error) {
      console.log(`Query failed: ${error.message}`);
      // → Query failed: syntax error at or near "THIS"
    }
  }

  // The client was returned to the pool — the instance is immediately usable
  const { records } = await db.executeQuery<{ ok: number }>('SELECT 1 AS ok');
  console.log(`Recovered: ${records[0].ok}`);
  // → Recovered: 1
} finally {
  await db.disconnect();
}
```

### Handling Connection Failures

Construction never throws — an unreachable host surfaces on the first query, and `disconnect()` still resolves cleanly.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'invalid-host',
  port: 9999,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  if (error instanceof Error) {
    console.log(`Connection failed: ${error.message}`);
    // → Connection failed: getaddrinfo ENOTFOUND invalid-host
  }
} finally {
  // Resolves even though no connection was ever established
  await db.disconnect();
  console.log('Pool closed cleanly');
  // → Pool closed cleanly
}
```

### Validating Statement Input

INSERT and UPDATE builders reject empty `.values()` with a descriptive error before any SQL reaches the server, instead of emitting invalid statements.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  name: string;
  email: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  // INSERT — an empty values object never produces "INSERT INTO ... () VALUES ..."
  try {
    await db.insert<UserRow>('users').values({}).execute();
  } catch (error) {
    if (error instanceof Error) {
      console.log(error.message);
      // → Cannot build INSERT statement for table "users": no values provided.
      //   Call .values() with at least one column before executing.
    }
  }

  // UPDATE — the same guard protects the SET clause
  try {
    await db.update<UserRow, { id?: number }>('users').values({}).filter({ id: 1 }).execute();
  } catch (error) {
    if (error instanceof Error) {
      console.log(error.message);
      // → Cannot build UPDATE statement for table "users": no values provided.
      //   Call .values() with at least one column before executing.
    }
  }
} finally {
  await db.disconnect();
}
```

---

For the conceptual background behind these examples, see the Overview and Core Concepts documents.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
