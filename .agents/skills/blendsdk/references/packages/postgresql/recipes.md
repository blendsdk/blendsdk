> **Package**: `blendsdk/postgresql`

# postgresql Advanced Patterns

The building blocks — pooled queries, async-local transactions, fluent statement builders, query hooks and the inherited FROM/expression surface — are individually small. Real applications combine them. The patterns below are complete compositions that solve problems you will actually hit: keeping write policy in one place, retrying serializable transactions, detecting concurrent edits, keeping an audit trail atomic, scoping data to a tenant, soft-deleting without leaking rows, loading data in bulk without N round trips, building read models the builders cannot express, and draining a job worker without losing work.

Install the umbrella once — the adapter and the expression builder used in pattern 6 arrive with it:

```bash
npm install blendsdk
```

Every example assumes a reachable PostgreSQL server with this schema (the connection block is repeated in each example so the snippets stay self-contained):

```sql
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER NOT NULL,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  version       INTEGER NOT NULL DEFAULT 1,
  deleted_at    TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_tenant_email_active_idx
  ON users (tenant_id, email)
  WHERE deleted_at IS NULL;

CREATE INDEX users_tenant_email_idx ON users (tenant_id, email);

CREATE TABLE audit_events (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER NOT NULL,
  detail     JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity, entity_id, created_at);

CREATE TABLE inventory (
  sku   TEXT PRIMARY KEY,
  stock INTEGER NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
  id             SERIAL PRIMARY KEY,
  customer_email TEXT NOT NULL,
  total          NUMERIC(12, 2) NOT NULL,
  status         TEXT NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE staging_rows (
  id       SERIAL PRIMARY KEY,
  sku      TEXT NOT NULL,
  quantity INTEGER NOT NULL
);

CREATE TABLE jobs (
  id      SERIAL PRIMARY KEY,
  status  TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL
);

CREATE INDEX jobs_status_idx ON jobs (status, id);

CREATE TABLE job_results (
  id      BIGSERIAL PRIMARY KEY,
  job_id  INTEGER NOT NULL REFERENCES jobs(id),
  payload TEXT NOT NULL
);
```

---

## Pattern Index

| # | Pattern | Primary APIs | Solves |
| --- | --- | --- | --- |
| 1 | Policy-enforcing repository | `insert()`, `update()`, `beforeQuery`, `afterQuery` | Normalization and PII rules drifting across handlers |
| 2 | Transactional unit of work with retry | `withTransaction()`, `executeQuery()`, `insert()` | Multi-step writes that must be atomic and survive serialization failures |
| 3 | Optimistic concurrency with version columns | `update()`, `filterByExpression()`, `returning()` | Lost updates between concurrent editors |
| 4 | Atomic audit trail | `withTransaction()`, `executeQuery()`, builders | Audit entries that disagree with the data they describe |
| 5 | Structural tenant scoping | `filterByExpression()`, `filter()`, `delete()` | Cross-tenant reads and writes; hooks cannot scope |
| 6 | Soft delete and restore | `update()`, `from()`, `byExpression()`, `blendsdk/expression` | Deleted rows leaking into lists and searches |
| 7 | Bulk imports | `withTransaction()`, `insert()`, `executeQuery()` | N+1 round trips and partially imported batches |
| 8 | Read models with hand-written SQL | `executeQuery()`, `withTransaction()` | Pagination and aggregates the builders cannot express |
| 9 | Shutdown-aware job worker | `withTransaction()`, `disconnect()`, `FOR UPDATE SKIP LOCKED` | Work lost or duplicated during deploy/shutdown |

---

## Pattern 1: Policy-Enforcing Repository

**Use this when** the same write rules — lowercase emails, trim names, hash secrets, strip sensitive columns from responses — keep reappearing in controllers, jobs and scripts, and you want one place where they are applied for every write.

**The scenario.** A user service creates, renames and disables users. Normalization and response shaping live in query hooks attached to the statement, so no caller can forget them.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  tenant_id: number;
  email: string;
  name: string;
  password_hash?: string;
  role?: string;
  version?: number;
  deleted_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
}

interface UserFilter {
  id?: number;
  tenant_id?: number;
  email?: string;
}

interface CreateUserInput {
  tenantId: number;
  email: string;
  name: string;
  password: string;
  role?: string;
}

class UserRepository {
  constructor(private readonly db: PostgreSQLDatabase) {}

  async create(input: CreateUserInput): Promise<User | null> {
    return this.db
      .insert<User>('users')
      .values({
        tenant_id: input.tenantId,
        email: input.email,
        name: input.name,
        password_hash: input.password,
        role: input.role ?? 'member',
      })
      .beforeQuery((params) => {
        const normalized = { ...params };

        if (typeof normalized.email === 'string') {
          normalized.email = normalized.email.trim().toLowerCase();
        }
        if (typeof normalized.name === 'string') {
          normalized.name = normalized.name.trim();
        }
        if (typeof normalized.password_hash === 'string') {
          // Stand-in for a real KDF. Hash the password before it reaches the
          // database; this line only shows where the transform belongs.
          normalized.password_hash = `scrypt:${normalized.password_hash}`;
        }

        return normalized;
      })
      .afterQuery((rows) => rows.map((row) => this.toPublicUser(row)))
      .returning('*')
      .executeReturnSingle();
  }

  async rename(filter: UserFilter, name: string): Promise<User | null> {
    return this.db
      .update<User, UserFilter>('users')
      .values({ name: name.trim() })
      .filter(filter)
      .afterQuery((rows) => rows.map((row) => this.toPublicUser(row)))
      .returning('*')
      .executeReturnSingle();
  }

  async disable(tenantId: number, email: string): Promise<number> {
    return this.db
      .update<User, UserFilter>('users')
      .values({ role: 'disabled' })
      .filter({ tenant_id: tenantId, email: email.trim().toLowerCase() })
      .executeReturnCount();
  }

  private toPublicUser(row: User): User {
    return {
      id: Number(row.id),
      tenant_id: Number(row.tenant_id),
      email: String(row.email),
      name: String(row.name),
      role: String(row.role),
      version: Number(row.version),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const users = new UserRepository(db);

try {
  const created = await users.create({
    tenantId: 7,
    email: '  ADA@Example.COM ',
    name: '  Ada Lovelace  ',
    password: 'correct horse battery staple',
    role: 'admin',
  });
  console.log(created?.email, created?.name);
  console.log('password_hash exposed?', created !== null && 'password_hash' in created);

  const renamed = await users.rename({ tenant_id: 7, email: 'ada@example.com' }, 'Ada Byron');
  console.log(renamed?.name);

  const disabled = await users.disable(7, 'ADA@EXAMPLE.COM');
  console.log(`disabled ${disabled} row(s)`);
} catch (error) {
  console.error('repository operation failed', error);
  throw error;
} finally {
  await db.disconnect();
}
```

The INSERT the builder sends:

```sql
INSERT INTO users (tenant_id, email, name, password_hash, role)
VALUES (:tenant_id, :email, :name, :password_hash, :role)
RETURNING *
```

**Why it works.** Hooks run inside the statement pipeline, so the policy is attached to the operation itself rather than to a caller. INSERT parameters are the raw column names (`email`, `password_hash`), which is exactly what a normalization hook expects; UPDATE SET values arrive as `v_<column>` and filter values as `p1…pN`, and the repository uses the object-form `filter()` so it never depends on those positional names. Because the repository holds the same `PostgreSQLDatabase` instance, it also participates in transactions without being handed a transaction handle:

```typescript fragment
await db.withTransaction(async () => {
  // No tx handle required: the async-local context follows this call chain,
  // so the repository's statements run on the transaction client.
  await users.create({
    tenantId: 7,
    email: 'grace@example.com',
    name: 'Grace Hopper',
    password: 's3cret',
  });
});
```

**Caveats and performance.**

- Hooks are synchronous. Do not attempt I/O (hashing with an async library, remote lookups) inside them — hash before calling the repository, or use a synchronous KDF.
- `afterQuery` is skipped when `rowCount === 0`. Never rely on it to normalize empty results; the terminators already return `null`, `[]` or `0`.
- Hooks transform values, not predicates. They cannot enforce authorization or tenant scope — see pattern 5.
- Repository methods must be built on the same `PostgreSQLDatabase` instance that runs the transaction. A repository over a different instance would acquire its own client.
- Attach only cheap transforms per statement; avoid deep-cloning large JSON payloads in `beforeQuery`.

---

## Pattern 2: Transactional Unit of Work with Retry

**Use this when** one business action spans several statements (reserve stock, create an order, write derived rows) and any failure must undo all of them — and when concurrent writers make serialization failures a normal outcome rather than an exception.

**The scenario.** Checkout reserves inventory with a set-based guarded UPDATE and creates the order in the same transaction. `serializable` protects cross-statement invariants; a bounded retry loop re-runs the whole transaction when PostgreSQL reports a serialization failure or deadlock.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Order {
  id?: number;
  customer_email: string;
  total: number;
  status?: string;
  created_at?: Date;
}

interface PlaceOrderInput {
  customerEmail: string;
  sku: string;
  quantity: number;
  unitPrice: number;
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: string }).code;
  return code === '40001' || code === '40P01';
}

async function withRetry<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }

  throw lastError;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig: { max: 10, connectionTimeoutMillis: 5000 },
});

async function placeOrder(input: PlaceOrderInput): Promise<number> {
  return withRetry(
    () =>
      db.withTransaction(
        async (tx) => {
          const reservation = await tx.executeQuery(
            `UPDATE inventory
                SET stock = stock - :quantity
              WHERE sku = :sku
                AND stock >= :quantity`,
            { quantity: input.quantity, sku: input.sku }
          );

          if (reservation.rowCount !== 1) {
            throw new Error(`insufficient stock for SKU ${input.sku}`);
          }

          const order = await tx
            .insert<Order>('orders')
            .values({
              customer_email: input.customerEmail,
              total: input.quantity * input.unitPrice,
              status: 'confirmed',
            })
            .returning('*')
            .executeReturnSingle();

          if (!order || order.id === undefined) {
            throw new Error('order insert did not return an id');
          }

          return order.id;
        },
        { isolation: 'serializable' }
      ),
    3
  );
}

try {
  const orderId = await placeOrder({
    customerEmail: 'grace@example.com',
    sku: 'SKU-1',
    quantity: 2,
    unitPrice: 19.99,
  });
  console.log(`created order ${orderId}`);
} catch (error) {
  console.error('checkout failed', error);
  throw error;
} finally {
  await db.disconnect();
}
```

**Why it works.**

- The guarded `UPDATE … WHERE stock >= :quantity` is a single atomic statement: two concurrent checkouts cannot both reserve the last unit, and `rowCount !== 1` is a precise, race-free insufficient-stock signal without a read-modify-write cycle.
- `{ isolation: 'serializable' }` is rendered as `BEGIN ISOLATION LEVEL SERIALIZABLE` only after the value is checked against the allowlist, so the option itself cannot carry SQL.
- The retry wraps `db.withTransaction()`, not statements inside it. Every attempt gets a fresh client, a fresh `BEGIN`, and a clean rollback — retrying inside an aborted transaction cannot work.
- `40001` (serialization failure) and `40P01` (deadlock detected) are transient by definition; everything else (constraint violations, insufficient stock) fails immediately and is never retried.
- The `finally` in `withTransaction()` releases every acquired client exactly once, including on the rolled-back attempts.

**Caveats and performance.**

- Keep serializable transactions short. Predicate locks and retries make long transactions expensive under contention.
- Bound the attempts (three is typical) and add jitter to the backoff; unbounded retries turn a hot row into a livelock.
- Business validation that can never succeed (`insufficient stock`) must not be classified as retryable — the `isRetryable` gate is what prevents useless replays.
- Never perform external side effects (sending email, charging a card) inside the retried callback; put them after the transaction commits, or make them idempotent with an outbox.
- Do not nest `withTransaction()` — a nested call fails fast with `Cannot start a nested transaction`. Compose by passing work into one callback, not by calling the method again.

---

## Pattern 3: Optimistic Concurrency with Version Columns

**Use this when** two users (or a user and a background job) can edit the same row and you must reject the second save instead of silently overwriting the first.

**The scenario.** Documents carry a `version` column. A save updates the row only if the caller's expected version still matches, and returns the new row so the caller can continue.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Document {
  id?: number;
  title: string;
  body: string;
  version: number;
  updated_at?: Date;
}

interface DocumentFilter {
  id?: number;
  version?: number;
}

class ConcurrentUpdateError extends Error {
  constructor(public readonly documentId: number) {
    super(`document ${documentId} changed since it was loaded`);
    this.name = 'ConcurrentUpdateError';
  }
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

async function loadDocument(id: number): Promise<Document> {
  const { records } = await db.executeQuery<Document>(
    'SELECT id, title, body, version, updated_at FROM documents WHERE id = :id',
    { id }
  );
  const document = records[0];
  if (!document) {
    throw new Error(`document ${id} not found`);
  }
  return document;
}

async function saveDocument(
  id: number,
  expectedVersion: number,
  changes: { title: string; body: string }
): Promise<Document> {
  const updated = await db
    .update<Document, DocumentFilter>('documents')
    .values({
      title: changes.title,
      body: changes.body,
      version: expectedVersion + 1,
    })
    .filterByExpression((q) => q.where('id').equals(id).and('version').equals(expectedVersion))
    .returning('*')
    .executeReturnSingle();

  if (!updated) {
    throw new ConcurrentUpdateError(id);
  }
  return updated;
}

try {
  const current = await loadDocument(1);
  const saved = await saveDocument(1, current.version, {
    title: 'Advanced patterns',
    body: 'The version guard rejects the second writer instead of overwriting.',
  });
  console.log(`saved document at version ${saved.version}`);
} catch (error) {
  if (error instanceof ConcurrentUpdateError) {
    console.error('reload the document, merge, and retry');
  } else {
    throw error;
  }
} finally {
  await db.disconnect();
}
```

The UPDATE the builder sends:

```sql
UPDATE documents
   SET title = :v_title, body = :v_body, version = :v_version
 WHERE id = :p1 AND version = :p2
RETURNING *
```

**Why it works.** The version predicate and the version increment are part of one UPDATE statement, so the check and the write are atomic per row under `read committed` — no window exists between "is it still version 3?" and "make it version 4". `executeReturnSingle()` returning `null` is the conflict signal; the new row returned by `RETURNING *` carries the incremented version the client uses for its next save. The generic on `DocumentFilter` includes `version`, which keeps `filterByExpression()` strongly typed.

**Caveats and performance.**

- `null` conflates "row deleted" and "version stale". When the distinction matters, follow up with a plain `SELECT` to decide between 404 and 409.
- The version column must be part of the UPDATE and must have a database default (`version INTEGER NOT NULL DEFAULT 1`); never rely on the application to set it on INSERT.
- Do not combine the guard with a blind `updated_at = now()` trigger alone — timestamps are not a concurrency token.
- Version checks protect single-row edits. Cross-row invariants (two rows must sum to a value) need `serializable` and pattern 2's retry.
- An index on the primary key is sufficient; the WHERE clause is a point lookup.

---

## Pattern 4: Atomic Audit Trail

**Use this when** every business change must produce a consistent audit record — the event and the change either both exist or neither does.

**The scenario.** Deactivating a user writes the new role and an audit event in one transaction. The `AuditLog` is constructed once on the database instance; inside the transaction callback its writes join the transaction automatically.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface AuditEvent {
  actor: string;
  action: string;
  entity: string;
  entityId: number;
  detail?: Record<string, string | number | boolean>;
}

interface AuditTrailEntry {
  action: string;
  actor: string;
  created_at: Date;
}

class AuditLog {
  constructor(private readonly db: PostgreSQLDatabase) {}

  async record(event: AuditEvent): Promise<void> {
    await this.db.executeQuery(
      `INSERT INTO audit_events (actor, action, entity, entity_id, detail)
       VALUES (:actor, :action, :entity, :entity_id, :detail)`,
      {
        actor: event.actor,
        action: event.action,
        entity: event.entity,
        entity_id: event.entityId,
        detail: event.detail ?? null,
      }
    );
  }

  async trailFor(entity: string, entityId: number): Promise<AuditTrailEntry[]> {
    const { records } = await this.db.executeQuery<AuditTrailEntry>(
      `SELECT action, actor, created_at
         FROM audit_events
        WHERE entity = :entity AND entity_id = :entity_id
        ORDER BY created_at`,
      { entity, entity_id: entityId }
    );
    return records;
  }
}

interface User {
  id?: number;
  tenant_id: number;
  email: string;
  name: string;
  role?: string;
}

interface UserFilter {
  id?: number;
  tenant_id?: number;
  email?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const audit = new AuditLog(db);

async function deactivateUser(userId: number, actor: string): Promise<void> {
  await db.withTransaction(async (tx) => {
    const { records } = await tx.executeQuery<{ role: string }>(
      'SELECT role FROM users WHERE id = :id',
      { id: userId }
    );
    const current = records[0];
    if (!current) {
      throw new Error(`user ${userId} not found`);
    }

    const updated = await tx
      .update<User, UserFilter>('users')
      .values({ role: 'disabled' })
      .filter({ id: userId })
      .returning('*')
      .executeReturnSingle();

    if (!updated) {
      throw new Error(`user ${userId} disappeared during update`);
    }

    // The audit write joins the transaction because the async-local context is
    // shared by this call chain — even though `audit` was built on `db`, not `tx`.
    await audit.record({
      actor,
      action: 'user.deactivated',
      entity: 'users',
      entityId: userId,
      detail: { previousRole: current.role },
    });
  });
}

try {
  await deactivateUser(1, 'admin@example.com');
  const trail = await audit.trailFor('users', 1);
  for (const entry of trail) {
    console.log(`${entry.created_at.toISOString()} ${entry.actor} ${entry.action}`);
  }
} catch (error) {
  console.error('deactivation failed; no audit row was committed', error);
  throw error;
} finally {
  await db.disconnect();
}
```

**Why it works.** The transaction client is held in an `AsyncLocalStorage` context, not in a field on a particular handle. Any `executeQuery()` that runs on the same instance during the callback — from `tx`, from `audit`, from a repository — lands on the same client, so the audit INSERT and the role UPDATE commit or roll back together. The reverse is the wrong pattern:

```typescript fragment
// ❌ The update commits first; if this process dies before the audit write,
// the change exists with no record of who made it.
await db.update<User, UserFilter>('users').values({ role: 'disabled' }).filter({ id: userId }).execute();
await audit.record({ actor, action: 'user.deactivated', entity: 'users', entityId: userId });
```

**Caveats and performance.**

- A rollback also erases the audit of the attempt. That is correct for "no event without the change", but failed attempts (wrong password, denied permission) need their own write *outside* the transaction, after the rollback.
- Do not fire-and-forget audit writes from inside the callback (`void audit.record(...)`) and never retain the handle: detached tasks are rejected with `Cannot execute a query after the transaction has completed`.
- Audit tables grow monotonically. Index `(entity, entity_id, created_at)` as in the schema, partition by month for high volume, and avoid storing unbounded payloads in `detail`.
- The `detail` parameter is bound as a value and serialized to JSONB; it is never interpolated into SQL.
- Every audit INSERT adds a row and WAL to the transaction. For extremely hot paths, consider a separate high-throughput event pipeline — at the cost of losing atomicity.

---

## Pattern 5: Structural Tenant Scoping (Hooks Cannot Authorize)

**Use this when** multiple tenants share one schema and every read and write must be confined to the caller's tenant.

**The anti-pattern first.** Query hooks only rewrite bound parameter values. They cannot add a predicate, so a "tenant hook" is silently ignored — the generated SQL never references the extra parameter:

```typescript fragment
const tenantId = 7;

// ❌ This does not scope anything: the DELETE has no :tenant_id placeholder,
// so adding the value to the parameter object changes nothing.
await db
  .delete<TenantUserFilter>('users')
  .filter({ id: 42 })
  .beforeQuery((params) => ({ ...params, tenant_id: tenantId }))
  .execute();
```

Tenant isolation must be structural: the tenant predicate is part of every statement the application can issue.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  tenant_id: number;
  email: string;
  name: string;
  role?: string;
  deleted_at?: Date | null;
}

interface TenantUserFilter {
  id?: number;
  tenant_id?: number;
  email?: string;
  role?: string;
}

class TenantUsers {
  constructor(
    private readonly db: PostgreSQLDatabase,
    private readonly tenantId: number
  ) {}

  async findById(id: number): Promise<User | null> {
    const { records } = await this.db.executeQuery<User>(
      `SELECT id, tenant_id, email, name, role, deleted_at
         FROM users
        WHERE tenant_id = :tenant_id AND id = :id`,
      { tenant_id: this.tenantId, id }
    );
    return records[0] ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const { records } = await this.db.executeQuery<User>(
      `SELECT id, tenant_id, email, name, role, deleted_at
         FROM users
        WHERE tenant_id = :tenant_id AND email = :email`,
      { tenant_id: this.tenantId, email: email.trim().toLowerCase() }
    );
    return records[0] ?? null;
  }

  async disable(email: string): Promise<number> {
    return this.db
      .update<User, TenantUserFilter>('users')
      .values({ role: 'disabled' })
      .filterByExpression((q) =>
        q
          .where('tenant_id')
          .equals(this.tenantId)
          .and('email')
          .equals(email.trim().toLowerCase())
      )
      .executeReturnCount();
  }

  async purgeDisabled(): Promise<number> {
    return this.db
      .delete<TenantUserFilter>('users')
      .filter({ tenant_id: this.tenantId, role: 'disabled' })
      .executeReturnCount();
  }
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const tenantUsers = new TenantUsers(db, 7);

try {
  const user = await tenantUsers.findByEmail('ada@example.com');
  console.log(user?.name ?? 'not found in tenant 7');

  const disabled = await tenantUsers.disable('ADA@EXAMPLE.COM');
  console.log(`disabled ${disabled} row(s) in tenant 7`);

  const purged = await tenantUsers.purgeDisabled();
  console.log(`purged ${purged} disabled row(s) in tenant 7`);
} finally {
  await db.disconnect();
}
```

The UPDATE the builder sends:

```sql
UPDATE users
   SET role = :v_role
 WHERE tenant_id = :p1 AND email = :p2
```

**Why it works.** The tenant id is captured in the scoped object and appears in every predicate — in raw SQL as `:tenant_id`, in expression filters as the first `where()` term. There is no code path in `TenantUsers` that can produce a statement without it, so a caller cannot accidentally cross tenants. The constructor argument must come from an authenticated context (the session or token), never from a request body.

As defense in depth, PostgreSQL row-level security can enforce the same rule in the database. Because the setting must be transaction-local (session-level settings would stick to a pooled connection), set it inside the transaction — the async-local context guarantees the same client runs the statements below:

```typescript fragment
await db.withTransaction(async (tx) => {
  // is_local = true: the setting disappears when this transaction ends.
  await tx.executeQuery("SELECT set_config('app.tenant_id', :tenantId, true)", {
    tenantId: 7,
  });

  // Every statement in this call chain runs on the same client, so an
  // RLS policy using current_setting('app.tenant_id')::int applies.
});
```

**Caveats and performance.**

- Never derive the tenant from client-supplied data without verifying it against the authenticated identity.
- Raw SQL inside the scoped class must include the tenant predicate on every joined table, not just the root table.
- RLS adds a predicate to every statement and needs supporting indexes (`tenant_id` first in composite indexes). Test policies with a non-superuser role; table owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set.
- Never use session-level `set_config(..., false)` with a connection pool — the value leaks to the next request that borrows the connection.
- The scoped object is still bound to one `PostgreSQLDatabase` instance; do not mix instances between the scope and the transaction.

---

## Pattern 6: Soft Delete and Restore with Shared Predicates

**Use this when** rows must be recoverable and "deleted" rows must never appear in normal reads, but you do not want every query to re-implement the exclusion rule.

**The scenario.** Deleting stamps `deleted_at`; active reads share one compiled expression built with `blendsdk/expression`; restore clears the stamp and surfaces the partial unique index if the email was taken in the meantime.

```typescript
import { query } from 'blendsdk/expression';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  tenant_id: number;
  email: string;
  name: string;
  role?: string;
  deleted_at?: Date | null;
  created_at?: Date;
}

interface UserFilter {
  id?: number;
  tenant_id?: number;
  email?: string;
  deleted_at?: Date | null;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

function activeUsersExpression() {
  return query<User>().where('deleted_at').isNull().compile();
}

async function softDelete(userId: number): Promise<User | null> {
  return db
    .update<User, UserFilter>('users')
    .values({ deleted_at: new Date() })
    .filterByExpression((q) => q.where('id').equals(userId).and('deleted_at').isNull())
    .returning('*')
    .executeReturnSingle();
}

async function restore(userId: number): Promise<User | null> {
  return db
    .update<User, UserFilter>('users')
    .values({ deleted_at: null })
    .filterByExpression((q) => q.where('id').equals(userId).and('deleted_at').isNotNull())
    .returning('*')
    .executeReturnSingle();
}

async function listActive(): Promise<User[]> {
  const result = await db
    .from<User>('users')
    .select(['id', 'email', 'name', 'role'])
    .byExpression(activeUsersExpression())
    .execute();
  return result?.records ?? [];
}

try {
  const deleted = await softDelete(1);
  console.log(`soft-deleted ${deleted?.email ?? 'nothing'}`);

  const active = await listActive();
  console.log(`active users: ${active.length}`);

  const restored = await restore(1);
  console.log(`restored ${restored?.email ?? 'nothing'}`);
} catch (error) {
  console.error('soft delete flow failed', error);
  throw error;
} finally {
  await db.disconnect();
}
```

The first UPDATE the builder sends:

```sql
UPDATE users
   SET deleted_at = :v_deleted_at
 WHERE id = :p1 AND deleted_at IS NULL
RETURNING *
```

**Why it works.**

- The `deleted_at IS NULL` predicate is part of the UPDATE, so two concurrent deletes cannot both claim the row — the second call receives `null` instead of overwriting the timestamp.
- The partial unique index `(tenant_id, email) WHERE deleted_at IS NULL` lets a deleted address be reused while an active one stays unique.
- `activeUsersExpression()` is compiled once per call and fed to `byExpression()` on the inherited FROM statement — the same shape of read every time, with the exclusion rule in one function.
- `deleted_at: Date | null` in the type mirrors the nullable column, so restore needs no cast, and the repository keeps strict typing.

Restoring can still collide with a reused address; the unique violation surfaces as SQLSTATE `23505`:

```typescript fragment
try {
  await restore(1);
} catch (error) {
  const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  if (code === '23505') {
    throw new Error('cannot restore: this email is already used by an active user');
  }
  throw error;
}
```

**Caveats and performance.**

- There is no global scope: every read path must include the predicate. Missing one leaks deleted rows. Consider a database view (`active_users`) or RLS for defense in depth.
- Soft delete does not cascade. `ON DELETE CASCADE` fires only on real deletes; children of a soft-deleted parent must be handled by the application or by triggers.
- Deleted rows and their indexes still consume space. Add a retention job that hard-deletes old rows with `db.delete()` (`filterByExpression(q => q.where('deleted_at').lessThan(cutoff))`).
- Filter on `deleted_at IS NULL` benefits from the partial index; a plain index on `(tenant_id, email, deleted_at)` also works for combined predicates.
- Keep the expression function pure and cheap; compiling it per request is fine, but do not rebuild it inside a loop over rows.

---

## Pattern 7: Bulk Imports — Batched Transactions vs. Set-Based SQL

**Use this when** a job imports thousands of rows and the naive per-row loop produces N round trips and a half-populated table when row 500 fails.

**Before** — each INSERT is its own transaction; a failure leaves earlier rows committed:

```typescript fragment
// ❌ N round trips, N commits, partial success on failure.
for (const row of rows) {
  await db.insert<StagingRow>('staging_rows').values(row).execute();
}
```

**After** — one transaction for atomicity, and a set-based INSERT per chunk to cut round trips:

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface StagingRow {
  id?: number;
  sku: string;
  quantity: number;
}

interface ImportRow {
  sku: string;
  quantity: number;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig: { max: 5 },
});

// One transaction, one commit, still one statement per row.
async function importInTransaction(rows: ImportRow[]): Promise<number> {
  return db.withTransaction(async (tx) => {
    let inserted = 0;
    for (const row of rows) {
      inserted += await tx.insert<StagingRow>('staging_rows').values(row).executeReturnCount();
    }
    return inserted;
  });
}

function buildBulkInsert(rows: ImportRow[]): {
  sql: string;
  params: Record<string, string | number>;
} {
  const params: Record<string, string | number> = {};
  const tuples = rows.map((row, index) => {
    params[`sku_${index}`] = row.sku;
    params[`quantity_${index}`] = row.quantity;
    return `(:sku_${index}, :quantity_${index})`;
  });

  return {
    sql: `INSERT INTO staging_rows (sku, quantity) VALUES ${tuples.join(', ')}`,
    params,
  };
}

// One transaction, one statement per chunk — all-or-nothing.
async function importSetBased(rows: ImportRow[], chunkSize = 500): Promise<number> {
  return db.withTransaction(async (tx) => {
    let inserted = 0;

    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      if (chunk.length === 0) {
        continue;
      }

      const { sql, params } = buildBulkInsert(chunk);
      const { rowCount } = await tx.executeQuery(sql, params);
      inserted += rowCount;
    }

    return inserted;
  });
}

const rows: ImportRow[] = [
  { sku: 'SKU-1', quantity: 3 },
  { sku: 'SKU-2', quantity: 5 },
  { sku: 'SKU-3', quantity: 1 },
];

try {
  const imported = await importSetBased(rows);
  console.log(`imported ${imported} rows atomically`);
} catch (error) {
  console.error('import rolled back; no rows were written', error);
  throw error;
} finally {
  await db.disconnect();
}
```

**Why it works.** The set-based INSERT is still fully parameterized: only developer-controlled tuple templates (`(:sku_0, :quantity_0), …`) are concatenated into SQL text; every value is bound through the parameter object, exactly as with hand-written `executeQuery` calls. One `executeQuery()` per chunk amortizes network round trips while one `withTransaction()` keeps the batch atomic — if any chunk fails, the whole import rolls back. `rowCount` from a multi-tuple INSERT reports the number of tuples inserted, so counting is free without `RETURNING`.

| Approach | Round trips | Atomic | Use when |
| --- | --- | --- | --- |
| `importRowByRow` | 1 per row + commits | No | Never for batches |
| `importInTransaction` | 1 per row | Yes | Rows need per-row builders/hooks |
| `importSetBased` | 1 per chunk | Yes | Homogeneous rows, throughput matters |

**Caveats and performance.**

- PostgreSQL accepts at most 65535 bind parameters per statement. Size chunks as `floor(65535 / columns_per_tuple)` and leave headroom.
- All chunks share one transaction: very large imports hold locks and generate WAL for the duration. Keep chunks moderate (hundreds to a few thousand rows) and consider splitting very large loads into several transactions with checkpointing.
- For hundreds of thousands of rows, `COPY` (via the `pg` ecosystem, outside this package) is faster than any INSERT form; reserve set-based INSERTs for thousands, not millions.
- Hooks attached to the set-based path must speak the generated parameter names (`sku_0`, `quantity_0`), which is why bulk loads often bypass the builders entirely.
- `executeReturnCount()` on an INSERT builder returns 1 per row; for set-based inserts use the result's `rowCount` instead.

---

## Pattern 8: Read Models with Hand-Written SQL Behind a Typed Function

**Use this when** a screen needs pagination, total counts or aggregates that the statement builders cannot express — and you still want named parameters, one typed entry point, and no SQL strings leaking into handlers.

**The scenario.** A search endpoint takes optional filters, returns a page and a total, and reads a consistent snapshot. Values are always bound; only developer-written fragments are concatenated.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserSummary {
  id: number;
  email: string;
  name: string;
  role: string;
}

interface SearchCriteria {
  tenantId: number;
  term?: string;
  role?: string;
  page: number;
  pageSize: number;
}

interface SearchResult {
  rows: UserSummary[];
  total: number;
  page: number;
  pageSize: number;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

async function searchUsers(criteria: SearchCriteria): Promise<SearchResult> {
  const conditions: string[] = ['tenant_id = :tenantId', 'deleted_at IS NULL'];
  const params: Record<string, string | number> = { tenantId: criteria.tenantId };

  if (criteria.term) {
    conditions.push('(email ILIKE :term OR name ILIKE :term)');
    params.term = `%${escapeLike(criteria.term)}%`;
  }
  if (criteria.role) {
    conditions.push('role = :role');
    params.role = criteria.role;
  }

  // Only fixed fragments and parameter names are concatenated — never values.
  const where = conditions.join(' AND ');

  return db.withTransaction(async (tx) => {
    const { records } = await tx.executeQuery<UserSummary>(
      `SELECT id, email, name, role
         FROM users
        WHERE ${where}
        ORDER BY id
        LIMIT :limit OFFSET :offset`,
      { ...params, limit: criteria.pageSize, offset: criteria.page * criteria.pageSize }
    );

    const countResult = await tx.executeQuery<{ total: string }>(
      `SELECT COUNT(*) AS total FROM users WHERE ${where}`,
      params
    );

    return {
      rows: records,
      total: Number(countResult.records[0]?.total ?? 0),
      page: criteria.page,
      pageSize: criteria.pageSize,
    };
  }, { isolation: 'repeatable read' });
}

try {
  const page = await searchUsers({
    tenantId: 7,
    term: 'ada',
    role: 'admin',
    page: 0,
    pageSize: 20,
  });
  console.log(`${page.total} matches, showing ${page.rows.length}`);
} finally {
  await db.disconnect();
}
```

**Why it works.** `LIMIT`/`OFFSET` accept bound parameters in PostgreSQL, so paging stays parameterized. The `repeatable read` transaction gives the page query and the count query the same snapshot — without it, an insert between the two queries makes the total disagree with the visible rows. When the filter shape is static, the inherited FROM statement is the better tool (pattern 6 uses `from().select().byExpression().execute()`); this pattern is for the cases it cannot express: recursion into aliases, pagination, window functions and aggregates.

For deep pages, keyset pagination scales better than a growing `OFFSET`:

```typescript fragment
const { records } = await db.executeQuery<UserSummary>(
  `SELECT id, email, name, role
     FROM users
    WHERE tenant_id = :tenantId AND deleted_at IS NULL AND id > :afterId
    ORDER BY id
    LIMIT :limit`,
  { tenantId: 7, afterId: 1000, limit: 20 }
);
```

**Caveats and performance.**

- Concatenate only fragments you wrote. Values must always go through the named-parameter object; the moment user input enters the template string, injection is back.
- Escape `%`, `_` and `\` in `LIKE`/`ILIKE` terms as shown; otherwise a user can turn `a%b` into an unintended pattern or force a full scan.
- `OFFSET` reads and discards every skipped row. For deep pagination use keyset paging; for fuzzy search add a `pg_trgm` GIN index or a dedicated search engine.
- The two-query count doubles work. `COUNT(*) OVER ()` computes the total in the same scan, at the cost of carrying it on every row; approximate counts are acceptable for many UIs.
- Read-only transactions still acquire a snapshot and a client. Keep them short, and do not hold one open while rendering a response.
- Verify index usage with `EXPLAIN (ANALYZE, BUFFERS)` for each filter combination the endpoint can produce.

---

## Pattern 9: Shutdown-Aware Job Worker

**Use this when** a background process consumes rows from a queue table and a deploy (SIGTERM) must not kill a job mid-transaction or lose the row it was processing.

**The scenario.** A worker claims one pending job with `FOR UPDATE SKIP LOCKED`, processes it, marks it done — all in one transaction. Successful and failed jobs are handled differently: a failure rolls back and a separate write marks the row failed. SIGTERM drains the loop and closes the pool.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Job {
  id?: number;
  status?: string;
  payload: string;
}

interface JobFilter {
  id?: number;
  status?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig: { max: 4, idleTimeoutMillis: 10000 },
});

async function processJob(
  job: { id: number; payload: string },
  tx: PostgreSQLDatabase
): Promise<void> {
  const parsed: unknown = JSON.parse(job.payload);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`job ${job.id} has an invalid payload`);
  }

  await tx.executeQuery(
    'INSERT INTO job_results (job_id, payload) VALUES (:job_id, :payload)',
    { job_id: job.id, payload: job.payload }
  );
}

async function claimAndProcessNextJob(): Promise<boolean> {
  let claimed: { id: number; payload: string } | undefined;

  try {
    return await db.withTransaction(async (tx) => {
      const { records } = await tx.executeQuery<{ id: number; payload: string }>(
        `UPDATE jobs
            SET status = 'processing'
          WHERE id = (
            SELECT id
              FROM jobs
             WHERE status = 'pending'
             ORDER BY id
             LIMIT 1
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, payload`
      );

      claimed = records[0];
      if (!claimed) {
        return false;
      }

      await processJob(claimed, tx);

      await tx
        .update<Job, JobFilter>('jobs')
        .values({ status: 'done' })
        .filter({ id: claimed.id })
        .execute();

      return true;
    });
  } catch (error) {
    if (claimed === undefined) {
      // Infrastructure failure before a job was claimed; let the worker fail.
      throw error;
    }

    // The transaction rolled back, so the row is pending again. Record the
    // failure outside the transaction so the compiler outcome is durable.
    console.error(`job ${claimed.id} failed`, error);
    await db
      .update<Job, JobFilter>('jobs')
      .values({ status: 'failed' })
      .filter({ id: claimed.id })
      .execute();
    return true;
  }
}

async function runWorker(): Promise<void> {
  let running = true;
  const stop = (): void => {
    running = false;
  };

  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    while (running) {
      const processed = await claimAndProcessNextJob();
      if (!processed) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await db.disconnect(15000);
  }
}

await runWorker();
```

**Why it works.**

- `FOR UPDATE SKIP LOCKED` in the subquery lets many workers run safely: each transaction locks exactly one pending row and skips rows other workers hold, with no duplicate processing and no blocking.
- The status change, the job's effects and the `job_results` insert share one transaction. A crash or error anywhere rolls all of it back, so the row returns to `pending` instead of being stuck in `processing`.
- Failed jobs are marked in a separate auto-commit write *after* the rollback. Attempting the update inside the aborted transaction would fail with "current transaction is aborted".
- The shutdown flag is checked between jobs, never inside one: the in-flight transaction finishes and commits, then the loop exits and `disconnect(15000)` drains the pool. `disconnect()` flips `isShuttingDown` first, so any late query or transaction is rejected with `Cannot execute a query: database is shutting down` rather than hanging.
- Signals are handled manually here, so `enableGracefulShutdown` must stay `false` — that option registers its own SIGINT/SIGTERM handlers that call `process.exit()` immediately, bypassing this drain loop. Never use it alongside `blendsdk/webafx` either, which owns the signal lifecycle for web applications.

**Caveats and performance.**

- Size the shutdown timeout above your slowest job. When it expires, `disconnect()` force-releases pooled clients with `release(true)`, destroying connections mid-query; that job rolls back and is retried by another worker.
- A worker that dies without running its `finally` leaves rows in `processing`. Add a reaper that resets rows whose claim is older than a threshold, or store a `claimed_at` timestamp.
- `SKIP LOCKED` gives throughput, not fairness or global ordering; do not assume FIFO across workers.
- Keep transactions short — long jobs hold a row lock and a pooled client. If a job calls external services, consider a claim/complete split with an idempotency key instead of wrapping the call in the transaction.
- A single worker with one sequential loop needs only `max: 2`–`4` pooled clients; parallelize with more worker processes rather than more in-process concurrency.

---

## Composing the Patterns

The patterns are designed to stack. A service-layer operation typically combines the unit of work (2) with structural scoping (5), a version guard (3) and the atomic audit trail (4):

```typescript fragment
await withRetry(
  () =>
    db.withTransaction(
      async (tx) => {
        await tenantUsers.disable(email);                      // structural tenant predicate
        await saveDocument(documentId, expectedVersion, changes); // optimistic version guard
        await audit.record({                                   // atomic audit trail
          actor,
          action: 'document.updated',
          entity: 'documents',
          entityId: documentId,
        });
      },
      { isolation: 'serializable' }
    ),
  3
);
```

| Layer | Patterns | Responsibility |
| --- | --- | --- |
| Handler / transport | — | Validate input, resolve the tenant from the authenticated identity |
| Service | 2 | One transaction per business action, retry only transient failures |
| Scoped access | 1, 5 | Normalization/PII policy and tenant predicates in one place |
| Concurrency | 3 | Reject stale writes with a version guard |
| Audit | 4 | The event and the change commit or roll back together |
| Reads | 6, 8 | Shared predicates for builders; hand-written SQL for pagination/aggregates |
| Lifecycle | 9 | Drain in-flight work before `disconnect()` |

Three rules keep the composition safe:

1. **Same instance.** Repositories, scoped accessors and audit writers must be constructed on the same `PostgreSQLDatabase` that opens the transaction; the async-local context is what makes their statements transactional.
2. **Retry only the unit of work.** `withRetry` wraps `withTransaction`, never statements inside it, and only SQLSTATE `40001`/`40P01` qualify as retryable.
3. **Idempotency outside the database.** Effects that leave PostgreSQL (emails, payments, webhooks) belong after commit or behind an outbox; a retried transaction must not repeat them.

---

# postgresql Common Scenarios

This document collects task-oriented recipes for the PostgreSQL adapter. Each scenario is a self-contained answer with a complete, runnable example. All examples are ESM modules that use top-level `await`, assume a reachable PostgreSQL server and a database where the referenced tables exist, and install the adapter through the BlendSDK umbrella (`npm install blendsdk`) before importing from `blendsdk/postgresql`.

---

## How do I connect to PostgreSQL and run my first query?

**Solution** — Construct a `PostgreSQLDatabase` with a `PostgreSQLConfig`, call `executeQuery()` (it acquires a pooled client for the call and releases it afterwards), and always call `disconnect()` in a `finally` block. The constructor does not open a socket; the first query does.

```typescript
import { PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const result: PostgreSQLQueryResult<{ answer: number }> = await db.executeQuery<{
    answer: number;
  }>('SELECT 42 AS answer');

  console.log(`rowCount=${result.rowCount} answer=${result.records[0]?.answer}`);
  console.log(`columns=${result.fields.map((field) => field.name).join(', ')}`);
} finally {
  await db.disconnect();
}
```

---

## How do I pass named parameters to a query?

**Solution** — Write `:name` placeholders in the SQL and pass a plain object of values. The adapter rewrites the placeholders into the driver's positional parameters for you, so you never count `$1`, `$2`, … by hand.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface GreetingRow {
  greeting: string;
  created_at: Date;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const { records, rowCount } = await db.executeQuery<GreetingRow>(
    'SELECT :name AS greeting, now() AS created_at',
    { name: 'BlendSDK' }
  );

  console.log(`rowCount=${rowCount}`);
  console.log(`greeting=${records[0]?.greeting}`);
  console.log(`created_at=${records[0]?.created_at.toISOString()}`);
} finally {
  await db.disconnect();
}
```

Notes:

- Every parameter used in the SQL must exist in the object — a missing key produces an execution error from the driver, not a silent `NULL`.
- Cast bound values in SQL when PostgreSQL needs a type, for example `:payload::jsonb` or `:amount::numeric`.

---

## How do I prevent SQL injection?

**Solution** — Never concatenate values into SQL text. Named parameters are always sent as bound values, so hostile input is treated as a literal. The test suite asserts exactly this: a `"'; DROP TABLE …; --"` value matches zero rows and the table survives.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const maliciousInput = "'; DROP TABLE users; --";

  const { records, rowCount } = await db.executeQuery<{ id: number; name: string }>(
    'SELECT id, name FROM users WHERE name = :name',
    { name: maliciousInput }
  );

  // The input is a literal value, not SQL: zero rows match and `users` still exists.
  console.log(`rowCount=${rowCount} records=${records.length}`);

  const { rowCount: schemaCheck } = await db.executeQuery('SELECT 1 FROM users LIMIT 1');
  console.log(`users table still queryable: rowCount=${schemaCheck}`);
} finally {
  await db.disconnect();
}
```

Identifiers (table and column names) cannot be bound as parameters. When they must be dynamic, validate them against an allowlist before building the SQL string:

```typescript fragment
const sortableColumns = new Set(['name', 'email', 'created_at']);
if (!sortableColumns.has(requestedColumn)) {
  throw new Error(`Unsupported sort column: ${requestedColumn}`);
}
const sql = `SELECT * FROM users ORDER BY ${requestedColumn}`;
```

---

## What happens when a query returns no rows?

**Solution** — `executeQuery()` short-circuits on zero affected rows: it resolves with `records: []`, `rowCount: 0` and `fields: []`, and it does **not** invoke `afterQuery`. Check `rowCount` before touching column metadata or relying on row mapping.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const result = await db.executeQuery<UserRow>(
    'SELECT id, name FROM users WHERE id = :id',
    { id: -1 },
    {
      afterQuery: (rows) =>
        // This mapper never runs when rowCount === 0.
        rows.map((row) => ({ id: Number(row.id), name: String(row.name) })),
    }
  );

  if (result.rowCount === 0) {
    console.log('no rows: records=[], fields=[], afterQuery skipped');
  } else {
    console.log(`first match: ${result.records[0]?.name}`);
  }
} finally {
  await db.disconnect();
}
```

---

## How do I configure the connection pool?

**Solution** — Add a `poolConfig` object to the configuration. `max`, `idleTimeoutMillis` and `connectionTimeoutMillis` map directly onto the node-postgres pool; omitted fields fall back to node-postgres defaults (10 clients, 30 s idle, no connect timeout). A numeric string for `port` is accepted.

```typescript
import { PoolConfig, PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const poolConfig: PoolConfig = {
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: '5432',
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig,
};

const db = new PostgreSQLDatabase(config);

try {
  const { rowCount } = await db.executeQuery('SELECT 1');
  console.log(`pool ready, rowCount=${rowCount}`);
} finally {
  await db.disconnect();
}
```

- Size `max` to the database's connection limit divided by the number of application instances.
- Set `connectionTimeoutMillis` so a misbehaving server fails fast instead of hanging requests.

---

## How do I insert a row and get the created record back?

**Solution** — Chain `.values()` with `.returning('*')` and finish with `.executeReturnSingle()`. The INSERT and the read-back happen in a single round trip. Use `.executeReturnCount()` when you only need the affected-row count.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
  created_at?: Date;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const created = await db
    .insert<User>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com', active: true })
    .returning(['id', 'name', 'email'])
    .executeReturnSingle();

  if (created) {
    console.log(`inserted user ${created.id}: ${created.name} <${created.email}>`);
  }

  const insertedCount = await db
    .insert<User>('users')
    .values({ name: 'Grace Hopper', email: 'grace@example.com' })
    .executeReturnCount();

  console.log(`inserted rows: ${insertedCount}`);
} finally {
  await db.disconnect();
}
```

Call `.returning(...)` before `executeReturnSingle()` / `executeReturnAll()` — without a `RETURNING` clause PostgreSQL sends no rows back. Calling `.values({})` throws `Cannot build INSERT statement for table "users": no values provided.` before any SQL reaches the server.

---

## How do I update the rows that match a filter?

**Solution** — Separate the SET payload (`.values()`) from the WHERE clause (`.filter()` or `.filterByExpression()`), and add `.returning(...)` plus a terminator when you want the updated rows back. SET values are bound as `:v_<column>` and filter values as `:p1`, `:p2`, …, so a column may appear on both sides without a parameter collision.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
  updated_at?: Date;
}

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const updated = await db
    .update<User, UserFilter>('users')
    .values({ active: false })
    .filter({ email: 'ada@example.com' })
    .returning('*')
    .executeReturnAll();

  console.log(`updated ${updated.length} row(s)`);

  const renamedCount = await db
    .update<User, UserFilter>('users')
    .values({ name: 'Ada Byron' })
    .filter({ id: 1, active: true })
    .executeReturnCount();

  console.log(`renamed rows: ${renamedCount}`);
} finally {
  await db.disconnect();
}
```

Generated SQL for the first statement: `UPDATE users SET active = :v_active WHERE email = :p1 RETURNING *`. Calling `.values({})` throws `Cannot build UPDATE statement for table "users": no values provided.`

---

## How do I delete rows and know how many were removed?

**Solution** — Use `db.delete<F>()` with a filter and terminate with `executeReturnCount()`. `executeReturnSingle()` returns the first deleted row (or `null`), and `executeReturnAll()` returns every deleted row — both require `.returning(...)`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  id?: number;
  user_id?: number;
  revoked?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const removed = await db
    .delete<SessionFilter>('sessions')
    .filter({ user_id: 7, revoked: false })
    .executeReturnCount();

  console.log(`deleted ${removed} session(s)`);

  const lastDeleted = await db
    .delete<SessionFilter>('sessions')
    .filterByExpression((q) => q.where('revoked').equals(true))
    .returning('*')
    .executeReturnSingle();

  console.log(lastDeleted ? `last purged session: ${JSON.stringify(lastDeleted)}` : 'nothing to purge');
} finally {
  await db.disconnect();
}
```

Generated SQL for the first statement: `DELETE FROM sessions WHERE user_id = :p1 AND revoked = :p2`.

---

## How do I avoid accidentally deleting or updating every row?

**Solution** — Both `filter({})` and “never called `filter`” compile to a statement with **no WHERE clause**, which affects every row in the table (`DELETE FROM sessions`, `UPDATE users SET active = :v_active`). Guard destructive bulk writes by running them inside a transaction that first counts the expected rows and throws on a mismatch, so the rollback undoes the delete.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  revoked?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const deleted = await db.withTransaction(async (tx) => {
    const { records } = await tx.executeQuery<{ count: string }>(
      'SELECT COUNT(*) AS count FROM sessions WHERE revoked = :revoked',
      { revoked: true }
    );
    const expected = Number(records[0]?.count ?? '0');

    if (expected === 0) {
      return 0;
    }

    const actual = await tx
      .delete<SessionFilter>('sessions')
      .filter({ revoked: true })
      .executeReturnCount();

    if (actual !== expected) {
      // Throwing rolls the transaction back, so the delete is undone.
      throw new Error(`expected to delete ${expected} sessions but deleted ${actual}`);
    }

    return actual;
  });

  console.log(`verified bulk delete of ${deleted} session(s)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await db.disconnect();
}
```

Prefer `.filterByExpression()` over `.filter({})` for intentional bulk operations — the expression makes the intent explicit and the compiler cannot collapse it into “no WHERE clause” by accident.

---

## How do I run several statements atomically in a transaction?

**Solution** — Wrap the work in `withTransaction(async (tx) => …)`. Statements issued from `tx` run on the transaction's dedicated client; the callback's return value resolves after `COMMIT`, and any thrown error triggers `ROLLBACK` and rejects the promise.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface BalanceRow {
  balance: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const destinationBalance = await db.withTransaction(async (tx) => {
    await tx.executeQuery(
      'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
      { amount: 100, id: 1 }
    );
    await tx.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :id',
      { amount: 100, id: 2 }
    );

    const { records } = await tx.executeQuery<BalanceRow>(
      'SELECT balance FROM accounts WHERE id = :id',
      { id: 2 }
    );
    return records[0]?.balance ?? '0';
  });

  console.log(`transfer committed, destination balance: ${destinationBalance}`);
} catch (error) {
  console.error('transfer rolled back', error);
  throw error;
} finally {
  await db.disconnect();
}
```

Statements built from the handle (`tx.insert(...)`, `tx.delete(...)`) use the same transaction client, so builders and raw SQL can be mixed freely inside the callback.

---

## How do I choose a transaction isolation level?

**Solution** — Pass `{ isolation }` as the second argument of `withTransaction()`. Only `'read committed'`, `'repeatable read'` and `'serializable'` are accepted; the value is validated against an allowlist before a client is acquired, so it can never inject SQL into `BEGIN`.

```typescript
import { PostgreSQLDatabase, TransactionIsolation } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const isolation: TransactionIsolation = 'serializable';

try {
  const level = await db.withTransaction(
    async (tx) => {
      const { records } = await tx.executeQuery<{ transaction_isolation: string }>(
        'SHOW transaction_isolation'
      );
      return records[0]?.transaction_isolation ?? '';
    },
    { isolation }
  );

  console.log(`transaction ran at isolation level: ${level}`);

  try {
    await db.withTransaction(async () => 'never runs', {
      isolation: 'read uncommitted' as TransactionIsolation,
    });
  } catch (error) {
    // "Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable"."
    console.error(error instanceof Error ? error.message : String(error));
  }
} finally {
  await db.disconnect();
}
```

Omit the option entirely to use PostgreSQL's default (`read committed`).

---

## What happens if I start a transaction inside a transaction?

**Solution** — It is rejected immediately. PostgreSQL has no nested `BEGIN`, and silently reusing the outer transaction would hide a logic bug, so `withTransaction()` throws `Cannot start a nested transaction: a transaction is already active on this database handle.` Restructure the work into one transaction or into sequential transactions.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  try {
    await db.withTransaction(async (tx) => {
      await tx.executeQuery('SELECT 1');
      // The same instance already has an active transaction on this call chain.
      await tx.withTransaction(async () => 'nested');
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }

  // The failed attempt did not poison the pool: a new transaction works.
  await db.withTransaction(async (tx) => {
    await tx.executeQuery('SELECT 2');
  });
  console.log('follow-up transaction committed');
} finally {
  await db.disconnect();
}
```

A detached task that outlives the callback gets a different message — `Cannot execute a query after the transaction has completed. Do not use the transaction handle outside its callback.` — because the client has already been returned to the pool.

---

## How do I return computed values from an INSERT, UPDATE or DELETE?

**Solution** — The builder's `.returning()` accepts `'*'` or a list of column names only. For expressions (concatenations, `CASE`, JSON extraction), run the write through `executeQuery()` with a `RETURNING` clause — it uses the same named-parameter pipeline and hooks.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface CreatedUserRow {
  id: number;
  full_name: string;
  created_at: Date;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const { records, rowCount } = await db.executeQuery<CreatedUserRow>(
    `INSERT INTO users (first_name, last_name)
     VALUES (:first_name, :last_name)
     RETURNING id, first_name || ' ' || last_name AS full_name, created_at`,
    { first_name: 'Ada', last_name: 'Lovelace' }
  );

  console.log(`rowCount=${rowCount} created=${records[0]?.full_name} (id ${records[0]?.id})`);

  const updated = await db.executeQuery<{ id: number; age_group: string }>(
    `UPDATE users
        SET active = :active
      WHERE id = :id
      RETURNING id, CASE WHEN age < 18 THEN 'minor' ELSE 'adult' END AS age_group`,
    { active: false, id: 1 }
  );

  console.log(`updated row group: ${updated.records[0]?.age_group}`);
} finally {
  await db.disconnect();
}
```

---

## How do I express complex WHERE conditions (OR, IN, LIKE, BETWEEN, NULL checks)?

**Solution** — Use `.filterByExpression()` on an update or delete builder. The callback receives an expression builder with `equals`, `greaterThan`, `lessThan`, `in`, `like`, `between`, `isNull` and `isNotNull`, plus nested `and(...)` / `or(...)` groups. Filter values are bound as `p1`, `p2`, … exactly like `.filter()`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
  active?: boolean;
}

interface UserFilter {
  id?: number;
  email?: string;
  age?: number;
  active?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  // active = true AND (age < 18 OR age > 65)
  const deactivated = await db
    .update<User, UserFilter>('users')
    .values({ active: false })
    .filterByExpression((q) =>
      q
        .where('active')
        .equals(true)
        .and((inner) => inner.where('age').lessThan(18).or('age').greaterThan(65))
    )
    .executeReturnCount();

  console.log(`deactivated ${deactivated} out-of-range account(s)`);

  // email IN (...)
  const purged = await db
    .delete<UserFilter>('users')
    .filterByExpression((q) => q.where('email').in(['ada@example.com', 'grace@example.com']))
    .executeReturnCount();

  console.log(`purged ${purged} account(s)`);

  // LIKE
  const matched = await db
    .delete<UserFilter>('users')
    .filterByExpression((q) => q.where('email').like('%@example.com'))
    .executeReturnCount();

  console.log(`matched by LIKE: ${matched}`);
} finally {
  await db.disconnect();
}
```

Use plain `.filter({...})` for simple equality conditions; reach for `.filterByExpression()` when you need operators or grouping.

---

## How do I transform parameters and strip sensitive fields with hooks?

**Solution** — Chain `.beforeQuery()` to rewrite bound parameters (normalize input, hash secrets) and `.afterQuery()` to rewrite returned rows (remove PII, coerce values). Parameter keys depend on the statement: column names for INSERT, `v_<column>` for UPDATE values, `p1…pN` for filters, and your own keys for raw SQL.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
  created_at?: Date;
}

interface SafeUser {
  id: number;
  name: string;
  email: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  const created = await db
    .insert<User>('users')
    .values({ name: 'Ada', email: 'ADA@EXAMPLE.COM', password_hash: 'plaintext123' })
    .beforeQuery((params) => {
      const next = { ...params };
      if (typeof next.email === 'string') {
        next.email = next.email.toLowerCase();
      }
      if (typeof next.password_hash === 'string') {
        next.password_hash = `sha256:${next.password_hash}`;
      }
      return next;
    })
    .afterQuery((rows): SafeUser[] =>
      rows.map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        email: String(row.email),
      }))
    )
    .returning('*')
    .executeReturnSingle();

  console.log(`created ${created?.id}: ${created?.email}`); // email is normalized, hash never leaves the DB layer
} finally {
  await db.disconnect();
}
```

The same hooks are available on `executeQuery()` through its third argument (`{ beforeQuery, afterQuery }`). An exception thrown inside a hook propagates out of the terminator and, inside a transaction, causes a rollback. Remember that `afterQuery` is skipped when `rowCount === 0`.

---

## How do I share one database instance across concurrent requests?

**Solution** — Share a single `PostgreSQLDatabase` and call `withTransaction()` per request. Transactions are scoped with `AsyncLocalStorage`, so each callback owns its pooled client: concurrent requests never read, commit, roll back or release each other's connections. Non-transactional `executeQuery()` calls each acquire and release their own client.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig: { max: 10 },
});

const emails = ['ada@example.com', 'grace@example.com', 'alan@example.com'];

try {
  const pids = await Promise.all(
    emails.map((email) =>
      db.withTransaction(async (tx) => {
        const { records } = await tx.executeQuery<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid'
        );
        await tx.executeQuery('UPDATE users SET last_seen = now() WHERE email = :email', {
          email,
        });
        return records[0]?.pid ?? 0;
      })
    )
  );

  console.log(`transactions=${pids.length} distinct sessions=${new Set(pids).size}`);

  // Plain queries are equally safe: every call owns its connection.
  const counts = await Promise.all(
    emails.map((email) =>
      db.executeQuery<{ count: string }>(
        'SELECT COUNT(*) AS count FROM users WHERE email = :email',
        { email }
      )
    )
  );

  console.log(counts.map((result) => result.records[0]?.count ?? '0').join(', '));
} finally {
  await db.disconnect();
}
```

Two rules keep this safe: never reuse the `tx` handle after its callback settles (that call is rejected), and never share a raw `PoolClient` from `connect()` between requests — that bypasses the adapter's ownership tracking.

---

## How do I shut the database down cleanly?

**Solution** — Call `disconnect(timeoutMs)`, which flips the shutdown flag, drains the pool, and force-releases clients if the timeout expires. Because the flag is sticky, queries and transactions that arrive after shutdown starts are rejected — not queued — and the instance is not reusable.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig: { max: 10, connectionTimeoutMillis: 5000 },
  // enableGracefulShutdown registers SIGINT/SIGTERM handlers — never use it
  // for a database managed by a WebApplication from blendsdk/webafx.
  enableGracefulShutdown: false,
});

await db.executeQuery('SELECT 1');
console.log('query before shutdown succeeded');

await db.disconnect(5000);
console.log('pool drained');

try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  // "Cannot execute query: database is shutting down"
  console.error(error instanceof Error ? error.message : String(error));
}

try {
  await db.withTransaction(async () => 'never runs');
} catch (error) {
  // "Cannot start transaction: database is shutting down"
  console.error(error instanceof Error ? error.message : String(error));
}
```

Wrap `disconnect()` in your process's shutdown path (or a `finally` block in scripts) so timers and sockets do not keep the event loop alive.

---

Related documents: the Overview for capabilities and dependencies, and Core Concepts for the detailed behavior behind each recipe.

---

# postgresql Examples Library

This library collects copy-paste ready examples for `blendsdk/postgresql`, grouped by feature area and ordered from simple to complex within each category. Every example is a complete ES module: it includes all imports, creates its own `PostgreSQLDatabase` instance, sets up any tables it needs with temporary tables, and disconnects the pool when done. Examples use top-level `await` (supported by Node.js >= 22) and assume a reachable PostgreSQL server with a `testdb` database.

The package is installed as part of the `blendsdk` umbrella:

```bash
npm install blendsdk
```

| Category | What It Covers |
| --- | --- |
| Connection and Pool Management | Instances, pool tuning, raw clients, shutdown |
| Query Execution | Named parameters, results, metadata, data types, concurrency |
| Transactions | Commit, rollback, isolation levels, nesting, concurrency |
| INSERT Statements | RETURNING, counts, partial returns, JSON/array values |
| UPDATE Statements | Equality filters, expression filters, bulk updates |
| DELETE Statements | Equality filters, expression filters, bulk deletes |
| SELECT and FROM Statements | Column aliases, expression-filtered selects |
| Query Hooks | `beforeQuery`, `afterQuery`, combined usage |
| Security and Error Handling | Injection prevention, validation errors |

---

## Connection and Pool Management

### Create a Database Instance

The constructor stores the configuration and creates a `pg.Pool`; no connection is opened until the first query.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
};

const db = new PostgreSQLDatabase(config);

const { records, rowCount } = await db.executeQuery<{ result: number }>('SELECT 1 AS result');

console.log(`rowCount=${rowCount}`);         // rowCount=1
console.log(`result=${records[0]?.result}`); // result=1

await db.disconnect();
```

### Configure the Connection Pool

`poolConfig` tunes the node-postgres pool. Omitted fields fall back to the driver defaults (`max` 10, `idleTimeoutMillis` 30000, `connectionTimeoutMillis` 0 — no timeout). `port` also accepts a numeric string.

```typescript
import { PoolConfig, PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const poolConfig: PoolConfig = {
  max: 20,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 5000,
};

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: '5432',
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
  poolConfig,
};

const db = new PostgreSQLDatabase(config);

const { rowCount } = await db.executeQuery('SELECT 1');
console.log(`connected with max=20 pool clients, rowCount=${rowCount}`);

await db.disconnect();
```

### Borrow a Raw Pooled Client

`connect()` hands out a pooled `PoolClient` the caller owns and must release. This bypasses named-parameter conversion, hooks, and result normalization — use it only for driver-level access.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const client = await db.connect();
try {
  const raw = await client.query('SELECT 1 AS value');
  console.log(raw.rows[0]); // { value: 1 }
} finally {
  client.release();
}

await db.disconnect();
```

### Disconnect and Reject New Work

`disconnect()` sets the shutdown flag before draining the pool, so any query or transaction started afterwards fails immediately instead of hanging. The optional argument is the timeout in milliseconds (default `10000`).

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

await db.executeQuery('SELECT 1');

// Drain the pool, giving in-flight work five seconds to finish.
await db.disconnect(5000);

try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // → Cannot execute query: database is shutting down
}
```

### Enable Graceful Shutdown Handlers

For standalone processes, `enableGracefulShutdown` registers SIGINT/SIGTERM handlers that close the pool and exit.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
  enableGracefulShutdown: true,
});

const { rowCount } = await db.executeQuery('SELECT 1');
console.log(`rowCount=${rowCount}`);

// On SIGINT or SIGTERM the adapter awaits disconnect() and exits the process.
```

> **Warning:** never enable this when the database is managed by a `WebApplication` from `blendsdk/webafx` — the web framework already owns SIGINT/SIGTERM, and installing both handlers causes conflicting shutdown behavior.

---

## Query Execution

### Query with Named Parameters

Placeholders written as `:name` are rewritten into the driver's positional `$1…$n` form by `yesql`; values are always bound, never concatenated into SQL text.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const { records, rowCount } = await db.executeQuery<{ name: string; time: Date }>(
  'SELECT :name AS name, now() AS time',
  { name: 'john' }
);

console.log(rowCount);         // 1
console.log(records[0]?.name); // john
console.log(records[0]?.time); // e.g. 2024-06-01T10:30:00.000Z

await db.disconnect();
```

### Read Column Metadata

`PostgreSQLQueryResult<T>` exposes `fields`, the driver's raw column definitions, alongside `records` and `rowCount`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const result = await db.executeQuery<{ id: number; name: string; active: boolean }>(
  'SELECT 1 AS id, :name AS name, true AS active',
  { name: 'test' }
);

console.log(result.fields.map((field) => field.name)); // [ 'id', 'name', 'active' ]

await db.disconnect();
```

### Handle Empty Result Sets

When `rowCount` is `0`, the adapter returns early with empty `records` and `fields`, and any `afterQuery` hook is skipped. Running the setup inside one transaction keeps all statements on the same pooled client.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const result = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE empty_test (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100)
    )
  `);

  return tx.executeQuery<{ id: number; name: string }>(
    'SELECT * FROM empty_test WHERE id = :id',
    { id: 999 }
  );
});

console.log(result.records);  // []
console.log(result.rowCount); // 0
console.log(result.fields);   // []

await db.disconnect();
```

### Work with Complex Data Types

Named parameters followed by PostgreSQL casts (`:value::jsonb`) let you send structured values; `pg` serializes objects and arrays for `jsonb`/array columns automatically.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface TypeShowcase {
  text_val: string;
  int_val: number;
  float_val: string;
  bool_val: boolean;
  json_val: { key: string; nested: { count: number } };
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const { records } = await db.executeQuery<TypeShowcase>(
  `SELECT
     :text_val::text AS text_val,
     :int_val::integer AS int_val,
     :float_val::numeric AS float_val,
     :bool_val::boolean AS bool_val,
     :json_val::jsonb AS json_val`,
  {
    text_val: 'hello world',
    int_val: 42,
    float_val: 3.14,
    bool_val: true,
    json_val: { key: 'value', nested: { count: 123 } },
  }
);

const row = records[0];
console.log(row?.int_val);              // 42
console.log(row?.float_val);            // '3.14' — numeric columns arrive as strings
console.log(row?.json_val.nested.count); // 123

await db.disconnect();
```

### Run Concurrent Queries

Each non-transactional `executeQuery()` acquires its own pooled client, so parallel calls never share or release each other's connection.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const results = await Promise.all(
  Array.from({ length: 10 }, (_, index) =>
    db.executeQuery<{ num: number }>('SELECT (:num)::int AS num', { num: index })
  )
);

console.log(results.map((result) => result.records[0]?.num)); // [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

await db.disconnect();
```

---

## Transactions

### Commit Work in a Transaction

`withTransaction()` wraps the callback in BEGIN/COMMIT, resolves with the callback's return value, and always releases the client back to the pool.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const created = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE tx_users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL
    )
  `);

  const { records } = await tx.executeQuery<{ id: number; name: string; email: string }>(
    'INSERT INTO tx_users (name, email) VALUES (:name, :email) RETURNING id, name, email',
    { name: 'John Doe', email: 'john@example.com' }
  );

  return records[0];
});

console.log(created); // { id: 1, name: 'John Doe', email: 'john@example.com' }

await db.disconnect();
```

### Roll Back a Failed Transaction

Throwing inside the callback triggers `ROLLBACK`; nothing written in the callback survives. (TEMP tables are session-scoped, so this sequential snippet reuses one pooled connection for all statements.)

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

await db.executeQuery(`
  CREATE TEMP TABLE rollback_products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10,2) NOT NULL
  )
`);

await db.executeQuery('INSERT INTO rollback_products (name, price) VALUES (:name, :price)', {
  name: 'Initial Product',
  price: 10.0,
});

try {
  await db.withTransaction(async (tx) => {
    await tx.executeQuery('INSERT INTO rollback_products (name, price) VALUES (:name, :price)', {
      name: 'Should Be Rolled Back',
      price: 20.0,
    });

    throw new Error('Intentional error to test rollback');
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // → Intentional error to test rollback
}

const { rowCount } = await db.executeQuery('SELECT * FROM rollback_products');
console.log(rowCount); // 1 — only the initial row survived

await db.disconnect();
```

### Use a Specific Isolation Level

`TransactionOptions.isolation` accepts `'read committed'`, `'repeatable read'`, or `'serializable'`. The value is validated against an allowlist and mapped to its SQL spelling before `BEGIN`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const isolation = await db.withTransaction(
  async (tx) => {
    const { records } = await tx.executeQuery<{ transaction_isolation: string }>(
      'SHOW transaction_isolation'
    );
    return records[0]?.transaction_isolation;
  },
  { isolation: 'serializable' }
);

console.log(isolation); // serializable

await db.disconnect();
```

### Reject a Nested Transaction

PostgreSQL has no nested `BEGIN`; a transaction started from inside an active transaction callback fails fast with a clear error instead of silently reusing the outer transaction.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

await db.withTransaction(async () => {
  try {
    await db.withTransaction(async () => 'nested');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    // → Cannot start a nested transaction: a transaction is already active on this database handle.
  }
});

await db.disconnect();
```

### Run Transactions Concurrently

Because transaction clients are tracked in async-local storage, concurrent `withTransaction()` calls on one shared instance run on separate PostgreSQL sessions.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const pids = await Promise.all([
  db.withTransaction(async (tx) => {
    const { records } = await tx.executeQuery<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await tx.executeQuery('SELECT pg_sleep(0.05)');
    return records[0]?.pid;
  }),
  db.withTransaction(async (tx) => {
    const { records } = await tx.executeQuery<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return records[0]?.pid;
  }),
]);

console.log(pids[0] !== pids[1]); // true — each transaction owns its own connection

await db.disconnect();
```

---

## INSERT Statements

### Insert and Return the Created Row

`returning('*')` combined with `executeReturnSingle()` inserts and reads the row back in one round trip.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const created = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      active BOOLEAN DEFAULT true
    )
  `);

  // INSERT INTO users (name, email, active) VALUES (:name, :email, :active) RETURNING *
  return tx
    .insert<User>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com', active: true })
    .returning('*')
    .executeReturnSingle();
});

console.log(created); // { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', active: true }

await db.disconnect();
```

### Insert and Count Affected Rows

`executeReturnCount()` resolves with the number of inserted rows — useful when you do not need the row data back.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const insertedRows = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE counters (
      id SERIAL PRIMARY KEY,
      label VARCHAR(100) NOT NULL
    )
  `);

  return tx
    .insert<{ label: string }>('counters')
    .values({ label: 'count me' })
    .executeReturnCount();
});

console.log(insertedRows); // 1

await db.disconnect();
```

### Return Specific Columns After INSERT

Pass an explicit column list to `returning()` to trim the response payload.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const insertedUser = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE partial_users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL
    )
  `);

  return tx
    .insert<User>('partial_users')
    .values({ name: 'Alan Turing', email: 'alan@example.com' })
    .returning(['id', 'name'])
    .executeReturnSingle();
});

console.log(insertedUser); // { id: 1, name: 'Alan Turing' }

await db.disconnect();
```

### Insert JSON and Array Values

JavaScript objects and arrays map naturally onto `JSONB` and `TEXT[]` columns; `executeReturnAll()` returns the inserted rows as an array.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface DocumentRow {
  id?: number;
  name: string;
  metadata: { settings: { theme: string }; preferences: string[] };
  tags: string[];
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const insertedDocuments = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE documents (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      metadata JSONB,
      tags TEXT[]
    )
  `);

  return tx
    .insert<DocumentRow>('documents')
    .values({
      name: 'Complex Returning Test',
      metadata: { settings: { theme: 'dark' }, preferences: ['email', 'sms'] },
      tags: ['test', 'complex', 'returning'],
    })
    .returning('*')
    .executeReturnAll();
});

console.log(insertedDocuments[0]?.metadata); // { settings: { theme: 'dark' }, preferences: [ 'email', 'sms' ] }
console.log(insertedDocuments[0]?.tags);     // [ 'test', 'complex', 'returning' ]

await db.disconnect();
```

---

## UPDATE Statements

### Update with a Filter and RETURNING

`values()` builds the SET clause; its parameters are prefixed with `v_`, while filter parameters are named `p1`, `p2`, … — so a column can appear on both sides without conflict.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
}

interface UserFilter {
  email?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const updated = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      age INTEGER
    )
  `);

  await tx.executeQuery('INSERT INTO users (name, email, age) VALUES (:name, :email, :age)', {
    name: 'Original Name',
    email: 'update@example.com',
    age: 25,
  });

  // UPDATE users SET name = :v_name, age = :v_age WHERE email = :p1 RETURNING *
  return tx
    .update<User, UserFilter>('users')
    .values({ name: 'Updated Name', age: 26 })
    .filter({ email: 'update@example.com' })
    .returning('*')
    .executeReturnSingle();
});

console.log(updated); // { id: 1, name: 'Updated Name', email: 'update@example.com', age: 26 }

await db.disconnect();
```

### Update Rows Matching an Expression

`filterByExpression()` builds the WHERE clause from the expression builder, which supports `AND`/`OR`, `IN`, `LIKE`, `BETWEEN`, and `IS NULL` — beyond the equality-only `filter()`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Customer {
  id?: number;
  name?: string;
  age?: number;
  status?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const updatedCount = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE customers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      age INTEGER NOT NULL,
      status VARCHAR(20) DEFAULT 'active'
    )
  `);

  await tx.executeQuery(
    `INSERT INTO customers (name, age) VALUES
       ('Young Customer', 25),
       ('Senior Customer', 70)`
  );

  return tx
    .update<Customer, { age?: number }>('customers')
    .values({ status: 'senior' })
    .filterByExpression((q) => q.where('age').greaterThan(65))
    .executeReturnCount();
});

console.log(updatedCount); // 1

await db.disconnect();
```

### Bulk Update Without a Filter

Omitting `filter()` produces an `UPDATE` with no WHERE clause and touches **every row** in the table. An empty `values()` object throws before any SQL is sent.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const affected = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE bulk_users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      active BOOLEAN DEFAULT true
    )
  `);

  await tx.executeQuery(`INSERT INTO bulk_users (name) VALUES ('User 1'), ('User 2'), ('User 3')`);

  // No .filter() call: every row is updated.
  return tx
    .update<{ active?: boolean }, { active?: boolean }>('bulk_users')
    .values({ active: false })
    .executeReturnCount();
});

console.log(affected); // 3

await db.disconnect();
```

---

## DELETE Statements

### Delete with a Filter and RETURNING

`returning('*')` gives you the deleted rows back, so you can log or audit exactly what was removed.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionRow {
  id?: number;
  user_id?: number;
  revoked?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const deleted = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      revoked BOOLEAN DEFAULT false
    )
  `);

  await tx.executeQuery(
    `INSERT INTO sessions (user_id, revoked) VALUES
       (7, false),
       (7, true)`
  );

  // DELETE FROM sessions WHERE user_id = :p1 AND revoked = :p2 RETURNING *
  return tx
    .delete<SessionRow>('sessions')
    .filter({ user_id: 7, revoked: false })
    .returning('*')
    .executeReturnSingle();
});

console.log(deleted); // { id: 1, user_id: 7, revoked: false }

await db.disconnect();
```

### Delete Rows Matching an Expression

Combine `filterByExpression()` with `executeReturnCount()` to purge rows with complex conditions and report how many were removed.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionRow {
  id?: number;
  user_id?: number;
  revoked?: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const purged = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE revoked_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      revoked BOOLEAN DEFAULT false
    )
  `);

  await tx.executeQuery(
    `INSERT INTO revoked_sessions (user_id, revoked) VALUES
       (7, false),
       (8, true),
       (9, true)`
  );

  return tx
    .delete<SessionRow>('revoked_sessions')
    .filterByExpression((q) => q.where('revoked').equals(true))
    .executeReturnCount();
});

console.log(purged); // 2

await db.disconnect();
```

### Bulk Delete Without a Filter

A DELETE builder has no values payload, so there is no empty-values validation. Skipping `filter()` — or passing `filter({})` — compiles to `DELETE FROM <table>` and removes **every row**.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const removed = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE scratch_pad (
      id SERIAL PRIMARY KEY,
      value TEXT
    )
  `);

  await tx.executeQuery(`INSERT INTO scratch_pad (value) VALUES ('a'), ('b'), ('c')`);

  // No filter: DELETE FROM scratch_pad
  return tx.delete<{ id?: number }>('scratch_pad').executeReturnCount();
});

console.log(removed); // 3

await db.disconnect();
```

---

## SELECT and FROM Statements

### Select Rows with Column Aliases

Alias columns in the projection to shape results for the consumer without touching the schema.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const result = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE aliased_users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) NOT NULL
    )
  `);

  await tx.executeQuery(
    `INSERT INTO aliased_users (name, email) VALUES ('Alias Test', 'alias@example.com')`
  );

  return tx.executeQuery<{ user_id: number; user_name: string; user_email: string }>(
    'SELECT id AS user_id, name AS user_name, email AS user_email FROM aliased_users'
  );
});

console.log(result.records[0]); // { user_id: 1, user_name: 'Alias Test', user_email: 'alias@example.com' }

await db.disconnect();
```

### Filter a Table with `from()` and a Compiled Expression

`db.from<T>()` builds a FROM statement; `select()` sets the projection and `byExpression()` attaches a compiled WHERE clause. The expression compiler comes from `blendsdk/expression`, exactly as used by the test suite.

```typescript
import { query } from 'blendsdk/expression';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Row {
  id: number;
  name: string;
  age: number;
  active: boolean;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const result = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE filter_users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      age INTEGER NOT NULL,
      active BOOLEAN DEFAULT true
    )
  `);

  await tx.executeQuery(
    `INSERT INTO filter_users (name, age, active) VALUES
       ('Active 25', 25, true),
       ('Inactive 25', 25, false),
       ('Active 30', 30, true)`
  );

  const expression = query<Row>()
    .where('age')
    .equals(25)
    .and('active')
    .equals(true)
    .compile();

  return tx.from<Row>('filter_users').select(['id', 'name']).byExpression(expression).execute();
});

console.log(result?.rowCount);   // 1
console.log(result?.records[0]); // { id: 1, name: 'Active 25' }

await db.disconnect();
```

---

## Query Hooks

### Normalize Parameters with `beforeQuery`

For INSERT statements the hook receives the values keyed by column name, before `yesql` converts them to positional parameters — an ideal place for normalization and hashing.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const created = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE hook_users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255)
    )
  `);

  return tx
    .insert<User>('hook_users')
    .values({
      name: 'Hook Test User',
      email: 'HOOK@EXAMPLE.COM',
      password_hash: 'plaintext123',
    })
    .beforeQuery((params) => {
      const transformed = { ...params };
      if (typeof transformed.email === 'string') {
        transformed.email = transformed.email.toLowerCase();
      }
      if (typeof transformed.password_hash === 'string') {
        transformed.password_hash = `bcrypt_${transformed.password_hash}`;
      }
      return transformed;
    })
    .returning('*')
    .executeReturnSingle();
});

console.log(created?.email);         // hook@example.com
console.log(created?.password_hash); // bcrypt_plaintext123

await db.disconnect();
```

### Strip Sensitive Fields with `afterQuery`

`afterQuery` receives the returned rows and returns the rows to expose. Removing secrets here keeps every caller from remembering to do it. When no rows match, the hook is skipped entirely.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SensitiveUser {
  id?: number;
  name?: string;
  email?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const safe = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE sensitive_users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255),
      api_key VARCHAR(255)
    )
  `);

  await tx.executeQuery(
    `INSERT INTO sensitive_users (name, email, password_hash, api_key)
     VALUES (:name, :email, :password_hash, :api_key)`,
    {
      name: 'Sensitive Test',
      email: 'sensitive@example.com',
      password_hash: 'hashed_secret123',
      api_key: 'secret_api_key_xyz',
    }
  );

  return tx
    .delete<SensitiveUser>('sensitive_users')
    .filter({ email: 'sensitive@example.com' })
    .afterQuery((rows) =>
      rows.map((row) => {
        const safeRow = { ...(row as Record<string, unknown>) };
        delete safeRow.password_hash;
        delete safeRow.api_key;
        return safeRow;
      })
    )
    .returning('*')
    .executeReturnSingle();
});

console.log(safe); // { id: 1, name: 'Sensitive Test', email: 'sensitive@example.com' }

await db.disconnect();
```

### Combine Both Hooks on an UPDATE

Remember the parameter naming rules when writing hooks: UPDATE SET values arrive as `v_<column>`, while filter values arrive as `p1`, `p2`, ….

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

interface UserFilter {
  email?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const updated = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE update_hook_users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255)
    )
  `);

  await tx.executeQuery(
    'INSERT INTO update_hook_users (name, email, password_hash) VALUES (:name, :email, :password_hash)',
    { name: 'Update Hook Test', email: 'updatehook@example.com', password_hash: 'old_hash' }
  );

  return tx
    .update<User, UserFilter>('update_hook_users')
    .values({ name: 'Updated Hook Test', password_hash: 'newpassword456' })
    .filter({ email: 'updatehook@example.com' })
    .beforeQuery((params) => {
      // UPDATE SET values are prefixed with `v_`; filter values are `p1`, `p2`, ...
      if (typeof params.v_password_hash === 'string') {
        params.v_password_hash = `bcrypt_${params.v_password_hash}`;
      }
      return params;
    })
    .afterQuery((rows) =>
      rows.map((row) => {
        const safeRow = { ...(row as Record<string, unknown>) };
        delete safeRow.password_hash;
        return safeRow;
      })
    )
    .returning('*')
    .executeReturnSingle();
});

console.log(updated?.name);         // Updated Hook Test
console.log(updated?.password_hash); // undefined — stripped by afterQuery

await db.disconnect();
```

---

## Security and Error Handling

### Parameter Binding Prevents SQL Injection

Named parameters are bound as driver parameters, never concatenated into SQL. A malicious string is treated as plain data — the table stays intact and the lookup simply matches nothing.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

const result = await db.withTransaction(async (tx) => {
  await tx.executeQuery(`
    CREATE TEMP TABLE injection_test (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100)
    )
  `);

  await tx.executeQuery('INSERT INTO injection_test (name) VALUES (:name)', {
    name: 'legitimate_user',
  });

  const maliciousInput = "'; DROP TABLE injection_test; --";

  const lookup = await tx.executeQuery<{ id: number; name: string }>(
    'SELECT * FROM injection_test WHERE name = :name',
    { name: maliciousInput }
  );

  const legit = await tx.executeQuery<{ id: number; name: string }>(
    'SELECT * FROM injection_test WHERE name = :name',
    { name: 'legitimate_user' }
  );

  return { lookup, legit };
});

console.log(result.lookup.rowCount); // 0 — the input never became SQL
console.log(result.legit.rowCount);  // 1 — the table is intact

await db.disconnect();
```

### Empty INSERT or UPDATE Payloads Throw

Statement builders validate their payload while building the SQL, before any connection is used.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  name: string;
  email: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

try {
  await db.insert<User>('users').values({}).execute();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // → Cannot build INSERT statement for table "users": no values provided.
  //   Call .values() with at least one column before executing.
}

try {
  await db.update<User, { id?: number }>('users').values({}).filter({ id: 1 }).execute();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // → Cannot build UPDATE statement for table "users": no values provided.
  //   Call .values() with at least one column before executing.
}

await db.disconnect();
```

### Invalid Transaction Options Are Rejected

Isolation levels are validated before a client is acquired. The cast below mimics an untyped JavaScript caller; with strict types, the wrong literal never compiles in the first place.

```typescript
import { PostgreSQLDatabase, TransactionIsolation } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

try {
  await db.withTransaction(async () => 'never runs', {
    isolation: 'read uncommitted' as TransactionIsolation,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  // → Unsupported transaction isolation level.
  //   Use "read committed", "repeatable read", or "serializable".
}

await db.disconnect();
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
