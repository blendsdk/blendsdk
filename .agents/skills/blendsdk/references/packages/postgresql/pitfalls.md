> **Package**: `blendsdk/postgresql`

# postgresql Best Practices

Best practices for building on `blendsdk/postgresql` — a thin, explicit-SQL adapter over the `pg` driver. The rules below are grounded in how the package actually works: a connection pool per instance, named parameters compiled by `yesql`, one pinned client per transaction, and statement builders with a compiled-expression cache. (See Core Concepts for the underlying behavior.) Each **Do / Don't** pair shows the wrong approach first — with its failure mode — then the approach the package is designed for.

Fragments in the pairs refer to these modeling types:

```typescript fragment
interface User {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}
```

---

## Do / Don't Pairs

### 1. Pass values as named parameters — never interpolate them

**❌ Wrong**:

```typescript fragment
const email = "admin@example.com' OR '1'='1";

// The value becomes part of the SQL text before yesql ever sees the query
const { records } = await db.executeQuery<{ id: number; email: string }>(
  `SELECT id, email FROM users WHERE email = '${email}'`
);
```

**Why this fails:** string interpolation turns input into SQL syntax. The package's own test suite encodes the safe behavior as the contrast: a value of `"'; DROP TABLE injection_test; --"` passed as a parameter matches zero rows and the table survives — but only because the value traveled as a parameter, never as SQL text.

**✅ Correct**:

```typescript fragment
const email = "admin@example.com' OR '1'='1";

// yesql compiles :email into a positional $1 parameter;
// the value can never change the query's structure
const { records } = await db.executeQuery<{ id: number; email: string }>(
  'SELECT id, email FROM users WHERE email = :email',
  { email }
);
```

### 2. Use `withTransaction()` — never hand-roll BEGIN/COMMIT

**❌ Wrong**:

```typescript fragment
await db.executeQuery('BEGIN');
await db.executeQuery(
  'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
  { amount: 100, id: 1 }
);
await db.executeQuery(
  'UPDATE accounts SET balance = balance + :amount WHERE id = :id',
  { amount: 100, id: 2 }
);
await db.executeQuery('COMMIT');
```

**Why this fails:** every atomic `executeQuery()` acquires its own client from the pool and releases it in a `finally` block when the call returns. The `BEGIN` lands on one pooled connection — which is then returned to the pool *holding an open transaction* — while the updates and the `COMMIT` run on whatever client the pool hands out next. The four statements are not guaranteed to share a session, so there is no atomic unit here. Manual transaction control cannot work through `executeQuery()`; the pinned client that `withTransaction()` provides is exactly the mechanism you would otherwise be missing.

**✅ Correct**:

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
    await txDb.executeQuery(
      'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
      { amount: 100, id: 1 }
    );
    await txDb.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :id',
      { amount: 100, id: 2 }
    );
  });
  console.log('transfer committed');
} finally {
  await db.disconnect();
}
```

All callback statements run on one pinned client: `BEGIN`, then `COMMIT` — or an automatic `ROLLBACK` if the callback throws — followed by a guaranteed release. Always use the callback's `txDb` parameter so the transaction boundary is explicit at every call site (it is the same instance the transaction is pinned to).

### 3. Keep one transaction in flight per instance

**❌ Wrong**:

```typescript fragment
await db.withTransaction(async (txDb) => {
  await txDb.executeQuery('INSERT INTO orders (id) VALUES (:id)', { id: 1 });

  // Nested withTransaction reuses the already-pinned client, and its COMMIT
  // commits the OUTER transaction's work — durably
  await db.withTransaction(async () => {
    await db.executeQuery('INSERT INTO order_items (order_id) VALUES (:id)', { id: 1 });
  });

  // The outer ROLLBACK can no longer undo anything:
  // the inner COMMIT already made both INSERTs permanent
  throw new Error('abort the order');
});
```

**Why this fails:** the pinned client lives on the instance (`transactionClient`), not in a scope. A nested `withTransaction()` sees a client already pinned, skips acquiring its own, and issues a second `BEGIN` (PostgreSQL warns and ignores it) followed by a `COMMIT` — which commits everything done so far, including the outer transaction's work. The same pinning traps *concurrent* sibling queries: a `db.executeQuery()` fired while a transaction is active silently runs on the transaction's client, joins the transaction, and is rolled back with it. Treat the instance as busy for the duration of a transaction — no nesting, no fire-and-forget queries, including from unrelated request handlers.

**✅ Correct**:

```typescript fragment
// One unit of work = one callback, with every statement awaited inside it
await db.withTransaction(async (txDb) => {
  await txDb.executeQuery('INSERT INTO orders (id) VALUES (:id)', { id: 1 });
  await txDb.executeQuery('INSERT INTO order_items (order_id) VALUES (:id)', { id: 1 });
});

// An independent second unit of work starts only after the first has finished
await db.withTransaction(async (txDb) => {
  await txDb.executeQuery('INSERT INTO audit_log (message) VALUES (:message)', {
    message: 'order created',
  });
});
```

### 4. Treat an empty filter as "every row" — guard destructive statements

**❌ Wrong**:

```typescript fragment
async function purgeUsers(filter: UserFilter): Promise<void> {
  // When filter is {} the builder emits "DELETE FROM users" — no WHERE clause
  await db.delete<UserFilter>('users').filter(filter).execute();
}

await purgeUsers({}); // deletes every row in users
```

**Why this fails:** the `WHERE` clause is only appended when the compiled expression produced SQL. `.filter({})` compiles to nothing, so the statement becomes a bare `DELETE FROM users`. The same applies to UPDATE: `.values(...)` with no `.filter()` (or an empty one), updates every row in the table. The package's tests exercise this path deliberately as a *bulk* operation — which is exactly why application code must make the intent explicit. Note the contrast with INSERT and UPDATE, whose builders throw when `.values()` is empty: no such guard can exist for filters, because an empty filter is a legitimate bulk operation. The protection has to be yours.

**✅ Correct**:

```typescript fragment
async function purgeUsers(filter: UserFilter): Promise<number> {
  if (Object.keys(filter).length === 0) {
    throw new Error('purgeUsers() requires at least one filter criterion');
  }

  return db.delete<UserFilter>('users').filter(filter).executeReturnCount();
}
```

Validate before you execute. When a full-table operation is genuinely intended, say so in a dedicated bulk function rather than letting an accidentally-empty object decide for you.

### 5. Retrieve written rows with `RETURNING` — not with a follow-up SELECT

**❌ Wrong**:

```typescript fragment
await db.insert<User>('users').values({ name: 'Ada', email: 'ada@example.com' }).execute();

// Extra round trip, and it relies on email being unique and untouched
const { records } = await db.executeQuery<User>(
  'SELECT id FROM users WHERE email = :email',
  { email: 'ada@example.com' }
);
const id = records[0]?.id;
```

**Why this fails:** the second statement is a full extra round trip, it must re-find the row through a column you *hope* is unique (`email`), and between the two statements another writer can change or delete the row — so the SELECT may observe a different state than the INSERT wrote.

**✅ Correct**:

```typescript fragment
const created = await db
  .insert<User>('users')
  .values({ name: 'Ada', email: 'ada@example.com' })
  .returning(['id', 'name', 'email'])
  .executeReturnSingle();

if (created === null) {
  throw new Error('INSERT returned no row');
}

const id = created.id; // server-generated key, from the same statement
```

`RETURNING` makes the write and the read one server-side operation: the returned row is exactly the row this statement wrote, including server-generated values (`id`, `created_at`, defaults) that no re-query is guaranteed to reproduce. The same pattern applies to UPDATE and DELETE.

### 6. Handle the `null` from `executeReturnSingle()` — don't silence it

**❌ Wrong**:

```typescript fragment
const updated = await db
  .update<User, UserFilter>('users')
  .values({ active: false })
  .filter({ email: 'nobody@example.com' })
  .returning(['id', 'email'])
  .executeReturnSingle();

// The non-null assertion hides the real possibility that no row matched
console.log(`deactivated ${updated!.email}`);
```

**Why this fails:** `executeReturnSingle()` resolves with `null` whenever the statement returned no rows. For an UPDATE or DELETE whose filter matched nothing, that is a *normal* outcome — the test suite asserts it explicitly for both. `!` converts a case you didn't handle into a crash on `null.email`, probably in production.

**✅ Correct**:

```typescript fragment
const updated = await db
  .update<User, UserFilter>('users')
  .values({ active: false })
  .filter({ email: 'nobody@example.com' })
  .returning(['id', 'email'])
  .executeReturnSingle();

if (updated === null) {
  // No row matched the filter — an expected outcome, not an exception
  return { status: 'not-found' as const };
}

return { status: 'deactivated' as const, email: updated.email };
```

Strict mode forces the check anyway; make it a domain decision (not found vs. error) instead of silencing it. For batch operations, emptiness is already communicated by the array and count terminators: `executeReturnAll()` resolves with `[]` and `executeReturnCount()` with `0`.

### 7. Let errors escape the transaction callback — the rollback depends on it

**❌ Wrong**:

```typescript fragment
await db.withTransaction(async (txDb) => {
  try {
    await txDb.executeQuery('INSERT INTO users (email) VALUES (:email)', {
      email: 'ada@example.com',
    });
    await txDb.executeQuery('INSERT INTO audit_log (event) VALUES (:event)', {
      event: 'user-created',
    });
  } catch (error) {
    // Swallowed — the callback now returns normally, so withTransaction COMMITs
    console.error('ignoring:', error);
  }
});
```

**Why this fails:** two problems at once. If the second statement failed after the first succeeded, swallowing the error lets the callback return normally and `withTransaction()` issues `COMMIT` — persisting a half-completed unit of work. And in PostgreSQL, once any statement in a transaction has failed, the session is in an aborted state: every following statement is rejected until the transaction is rolled back. Only an exception that propagates out of the callback triggers that `ROLLBACK`.

**✅ Correct**:

```typescript fragment
try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery('INSERT INTO users (email) VALUES (:email)', {
      email: 'ada@example.com',
    });
    await txDb.executeQuery('INSERT INTO audit_log (event) VALUES (:event)', {
      event: 'user-created',
    });
  });
} catch (error) {
  // The ROLLBACK has already run; this is the original error from inside the callback
  console.error('user creation rolled back:', error instanceof Error ? error.message : error);
}
```

Handle failures *around* the transaction, not inside it. The error you catch is your original error — failures during the automatic rollback are logged by the package, never substituted for it.

### 8. Disconnect deliberately — and await it

**❌ Wrong**:

```typescript fragment
const db = new PostgreSQLDatabase(config);

await db.executeQuery('SELECT 1');

db.disconnect(); // floating promise: errors are unhandled and shutdown may not be complete
```

**Why this fails:** `disconnect()` sets the shutdown guard, ends the pool, and — if the timeout expires — force-releases clients. Floating it means shutdown failures surface as unhandled rejections (which crash modern Node by default), and code that assumes the pool is closed can run before it actually is.

**✅ Correct**:

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
  const { rowCount } = await db.executeQuery('SELECT 1');
  console.log(`database reachable (${rowCount} row)`);
} finally {
  // Always awaited; safe even if no query ever ran
  await db.disconnect();
}
```

Once `disconnect()` starts, further queries reject with `Cannot execute query: database is shutting down` and new transactions with `Cannot start transaction: database is shutting down` — deliberately, which is why shutdown belongs after you stop accepting work. In long-running services, call it from whatever owns process shutdown (the web framework's lifecycle, or your own signal handlers), once. The default ceiling is 10 000 ms; pass a longer `disconnect(timeoutMs)` when in-flight queries need more time before the forced fallback, which interrupts them.

### 9. Enable `enableGracefulShutdown` only where nothing else owns the process

**❌ Wrong**:

```typescript fragment
// Inside an application whose lifecycle is owned by a WebApplication (blendsdk/webafx)
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  enableGracefulShutdown: true, // registers its own SIGINT/SIGTERM handlers
});
```

**Why this fails:** the flag installs SIGINT/SIGTERM handlers that call `disconnect()` and then `process.exit()` directly. A `WebApplication` from `blendsdk/webafx` already handles those signals for the entire process. Two competing handler sets produce signal-handler conflicts and unpredictable shutdown behavior — possibly exiting the process before the framework finished its own cleanup.

**✅ Correct**:

```typescript fragment
// Framework-managed lifecycle: let the framework own shutdown and call disconnect() itself
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  // enableGracefulShutdown omitted — defaults to false
});
```

The opt-in exists for standalone scripts and services with no other shutdown owner. When enabled there, `disconnect()` runs on the first SIGINT/SIGTERM and the process exits with code `0` on success, `1` on failure.

---

## Anti-Patterns

Mistakes that compile cleanly but surprise at runtime — several of these are exactly what the package's own test suite guards against.

### 1. Treating construction as a connection check

`new PostgreSQLDatabase(config)` builds the pool but connects lazily — it succeeds even when the host is unreachable or the credentials are wrong. Connection failures surface on the **first query**, and `disconnect()` still resolves cleanly. Code that assumes a constructed instance is a working one will discover the truth at the worst possible moment; if the service must fail fast at boot, probe explicitly:

```typescript fragment
const db = new PostgreSQLDatabase(config);

// Startup probe — turns "queries will fail later" into "the process failed to start"
await db.executeQuery('SELECT 1');
```

### 2. Assuming numeric columns come back as numbers

The `pg` driver returns `COUNT(*)`, `numeric`/`decimal`, and `bigint` values as **strings** (the package's tests expect `'29.99'` from a `DECIMAL` column and parse counts with `parseInt`). Typing them as `number` in a result interface compiles fine but lies at runtime, and the failure is silent where coercion "works" (`'3' * 2` → `6`) and wrong where it doesn't (`'3' + 1` → `'31'`):

```typescript fragment
interface OrderSummaryRow {
  order_count: string; // COUNT(*) arrives as a string from pg
  total_amount: string; // numeric/decimal arrive as strings too
}

const { records } = await db.executeQuery<OrderSummaryRow>(
  'SELECT COUNT(*) AS order_count, SUM(total) AS total_amount FROM orders'
);

const orderCount = Number.parseInt(records[0].order_count, 10);
const totalAmount = Number.parseFloat(records[0].total_amount);
```

Model the wire format (`string`), then convert at the boundary — never the other way around.

### 3. Passing `undefined` as a column value

PostgreSQL has no `undefined`. The package's test suite normalizes `undefined` to `null` in `beforeQuery` hooks "for database consistency", and filter values that are `undefined` reach the server as `null`. Don't rely on driver-specific handling of `undefined` — be explicit:

```typescript fragment
interface Profile {
  display_name: string;
  bio: string | null;
  website: string | null;
}

await db
  .insert<Profile>('profiles')
  .values({ display_name: 'Ada', bio: null, website: null })
  // Normalize any undefined that slipped in from optional inputs
  .beforeQuery((params) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      normalized[key] = value === undefined ? null : value;
    }
    return normalized;
  })
  .execute();
```

### 4. Expecting `afterQuery` to run for empty result sets in `executeQuery()`

When a query affects zero rows, `executeQuery()` returns `{ records: [], rowCount: 0, fields: [] }` immediately and the `afterQuery` hook is never invoked. Any enrichment or masking logic placed there silently does nothing for empty results — harmless for pure per-row transforms, but a bug if your post-processing also reacts to "no rows". Check `rowCount` in the caller for those cases:

```typescript fragment
const result = await db.executeQuery<User>(
  'SELECT id, email FROM users WHERE email = :email',
  { email: 'nobody@example.com' },
  {
    afterQuery: (records) =>
      records.map((record) => ({ ...record, email: record.email.toLowerCase() })),
  }
);

if (result.rowCount === 0) {
  // afterQuery never ran here — handle the empty case explicitly
  console.log('no matching users');
}
```

For batch reads through builders, branch on the terminators instead: `executeReturnAll()` hands you `[]` and `executeReturnCount()` hands you `0`.

### 5. Poking at protected build methods from application code

The test suite calls the protected `buildQuery()` and `buildParameters()` through type casts to assert generated SQL text — that is a test-harness technique, not an API. In application code those methods are not part of the public surface: compose the statement fluently and use a public terminator.

```typescript fragment
const removed = await db.delete<UserFilter>('users').filter({ id: 1 }).executeReturnCount();
```

---

## Performance Tips

These tips follow directly from how the adapter is built: one pool per instance, one pinned client per transaction, and named-parameter compilation per statement.

### 1. One pool per process — reuse the instance

Every `PostgreSQLDatabase` owns its own `pg.Pool`. Constructing instances per request multiplies pools, connections, and handshake overhead, and it multiplies the server-side connection count. Create the instance once (module scope or composition root), share it, and dispose it once during shutdown.

### 2. Size the pool to your concurrency — and to the server's limits

`poolConfig.max` (default 10) caps concurrent clients; queries beyond that **queue inside the pool** rather than failing. So a `Promise.all` of 50 queries on a default pool runs 10 at a time — the pool makes concurrency safe, but not instantaneous. Keep `max × number of application instances` within the server's connection budget (`max_connections` minus administrative headroom), and tune `idleTimeoutMillis` to your traffic: shorter recycles idle clients sooner (more reconnects on bursty traffic), longer holds server slots during quiet periods.

```typescript fragment
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  poolConfig: {
    max: 10, // concurrency ceiling per process
    idleTimeoutMillis: 30000, // default; raise for steady traffic, lower for sparse
    connectionTimeoutMillis: 5000, // see below
  },
});
```

### 3. Set `connectionTimeoutMillis` in production

The driver default of `0` disables the connect timeout: with an unreachable or saturated host, a query waits out the OS-level TCP timeout instead of failing. A finite value (a few seconds) turns a hang into an error your retry and alerting layers can handle.

### 4. Keep transactions short — the client is pinned for the entire callback

While `withTransaction()` runs, one pooled client is held, and every statement in the callback is a sequential round trip on that single connection. Never await external I/O (HTTP calls, queues, timers) inside the callback; a slow transaction blocks other writers on the rows it touched and occupies a pool slot for its whole duration, reducing concurrency for everyone else. Prepare all data first; do only database work inside.

### 5. Batch writes instead of looping statements

Each `executeQuery()` inside a transaction is a full round trip; a loop of single-row INSERTs pays the round-trip and statement-parse cost N times, while one set-based statement pays it once. `executeQuery()` accepts multi-row `VALUES` lists directly — the INSERT/UPDATE builders model a single row's values, so bulk shapes go through `executeQuery`:

```typescript fragment
await db.executeQuery(
  `INSERT INTO order_items (order_id, sku, quantity) VALUES
     (:order_id, :sku1, :quantity1),
     (:order_id, :sku2, :quantity2),
     (:order_id, :sku3, :quantity3)`,
  {
    order_id: 42,
    sku1: 'A-100',
    quantity1: 2,
    sku2: 'B-200',
    quantity2: 1,
    sku3: 'C-300',
    quantity3: 5,
  }
);
```

### 6. Don't return rows you won't read

For bulk UPDATE/DELETE/INSERT where you only need a count, do **not** chain `.returning(...)`. Without it, the affected rows never leave the server — and the count still comes back in `rowCount`, which `executeReturnCount()` uses:

```typescript fragment
const deactivated = await db
  .update<User, UserFilter>('users')
  .values({ active: false })
  .filter({ active: true })
  .executeReturnCount(); // no RETURNING clause involved
```

### 7. Select only the columns you need

Explicit select lists keep less data on the wire — the difference is real on wide tables with `TEXT`/`JSONB` columns — and they keep sensitive columns from ever reaching the process. `db.selectAll()` is convenient for exploration; in hot paths, prefer explicit columns via the read builder:

```typescript fragment
const result = await db.from<User>('users').select(['id', 'name', 'email']).execute();
```

---

## Security Considerations

The adapter is injection-safe **for values** by construction. These practices keep it that way for everything values cannot protect — and cover the data that flows around the queries.

### 1. Parameterization is the boundary — keep every value behind it

All user-supplied values must travel through the named-parameter map. `yesql` compiles `:name` into positional parameters, and the driver sends values separately from the SQL text, so input can never alter the query's structure. The test suite encodes this as a guarantee: `'; DROP TABLE injection_test; --` passed as a filter value matches zero rows and the table is untouched. No `executeQuery()` call may contain interpolated input — not even "already validated" values; parameters are for all values, trusted or not.

### 2. Allowlist identifiers — names are SQL text, not values

Placeholders only protect *values*. Table names (`db.insert<T>(tableName)`, `db.from<T>(tableName)`), the column lists passed to `.returning([...])`, and any dynamic key that ends up in a filter object are written into the SQL text verbatim. If an identifier can originate from a request, check it against a fixed allowlist before it reaches a builder or `executeQuery()` — never pass raw input as a table or column name.

### 3. Don't fetch secrets to mask them later

When a table holds `password_hash`, tokens, or PII, select explicit columns (`select([...])`, `.returning([...])`) instead of `'*'`. Masking in `afterQuery` — which the package's tests use to strip `password_hash` and `api_key` from results — is valuable defense-in-depth, but it only protects the execution paths where you remember to attach it. Omitting a column is stronger than masking it.

### 4. Keep credentials and parameter maps out of logs

The config's `pass` is a plain property — source it from environment variables or a secret manager, never from checked-in code, and keep it out of log statements and error dumps. The same care applies to hooks: `beforeQuery` parameter maps and raw result rows are exactly where passwords and tokens live — the tested masking hooks exist to remove them before results reach the rest of the application.

### 5. Enforce invariants inside the transaction, not before it

A check-then-act sequence split across separate statements or transactions is a race: another writer can change the row between your check and your write. Read the value and enforce the rule inside the same `withTransaction()` callback that performs the write, and throw on violation so the automatic `ROLLBACK` discards the whole unit:

```typescript fragment
await db.withTransaction(async (txDb) => {
  await txDb.executeQuery(
    'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
    { amount: 100, id: 1 }
  );

  const { records } = await txDb.executeQuery<{ balance: string }>(
    'SELECT balance FROM accounts WHERE id = :id',
    { id: 1 }
  );

  if (Number(records[0].balance) < 0) {
    throw new Error('insufficient funds'); // ROLLBACK undoes the debit
  }
});
```

### 6. Run the application with a least-privilege database role

Grant the application role exactly what it needs — DML on its tables — and nothing else: no `SUPERUSER`, no `CREATEDB`, no DDL. The package executes the SQL you give it, so the role is the last line of defense: if an identifier ever slips into a query unallowlisted or a filter guard fails, the blast radius stays inside the role's grants.

---

# postgresql Testing Patterns

This document explains how to test code built on `blendsdk/postgresql`. The patterns mirror the package's own suite, which splits cleanly into three tiers: **synchronous SQL-generation tests** that need no server (the statement builders never connect), **Docker-backed integration tests** against a real PostgreSQL container, and **driver-mocked tests** that exercise the execution pipeline — named-parameter compilation, transaction control, and connection release — without a network. The same split is the recommended way to structure a consumer test suite.

---

## Test Setup

### Required Imports

Every test file uses the standard Vitest imports plus the package's public entry point and a shared fixture module:

- `describe`, `expect`, `test` (and `beforeEach`, `afterEach`, `vi` when mocking) from `vitest`
- `PostgreSQLDatabase`, `PostgreSQLConfig`, and the statement classes from `blendsdk/postgresql` — never from `src/` or `dist/` paths
- shared fixtures (connection config, helpers) from a colocated `./params.js` / `./helpers.js` module

Note: inside the package's own repository, tests import the sources directly (`import { PostgreSQLDatabase } from '../src/database.js'`). When testing your own application or library, always import from the published entry point `blendsdk/postgresql`.

### Test Framework and Scripts

The package runs Vitest 4 (`vitest`, `@vitest/coverage-v8`) with the verbose reporter. Its `package.json` defines the scripts that shape the workflow:

| Script | Command | Needs Docker |
| --- | --- | --- |
| `pnpm run test:fast` | `vitest run --reporter=verbose tests/statement-builders.test.ts` | No |
| `pnpm run test:watch` | `vitest watch --reporter=verbose` | Yes |
| `pnpm run test:coverage` | `vitest run --coverage` | Yes |
| `pnpm test` | `db:down` → `db:up` → `vitest run --reporter=verbose` → `db:down` | Yes |
| `pnpm run db:up` | `docker-compose -p postgresql -f ./docker/docker-compose${MODE}.yml up -d && sleep 5` | — |
| `pnpm run db:down` | `docker-compose -p postgresql -f ./docker/docker-compose${MODE}.yml down -v --remove-orphans` | — |
| `pnpm run db:logs` | `docker-compose ... logs postgres-test` | — |

`test:fast` is the important pattern: SQL-generation tests are separated into their own file so they can run without any container. Structure your own suite the same way — keep a driver-free subset runnable on every save.

### Docker-Backed Integration Environment

Integration tests require a PostgreSQL server started through Docker Compose:

1. The compose file lives at `docker/docker-compose${MODE}.yml` and defines a `postgres-test` service (the `MODE` environment variable selects an alternative file; leave it unset for the default).
2. `pnpm run db:up` starts the container and waits 5 seconds for the server to accept connections.
3. `pnpm run db:down` tears the container down **and removes its volumes** (`-v`), so every full run starts from an empty database.
4. `pnpm test` orchestrates the whole lifecycle — down, up, run, down — so a single command always tests against a clean server.

If the container is not running, integration tests fail with connection errors on port `5599`. Run `pnpm run db:up` first (or use `pnpm test`).

### Shared Fixtures

The package centralizes connection parameters in `tests/params.ts` — every integration test file imports the same object:

```typescript
import { PostgreSQLConfig } from 'blendsdk/postgresql';

export const connectionConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5599,
  database: 'testdb',
  pass: 'testdb',
  user: 'testdb',
};
```

The container maps the server to port `5599` (not the default `5432`) so the suite never collides with a developer's local PostgreSQL instance. For CI, make the fixture overridable through environment variables:

```typescript fragment
export const connectionConfig: PostgreSQLConfig = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5599),
  database: process.env.PGDATABASE ?? 'testdb',
  user: process.env.PGUSER ?? 'testdb',
  pass: process.env.PGPASSWORD ?? 'testdb',
};
```

### Test Helpers

Two helpers simplify the most common setups. Every database instance owns its own connection pool, so a fresh instance per test means a fresh server session — that is the foundation of the isolation model described in [Integration Testing](#integration-testing).

```typescript
// tests/helpers.ts
import { PostgreSQLDatabase, PostgreSQLConfig } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

/**
 * Creates a database instance for one test. Every instance owns a fresh pool
 * (and therefore a fresh server session) — no state leaks between tests.
 */
export function createTestDatabase(config: PostgreSQLConfig = connectionConfig): PostgreSQLDatabase {
  return new PostgreSQLDatabase(config);
}

/**
 * Runs a test body against a fresh database instance and always disconnects,
 * even when the body throws.
 */
export async function withTestDatabase<T>(
  fn: (db: PostgreSQLDatabase) => Promise<T>,
  config: PostgreSQLConfig = connectionConfig
): Promise<T> {
  const db = new PostgreSQLDatabase(config);

  try {
    return await fn(db);
  } finally {
    await db.disconnect(15000);
  }
}
```

If your hooks call `disconnect()` (which can legitimately take up to its timeout to drain the pool), give them generous timeouts — the package's own suite uses 30 000 ms:

```typescript fragment
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
```

### Suggested Layout

```text
tests/
├── params.ts                  ← shared connection config
├── helpers.ts                 ← withTestDatabase() and friends
├── pg-mock.ts                 ← in-memory pg driver mock (see Mocking & Stubbing)
├── statement-builders.test.ts ← SQL generation only — runs without Docker
├── database.test.ts           ← executeQuery, configuration
├── connection-pool.test.ts    ← lifecycle, pool options, shutdown guards
├── transaction.test.ts        ← withTransaction behavior
├── insert.test.ts             ← INSERT builder + RETURNING
├── update.test.ts             ← UPDATE builder + filters
├── delete.test.ts             ← DELETE builder + filters
├── from.test.ts               ← SELECT builders and expressions
└── hooks.test.ts              ← beforeQuery / afterQuery
```

---

## Unit Testing

Two things make unit testing practical with this package:

- **The pool connects lazily.** Constructing a `PostgreSQLDatabase` performs no I/O — the `pg.Pool` it creates connects on the first query. You can construct instances with any configuration and drive statement builders entirely offline.
- **SQL generation is pure.** `buildQuery()` / `buildParameters()` on the statement builders produce strings and parameter maps without touching the database. The package's `tests/statement-builders.test.ts` exists precisely to prove this: it is the `test:fast` script and needs no Docker.

**Synchronous patterns** apply to everything in this section — configuration assertions, factory checks, and SQL generation. Use plain `expect()` with no `await`. **Asynchronous patterns** (query execution, transactions) are covered in the following sections; always `await` database calls and prefer `await expect(promise).rejects.toThrow(...)` for rejection assertions.

### Configuration and Pool Options

The constructor accepts valid configuration without connecting; string ports are coerced with `Number()`; pool tuning is optional. A `PostgreSQLDatabase` instance is all these tests need — never a server:

```typescript
import { describe, expect, test } from 'vitest';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const baseConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testuser',
  pass: 'testpass',
};

describe('PostgreSQLDatabase configuration', () => {
  test('accepts a valid configuration without connecting', () => {
    expect(() => new PostgreSQLDatabase(baseConfig)).not.toThrow();
  });

  test('accepts a string port and coerces it', () => {
    const config: PostgreSQLConfig = { ...baseConfig, port: '5432' };
    expect(() => new PostgreSQLDatabase(config)).not.toThrow();
  });

  test('accepts full or partial pool configuration', () => {
    const withFullPool: PostgreSQLConfig = {
      ...baseConfig,
      poolConfig: { max: 20, idleTimeoutMillis: 60000, connectionTimeoutMillis: 5000 },
    };
    const withPartialPool: PostgreSQLConfig = { ...baseConfig, poolConfig: { max: 15 } };

    expect(() => new PostgreSQLDatabase(withFullPool)).not.toThrow();
    expect(() => new PostgreSQLDatabase(withPartialPool)).not.toThrow();
  });

  test('accepts the enableGracefulShutdown flag — keep it false in tests', () => {
    const config: PostgreSQLConfig = { ...baseConfig, enableGracefulShutdown: false };
    expect(() => new PostgreSQLDatabase(config)).not.toThrow();
  });
});
```

**Warning:** never set `enableGracefulShutdown: true` in a test. The flag registers `SIGINT`/`SIGTERM` handlers that call `disconnect()` and `process.exit()` — inside a test runner this fights the runner's own signal handling.

### Statement Factory Tests

`db.insert()`, `db.update()`, and `db.delete()` return the PostgreSQL-specific builder classes; `db.from()` and `db.selectAll()` return the inherited `FromStatement`. None of these touch the network:

```typescript
import { describe, expect, test } from 'vitest';
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLDeleteStatement,
  PostgreSQLInsertStatement,
  PostgreSQLUpdateStatement,
} from 'blendsdk/postgresql';

const baseConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testuser',
  pass: 'testpass',
};

describe('statement factories', () => {
  test('insert() returns a PostgreSQLInsertStatement', () => {
    const db = new PostgreSQLDatabase(baseConfig);
    expect(db.insert('test_table')).toBeInstanceOf(PostgreSQLInsertStatement);
  });

  test('update() returns a PostgreSQLUpdateStatement', () => {
    const db = new PostgreSQLDatabase(baseConfig);
    expect(db.update('test_table')).toBeInstanceOf(PostgreSQLUpdateStatement);
  });

  test('delete() returns a PostgreSQLDeleteStatement', () => {
    const db = new PostgreSQLDatabase(baseConfig);
    expect(db.delete('test_table')).toBeInstanceOf(PostgreSQLDeleteStatement);
  });

  test('from() and selectAll() return a FromStatement', () => {
    const db = new PostgreSQLDatabase(baseConfig);
    expect(db.from('test_table').constructor.name).toBe('FromStatement');
    expect(db.selectAll('test_table').constructor.name).toBe('FromStatement');
  });
});
```

### SQL Generation Without a Database

`buildQuery()` and `buildParameters()` are `protected` on the statement classes, so white-box tests cannot call them on a factory-returned instance. The clean, strict-typed approach is a tiny subclass harness that widens the visibility — no casts required. (The package's internal tests live inside the package and reach the same methods through a cast; consumer code should prefer the harness below or the driver mock described in [Mocking & Stubbing](#mocking--stubbing).)

```typescript
import { describe, expect, test } from 'vitest';
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLDeleteStatement,
  PostgreSQLInsertStatement,
  PostgreSQLUpdateStatement,
} from 'blendsdk/postgresql';

interface TestUser {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

/** White-box harness: exposes the protected SQL-building steps for unit tests. */
class TestableInsertStatement<TableType> extends PostgreSQLInsertStatement<TableType> {
  public buildSql(): string {
    return this.buildQuery();
  }

  public buildParams(): Record<string, unknown> {
    return this.buildParameters();
  }
}

class TestableUpdateStatement<TableType, FilterType> extends PostgreSQLUpdateStatement<
  TableType,
  FilterType
> {
  public buildSql(): string {
    return this.buildQuery();
  }

  public buildParams(): Record<string, unknown> {
    return this.buildParameters();
  }
}

class TestableDeleteStatement<FilterType> extends PostgreSQLDeleteStatement<FilterType> {
  public buildSql(): string {
    return this.buildQuery();
  }

  public buildParams(): Record<string, unknown> {
    return this.buildParameters();
  }
}

// The statement constructors require a database instance, but SQL generation
// never touches it — the pg.Pool is created lazily and never connects.
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'testuser',
  pass: 'testpass',
} satisfies PostgreSQLConfig);

describe('INSERT SQL generation', () => {
  test('builds a parameterized INSERT with a RETURNING clause', () => {
    const statement = new TestableInsertStatement<TestUser>('users', db);
    statement.values({ name: 'Ada', email: 'ada@example.com' }).returning('*');

    expect(statement.buildSql()).toBe(
      'INSERT INTO users (name, email) VALUES (:name, :email) RETURNING *'
    );
    expect(statement.buildParams()).toEqual({ name: 'Ada', email: 'ada@example.com' });
  });

  test('throws for an INSERT without values', () => {
    const statement = new TestableInsertStatement<TestUser>('users', db);
    statement.values({});

    expect(() => statement.buildSql()).toThrow(
      'Cannot build INSERT statement for table "users": no values provided'
    );
  });
});

describe('UPDATE SQL generation', () => {
  test('separates value and filter parameters with v_ and pN names', () => {
    const statement = new TestableUpdateStatement<TestUser, { id: number; active: boolean }>(
      'users',
      db
    );
    statement.values({ name: 'Ada', active: true }).filter({ id: 1, active: false });

    expect(statement.buildSql()).toBe(
      'UPDATE users SET name = :v_name, active = :v_active WHERE id = :p1 AND active = :p2'
    );
    expect(statement.buildParams()).toEqual({
      v_name: 'Ada',
      v_active: true,
      p1: 1,
      p2: false,
    });
  });
});

describe('DELETE SQL generation', () => {
  test('builds a filtered DELETE with RETURNING', () => {
    const statement = new TestableDeleteStatement<{ id: number }>('users', db);
    statement.filter({ id: 1 }).returning('*');

    expect(statement.buildSql()).toBe('DELETE FROM users WHERE id = :p1 RETURNING *');
    expect(statement.buildParams()).toEqual({ p1: 1 });
  });

  test('builds a bulk DELETE when the filter is empty', () => {
    const statement = new TestableDeleteStatement<{ id: number }>('users', db);
    statement.filter({});

    expect(statement.buildSql()).toBe('DELETE FROM users');
    expect(statement.buildParams()).toEqual({});
  });
});
```

Note that a plain object literal can never stand in for a `PostgreSQLDatabase`: the class carries `protected` members, which makes its type nominal in TypeScript. Subclass, spy on a real (never-connected) instance, or mock the driver — all three options appear in this document.

---

## Integration Testing

Integration tests run against the Docker-backed server described in [Test Setup](#test-setup). The package's `pnpm test` script sequences the container lifecycle, and its suite demonstrates the isolation model below.

### Isolation Model

- **One instance per test.** Every test constructs its own `PostgreSQLDatabase`, which means its own pool and its own server session. Fixtures never leak between tests.
- **Temp tables as fixtures.** Tests create `CREATE TEMP TABLE ...` fixtures inside a `withTransaction()` block. Temp tables are session-scoped, so they exist exactly for the lifetime of the test's pool and disappear at `db.disconnect()` — no cleanup SQL is needed.
- **Transactions bundle setup, action, and assertion.** Wrapping the whole body in `db.withTransaction(async (txDb) => ...)` keeps every statement on one pinned connection, so the temp tables and the data assertions are guaranteed to see each other.
- **Always disconnect.** Use `withTestDatabase()` or a `try/finally`; a leaked pool keeps the test process alive.
- **`db:down` wipes volumes.** Runs never depend on data left behind by a previous run.

### Canonical Integration Test

A complete example following the package's insert pattern:

```typescript
import { describe, expect, test } from 'vitest';
import { withTestDatabase } from './helpers.js';

interface TestUser {
  id?: number;
  name: string;
  email: string;
}

describe('INSERT integration', () => {
  test('inserts a row and verifies it inside the transaction', async () => {
    const result = await withTestDatabase(async (db) => {
      return db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL
          )
        `);

        await txDb
          .insert<TestUser>('test_users')
          .values({ name: 'Integration Test', email: 'integration@example.com' })
          .execute();

        return txDb.executeQuery<TestUser>(
          'SELECT * FROM test_users WHERE email = :email',
          { email: 'integration@example.com' }
        );
      });
    });

    expect(result.rowCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      name: 'Integration Test',
      email: 'integration@example.com',
    });
    expect(result.records[0].id).toBeDefined();
  });
});
```

### Assertion and Teardown Patterns

- **Assert with `toMatchObject` for generated columns.** Rows contain server-generated `id` and timestamp columns; assert the known values and check generated columns separately with `toBeDefined()`.
- **Remember the driver's type mapping** (details in [Query Execution](#query-execution)): `DECIMAL`/`NUMERIC` and `COUNT(*)` come back as **strings**, timestamps as `Date` objects.
- **Shared-instance teardown.** When a test file uses one `db` variable across tests, disconnect in a generously timed `afterEach` and swallow cleanup errors — mirroring the package's `connection-pool.test.ts`:

```typescript fragment
let db: PostgreSQLDatabase;

afterEach(async () => {
  if (db) {
    try {
      await db.disconnect(15000);
    } catch {
      // Ignore disconnect errors in cleanup
    }
  }
}, 30000);
```

- **Verify commit persistence carefully.** Because an instance reuses its single pooled connection, a session-local temp table created inside a committed transaction is still visible to later queries on the same instance. The package's `transaction.test.ts` relies on this when verifying data *after* a transaction.

---

## Mocking & Stubbing

Three levels of isolation are useful, from the bottom up:

1. **Mock the `pg` driver** — test the full adapter pipeline (named-parameter compilation, transaction control, connection release) without a server. Use this whenever the code under test executes queries or uses statement builders.
2. **Stub the database's public methods** — test consumer services that accept a `PostgreSQLDatabase` without exercising SQL at all.
3. **Do not stub the builders themselves.** The statement classes carry protected state that makes them nominally typed, and their fluent chains are tedious to fake. If code under test uses `db.insert(...).values(...).execute()`, mock the driver underneath instead — the real builders then run against a recording client.

### Mocking the pg Driver

`PostgreSQLDatabase` consumes exactly one runtime export from `pg` — the `Pool` class (everything else it imports is type-only). Replacing it with an in-memory pool gives you a fully working adapter with recorded calls. Keep the mock in a shared helper module:

```typescript
// tests/pg-mock.ts

/** One call routed through the mocked driver. */
export interface RecordedQuery {
  text: string;
  values: unknown[];
}

/** Canned response returned for the next client.query() call. */
export interface CannedResult {
  rows: unknown[];
  rowCount: number;
  /** When set, the query rejects with an Error carrying this message. */
  error?: string;
}

/** Shared state of the mocked pg.Pool. Reset between tests. */
export const pgMockState = {
  queries: [] as RecordedQuery[],
  releases: 0,
  results: [] as CannedResult[],
};

/** Clears recorded queries, releases, and canned results. */
export function resetPgMockState(): void {
  pgMockState.queries.length = 0;
  pgMockState.releases = 0;
  pgMockState.results.length = 0;
}

export class MockPoolClient {
  public async query(
    text: string,
    values: unknown[] = []
  ): Promise<{ rows: unknown[]; rowCount: number; fields: unknown[] }> {
    pgMockState.queries.push({ text, values });

    const canned = pgMockState.results.shift();
    if (canned?.error) {
      throw new Error(canned.error);
    }
    if (canned) {
      return { rows: canned.rows, rowCount: canned.rowCount, fields: [] };
    }
    return { rows: [], rowCount: 0, fields: [] };
  }

  public release(): void {
    pgMockState.releases += 1;
  }
}

/** Drop-in replacement for pg.Pool used by the adapter. */
export class MockPool {
  public async connect(): Promise<MockPoolClient> {
    return new MockPoolClient();
  }

  public async end(): Promise<void> {
    // Nothing to close — the mock pool holds no sockets
  }
}
```

Register it in each test file. Vitest hoists `vi.mock` above the imports, so the factory loads the helper with a dynamic `import()` — the same module instance the test file imports for its assertions:

```typescript
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';
import { pgMockState, resetPgMockState } from './pg-mock.js';

vi.mock('pg', async () => {
  const { MockPool } = await import('./pg-mock.js');
  return { Pool: MockPool };
});

const baseConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

beforeEach(() => {
  resetPgMockState();
});

describe('PostgreSQLDatabase with a mocked driver', () => {
  test('compiles named parameters to positional ones and releases the client', async () => {
    pgMockState.results.push({ rows: [{ name: 'john' }], rowCount: 1 });

    const db = new PostgreSQLDatabase(baseConfig);
    const result = await db.executeQuery<{ name: string }>('SELECT :name as name', {
      name: 'john',
    });

    expect(pgMockState.queries).toEqual([{ text: 'SELECT $1 as name', values: ['john'] }]);
    expect(result.records).toEqual([{ name: 'john' }]);
    expect(result.rowCount).toBe(1);
    expect(pgMockState.releases).toBe(1);
  });

  test('runs BEGIN/COMMIT around a transaction and releases the client once', async () => {
    const db = new PostgreSQLDatabase(baseConfig);

    const outcome = await db.withTransaction(async (txDb) => {
      await txDb.executeQuery('SELECT :num as num', { num: 7 });
      return 'done';
    });

    expect(outcome).toBe('done');
    expect(pgMockState.queries.map((entry) => entry.text)).toEqual([
      'BEGIN',
      'SELECT $1 as num',
      'COMMIT',
    ]);
    expect(pgMockState.releases).toBe(1);
  });

  test('issues ROLLBACK and rethrows when the callback fails', async () => {
    const db = new PostgreSQLDatabase(baseConfig);

    await expect(
      db.withTransaction(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(pgMockState.queries.map((entry) => entry.text)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(pgMockState.releases).toBe(1);
  });

  test('rejects queries once disconnect has started', async () => {
    const db = new PostgreSQLDatabase(baseConfig);
    const pendingDisconnect = db.disconnect();

    await expect(db.executeQuery('SELECT 1')).rejects.toThrow(
      'Cannot execute query: database is shutting down'
    );
    await expect(db.withTransaction(async () => undefined)).rejects.toThrow(
      'Cannot start transaction: database is shutting down'
    );

    await pendingDisconnect;
  });

  test('releases the client and rethrows when a query fails', async () => {
    pgMockState.results.push({ rows: [], rowCount: 0, error: 'syntax error at or near "INVALID"' });

    const db = new PostgreSQLDatabase(baseConfig);
    await expect(db.executeQuery('INVALID SQL QUERY')).rejects.toThrow('syntax error');
    expect(pgMockState.releases).toBe(1);

    // The instance stays usable once the failed client is released
    pgMockState.results.push({ rows: [{ test: 1 }], rowCount: 1 });
    const result = await db.executeQuery<{ test: number }>('SELECT 1 as test');
    expect(result.records[0].test).toBe(1);
    expect(pgMockState.releases).toBe(2);
  });
});
```

This mock enables cheap regression tests for behavior that is otherwise hard to observe: the exact positional SQL the driver receives, `BEGIN`/`COMMIT`/`ROLLBACK` ordering, and — through `pgMockState.releases` — connection-leak regressions on every code path.

### Stubbing the Database for Service Tests

For application services that accept a `PostgreSQLDatabase`, spy on the public methods of a real (never-connected) instance. The pool is lazy, so no server is contacted, and the stub keeps the exact method signatures:

```typescript
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

/** Application service under test. */
class UserService {
  public constructor(private readonly db: PostgreSQLDatabase) {}

  public async findActiveUsers(): Promise<UserRow[]> {
    const { records } = await this.db.executeQuery<UserRow>(
      'SELECT id, name, email, active FROM users WHERE active = :active',
      { active: true }
    );
    return records;
  }

  public async deactivate(id: number): Promise<void> {
    await this.db.withTransaction(async (txDb) => {
      await txDb.executeQuery('UPDATE users SET active = false WHERE id = :id', { id });
    });
  }
}

const baseConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

describe('UserService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('findActiveUsers returns the records produced by the query', async () => {
    const db = new PostgreSQLDatabase(baseConfig);
    const spy = vi.spyOn(db, 'executeQuery').mockResolvedValue({
      records: [{ id: 1, name: 'Ada', email: 'ada@example.com', active: true }],
      rowCount: 1,
      fields: [],
    });

    const users = await new UserService(db).findActiveUsers();

    expect(users).toEqual([{ id: 1, name: 'Ada', email: 'ada@example.com', active: true }]);
    expect(spy).toHaveBeenCalledWith(
      'SELECT id, name, email, active FROM users WHERE active = :active',
      { active: true }
    );
  });

  test('deactivate runs the update inside a transaction', async () => {
    const db = new PostgreSQLDatabase(baseConfig);
    const executeSpy = vi.spyOn(db, 'executeQuery').mockResolvedValue({
      records: [],
      rowCount: 1,
      fields: [],
    });
    const transactionSpy = vi
      .spyOn(db, 'withTransaction')
      .mockImplementation(async (fn) => fn(db));

    await new UserService(db).deactivate(42);

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith('UPDATE users SET active = false WHERE id = :id', {
      id: 42,
    });
  });
});
```

The `withTransaction` stub (`mockImplementation(async (fn) => fn(db))`) runs the transaction body against the same stubbed instance, so spies on `executeQuery` apply inside the callback too.

---

## Test Patterns by Feature

| Feature | Unit (no server) | Integration (Docker) |
| --- | --- | --- |
| Configuration and pool options | Constructor assertions | — |
| Query execution (`executeQuery`) | Compiled SQL, release (driver mock) | Parameters, fields, empty results, injection safety |
| Transactions | `BEGIN`/`COMMIT`/`ROLLBACK` (driver mock) | Commit, rollback, constraint violations |
| INSERT | SQL shape, values validation | `RETURNING`, `executeReturn*` terminators |
| UPDATE | SQL shape, `v_`/`pN` namespaces | Filters, affected-row counts |
| DELETE | SQL shape, bulk delete | Filters, null/empty results, cascades |
| SELECT (`from`, `selectAll`) | Compiled SQL (driver mock) | Column selection, aliases, expressions |
| Query hooks | `beforeQuery` transformation (driver mock) | Masking, normalization, combined hooks |
| Lifecycle and errors | Shutdown guards (driver mock) | Invalid SQL recovery, unreachable host |

### Query Execution

`executeQuery()` is the workhorse; test it for parameter passing, type mapping, column metadata, empty results, and injection safety. All four patterns in one file:

```typescript
import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

describe('executeQuery', () => {
  test('passes named parameters and returns typed records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    try {
      const result = await db.executeQuery<{ name: string; time: Date }>(
        'SELECT :name as name, now() as time',
        { name: 'john' }
      );

      expect(result.rowCount).toBe(1);
      expect(result.records[0].name).toBe('john');
      expect(result.records[0].time).toBeInstanceOf(Date);
    } finally {
      await db.disconnect();
    }
  });

  test('reports column metadata for the returned columns', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    try {
      const result = await db.executeQuery<{ id: number; name: string; active: boolean }>(
        'SELECT 1 as id, :name as name, true as active',
        { name: 'test' }
      );

      expect(result.fields.map((column) => column.name)).toEqual(['id', 'name', 'active']);
      expect(result.records[0]).toEqual({ id: 1, name: 'test', active: true });
    } finally {
      await db.disconnect();
    }
  });

  test('returns empty structures when no rows match', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    try {
      await db.executeQuery(`
        CREATE TEMP TABLE empty_test (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100)
        )
      `);

      const result = await db.executeQuery<{ id: number; name: string }>(
        'SELECT * FROM empty_test WHERE id = :id',
        { id: 999 }
      );

      expect(result).toEqual({ records: [], rowCount: 0, fields: [] });
    } finally {
      await db.disconnect();
    }
  });

  test('treats malicious input as a literal value (injection safety)', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    try {
      const maliciousInput = "'; DROP TABLE injection_test; --";

      await db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE injection_test (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100)
          )
        `);
        await txDb.executeQuery('INSERT INTO injection_test (name) VALUES (:name)', {
          name: 'legitimate_user',
        });

        const injected = await txDb.executeQuery<{ id: number; name: string }>(
          'SELECT * FROM injection_test WHERE name = :name',
          { name: maliciousInput }
        );
        expect(injected.records).toEqual([]);
        expect(injected.rowCount).toBe(0);

        // The table survived because the payload was a parameter, not SQL text
        const legit = await txDb.executeQuery<{ id: number; name: string }>(
          'SELECT * FROM injection_test WHERE name = :name',
          { name: 'legitimate_user' }
        );
        expect(legit.rowCount).toBe(1);
      });
    } finally {
      await db.disconnect();
    }
  });
});
```

Key assertions for this feature:

- **Type mapping** — cast explicitly in test SQL (`:int_val::integer`) and assert accordingly:

| PostgreSQL type | Returned as | Assertion pattern |
| --- | --- | --- |
| `INTEGER` / `SERIAL` | `number` | `expect(value).toBe(42)` |
| `DECIMAL` / `NUMERIC` | `string` | `expect(price).toBe('29.99')` or `parseFloat(price)` |
| `COUNT(*)` (bigint) | `string` | `parseInt(count, 10)` |
| `BOOLEAN` | `boolean` | `expect(flag).toBe(true)` |
| `TIMESTAMP` | `Date` | `expect(value).toBeInstanceOf(Date)` |
| `JSONB` | parsed object/array | `expect(value).toEqual({ ... })` |

- **Empty results** come back as exactly `{ records: [], rowCount: 0, fields: [] }` — assert the whole object.
- **SQL injection safety** is verified by round-tripping a payload through a named parameter and checking that it matches nothing and destroys nothing.
- For the unit-level counterpart (asserting the compiled `$1`-style SQL), see [Mocking & Stubbing](#mocking--stubbing).

### Transactions

Test the three outcomes — commit, rollback, and server-side failure — plus the fact that the instance is immediately reusable afterwards:

```typescript
import { describe, expect, test } from 'vitest';
import { withTestDatabase } from './helpers.js';

interface BalanceRow {
  balance: string;
}

describe('withTransaction', () => {
  test('commits a successful transaction and keeps the data', async () => {
    const created = await withTestDatabase(async (db) => {
      const row = await db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL
          )
        `);

        await txDb.executeQuery(
          'INSERT INTO test_users (name, email) VALUES (:name, :email)',
          { name: 'John Doe', email: 'john@example.com' }
        );

        const { records } = await txDb.executeQuery<{ id: number; name: string; email: string }>(
          'SELECT * FROM test_users WHERE email = :email',
          { email: 'john@example.com' }
        );
        return records[0];
      });

      // The pooled connection is reused, so the session-local temp table is
      // still visible after the transaction commits
      const { rowCount } = await db.executeQuery(
        'SELECT name FROM test_users WHERE email = :email',
        { email: 'john@example.com' }
      );

      return { row, rowCount };
    });

    expect(created.row).toEqual({
      id: expect.any(Number),
      name: 'John Doe',
      email: 'john@example.com',
    });
    expect(created.rowCount).toBe(1);
  });

  test('rolls the transaction back when the callback throws', async () => {
    const after = await withTestDatabase(async (db) => {
      await db.executeQuery(`
        CREATE TEMP TABLE test_products (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          price DECIMAL(10,2) NOT NULL
        )
      `);
      await db.executeQuery('INSERT INTO test_products (name, price) VALUES (:name, :price)', {
        name: 'Initial Product',
        price: 10.0,
      });

      const failing = db.withTransaction(async (txDb) => {
        await txDb.executeQuery('INSERT INTO test_products (name, price) VALUES (:name, :price)', {
          name: 'Should Be Rolled Back',
          price: 20.0,
        });
        throw new Error('Intentional error to test rollback');
      });

      await expect(failing).rejects.toThrow('Intentional error to test rollback');

      return db.executeQuery<{ name: string; price: string }>(
        'SELECT name, price FROM test_products ORDER BY id'
      );
    });

    expect(after.rowCount).toBe(1);
    expect(after.records[0]).toEqual({ name: 'Initial Product', price: '10.00' });
  });

  test('rolls back on a unique-constraint violation', async () => {
    const after = await withTestDatabase(async (db) => {
      await db.executeQuery(`
        CREATE TEMP TABLE test_emails (
          id SERIAL PRIMARY KEY,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);
      await db.executeQuery('INSERT INTO test_emails (email) VALUES (:email)', {
        email: 'unique@example.com',
      });

      const failing = db.withTransaction(async (txDb) => {
        await txDb.executeQuery('INSERT INTO test_emails (email) VALUES (:email)', {
          email: 'another@example.com',
        });
        // Violates the UNIQUE constraint — the whole transaction, including the
        // insert above, must roll back
        await txDb.executeQuery('INSERT INTO test_emails (email) VALUES (:email)', {
          email: 'unique@example.com',
        });
      });

      await expect(failing).rejects.toThrow();

      return db.executeQuery<{ email: string }>('SELECT email FROM test_emails ORDER BY id');
    });

    expect(after.rowCount).toBe(1);
    expect(after.records[0]).toEqual({ email: 'unique@example.com' });
  });
});
```

Additional patterns worth covering:

- **Empty transactions** — `db.withTransaction(async () => 'empty transaction completed')` resolves with the callback's return value.
- **Instance reuse after rollback** — the verification queries above prove the instance accepts new work immediately; a failed transaction never leaks its client.
- **Unit-level control flow** — `BEGIN`/`COMMIT`/`ROLLBACK` ordering and single release per transaction are asserted with the driver mock in [Mocking & Stubbing](#mocking--stubbing).
- **Do not nest transactions** on the same instance — the pinned client is instance state; treat the instance as busy for the duration of a transaction.

### INSERT Statements

Integration-test the `RETURNING` round-trip and the `executeReturn*` terminators:

```typescript
import { describe, expect, test } from 'vitest';
import { withTestDatabase } from './helpers.js';

interface TestUser {
  id?: number;
  name: string;
  email: string;
  created_at?: Date;
}

describe('INSERT builders', () => {
  test('inserts one row and returns it with executeReturnSingle', async () => {
    const created = await withTestDatabase(async (db) => {
      return db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_return_single (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
          )
        `);

        return txDb
          .insert<TestUser>('test_return_single')
          .values({ name: 'Single Return Test', email: 'single@example.com' })
          .returning('*')
          .executeReturnSingle();
      });
    });

    expect(created).toMatchObject({
      name: 'Single Return Test',
      email: 'single@example.com',
    });
    expect(created?.id).toBeDefined();
    expect(created?.created_at).toBeDefined();
  });

  test('counts inserted rows with executeReturnCount', async () => {
    const insertedCount = await withTestDatabase(async (db) => {
      return db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_return_count (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            description TEXT
          )
        `);

        return txDb
          .insert<{ name: string; description?: string }>('test_return_count')
          .values({ name: 'Count Test', description: 'Testing count functionality' })
          .executeReturnCount();
      });
    });

    expect(insertedCount).toBe(1);
  });
});
```

Additional patterns:

- **Column subsets** — `.returning(['id', 'name', 'email'])` limits the returned row; assert excluded columns with `expect(result).not.toHaveProperty('age')`. Choose columns that are keys of your row interface so no cast is needed.
- **`executeReturnAll`** resolves with `T[]` — assert `Array.isArray(result)` and length.
- **Values validation** — building an INSERT with no values throws `Cannot build INSERT statement ...: no values provided`; cover it in the synchronous white-box unit tests (see [SQL Generation Without a Database](#sql-generation-without-a-database)).

### UPDATE Statements

Test filtered updates (only matching rows change) and affected-row counts:

```typescript
import { describe, expect, test } from 'vitest';
import { withTestDatabase } from './helpers.js';

interface TestProduct {
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

describe('UPDATE builders', () => {
  test('updates only the rows matching all filter conditions', async () => {
    const updated = await withTestDatabase(async (db) => {
      return db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_products (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            price DECIMAL(10,2) NOT NULL,
            category VARCHAR(50) NOT NULL,
            in_stock BOOLEAN DEFAULT true,
            updated_at TIMESTAMP DEFAULT NOW()
          )
        `);
        await txDb.executeQuery(
          'INSERT INTO test_products (name, price, category, in_stock) VALUES (:name, :price, :category, :in_stock)',
          { name: 'Test Product', price: 29.99, category: 'Electronics', in_stock: true }
        );

        await txDb
          .update<TestProduct, ProductFilter>('test_products')
          .values({ price: 24.99, in_stock: false })
          .filter({ category: 'Electronics', in_stock: true })
          .execute();

        return txDb.executeQuery<TestProduct>(
          'SELECT * FROM test_products WHERE name = :name',
          { name: 'Test Product' }
        );
      });
    });

    expect(updated.rowCount).toBe(1);
    expect(updated.records[0]).toMatchObject({
      price: '24.99',
      category: 'Electronics',
      in_stock: false,
    });
  });

  test('returns the number of updated rows with executeReturnCount', async () => {
    const updatedCount = await withTestDatabase(async (db) => {
      return db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_update_return_count (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            category VARCHAR(50) NOT NULL,
            active BOOLEAN DEFAULT true
          )
        `);
        await txDb.executeQuery(`
          INSERT INTO test_update_return_count (name, category) VALUES
            ('Count Test 1', 'Count Category'),
            ('Count Test 2', 'Count Category'),
            ('Count Test 3', 'Other Category')
        `);

        return txDb
          .update<{ active: boolean }, { category: string }>('test_update_return_count')
          .values({ active: false })
          .filter({ category: 'Count Category' })
          .executeReturnCount();
      });
    });

    expect(updatedCount).toBe(2);
  });
});
```

Additional patterns:

- **Parameter namespaces in hooks** — UPDATE value parameters are `v_`-prefixed (`v_email`) while filter parameters are `p1…pN`; a `beforeQuery` hook that touches both must handle each namespace (see [Query Hooks](#query-hooks)).
- **Bulk updates** — an empty or absent filter updates every row; assert with a follow-up `COUNT(*)` (remember it returns a string: `parseInt(count, 10)`).
- **`executeReturnSingle` with a subset** — `.returning(['id', 'name', 'email'])` returns only those columns; assert excluded columns are absent.
- **Validation** — `.values({})` throws on build; covered by the white-box unit tests.

### DELETE Statements

Test filtered deletes, the no-match shapes (`null`, `[]`, `0`), and cascades:

```typescript
import { describe, expect, test } from 'vitest';
import { withTestDatabase } from './helpers.js';

interface ProductFilter {
  category?: string;
  in_stock?: boolean;
}

describe('DELETE builders', () => {
  test('deletes only the rows matching the filter', async () => {
    const remaining = await withTestDatabase(async (db) => {
      return db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_products (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            category VARCHAR(50) NOT NULL,
            in_stock BOOLEAN DEFAULT true
          )
        `);
        await txDb.executeQuery(`
          INSERT INTO test_products (name, category, in_stock) VALUES
            ('Product 1', 'Electronics', false),
            ('Product 2', 'Electronics', true)
        `);

        await txDb
          .delete<ProductFilter>('test_products')
          .filter({ category: 'Electronics', in_stock: false })
          .execute();

        return txDb.executeQuery<{ name: string }>('SELECT name FROM test_products');
      });
    });

    expect(remaining.rowCount).toBe(1);
    expect(remaining.records[0]).toEqual({ name: 'Product 2' });
  });

  test('returns null, an empty array, and 0 for deletes that match no rows', async () => {
    const outcome = await withTestDatabase(async (db) => {
      return db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_delete_no_match (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL
          )
        `);

        const single = await txDb
          .delete<{ email: string }>('test_delete_no_match')
          .filter({ email: 'nonexistent@example.com' })
          .returning('*')
          .executeReturnSingle();

        const all = await txDb
          .delete<{ email: string }>('test_delete_no_match')
          .filter({ email: 'nonexistent@example.com' })
          .returning('*')
          .executeReturnAll();

        const count = await txDb
          .delete<{ email: string }>('test_delete_no_match')
          .filter({ email: 'nonexistent@example.com' })
          .executeReturnCount();

        return { single, all, count };
      });
    });

    expect(outcome.single).toBeNull();
    expect(outcome.all).toEqual([]);
    expect(outcome.count).toBe(0);
  });
});
```

Additional patterns:

- **Bulk delete** — `.filter({})` produces a bare `DELETE FROM table`; verify with `SELECT COUNT(*)` and `parseInt(count, 10) === 0`.
- **Cascades** — create parent and child temp tables with `REFERENCES parent(id) ON DELETE CASCADE`, delete the parent through the builder, and assert the child `COUNT(*)` is 0.
- **Computed `RETURNING`** — SQL expressions such as `first_name || ' ' || last_name as full_name` are not expressible through `.returning()`; the package's suite covers those with raw `executeQuery` + `RETURNING` and asserts the computed column. Test both shapes.
- **Unit view** — the generated SQL and parameter maps (`:p1`, empty-filter bulk form) are covered by the white-box tests in [SQL Generation Without a Database](#sql-generation-without-a-database).

### SELECT Statements

Reads use the inherited `db.from()` and `db.selectAll()` factories. Integration-test column selection, aliases, and expression filters; unit-test the compiled SQL against the driver mock.

```typescript
import { describe, expect, test } from 'vitest';
import { query } from 'blendsdk/expression';
import { withTestDatabase } from './helpers.js';

interface TestUser {
  id?: number;
  name: string;
  age?: number;
  active?: boolean;
}

describe('SELECT builders', () => {
  test('selects and aliases specific columns', async () => {
    const selected = await withTestDatabase(async (db) => {
      return db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_aliases (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) NOT NULL,
            age INTEGER
          )
        `);
        await txDb.executeQuery(
          'INSERT INTO test_aliases (name, email, age) VALUES (:name, :email, :age)',
          { name: 'Alias Test', email: 'alias@example.com', age: 30 }
        );

        return txDb
          .from('test_aliases')
          .select({ user_id: 'id', user_name: 'name', user_email: 'email' })
          .execute();
      });
    });

    expect(selected?.rowCount).toBe(1);
    expect(selected?.records[0]).toMatchObject({
      user_id: expect.any(Number),
      user_name: 'Alias Test',
      user_email: 'alias@example.com',
    });
    expect(selected?.records[0]).not.toHaveProperty('name');
  });

  test('filters rows with a compiled expression', async () => {
    const result = await withTestDatabase(async (db) => {
      return db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_expression_users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            age INTEGER,
            active BOOLEAN DEFAULT true
          )
        `);
        await txDb.executeQuery(`
          INSERT INTO test_expression_users (name, age, active) VALUES
            ('John Doe', 25, true),
            ('Jane Smith', 30, true),
            ('Bob Johnson', 25, false)
        `);

        const expression = query<TestUser>().where('age').equals(25).compile();

        return txDb
          .from<TestUser>('test_expression_users')
          .select()
          .byExpression(expression)
          .execute();
      });
    });

    expect(result?.rowCount).toBe(2);
  });
});
```

For the unit view, execute the builder against the driver mock and assert the compiled SQL (`tests/pg-mock.ts` registration as in [Mocking & Stubbing](#mocking--stubbing)):

```typescript
import { beforeEach, expect, test, vi } from 'vitest';
import { query } from 'blendsdk/expression';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';
import { pgMockState, resetPgMockState } from './pg-mock.js';

vi.mock('pg', async () => {
  const { MockPool } = await import('./pg-mock.js');
  return { Pool: MockPool };
});

interface MockUser {
  id?: number;
  age?: number;
}

const baseConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

beforeEach(() => {
  resetPgMockState();
});

test('a from() select compiles its expression into a positional WHERE clause', async () => {
  pgMockState.results.push({ rows: [{ id: 1 }], rowCount: 1 });

  const db = new PostgreSQLDatabase(baseConfig);
  const expression = query<MockUser>().where('age').equals(25).compile();

  await db.from<MockUser>('users').select(['id']).byExpression(expression).execute();

  expect(pgMockState.queries).toEqual([
    { text: 'SELECT id FROM users WHERE age = $1', values: [25] },
  ]);
});
```

Additional patterns:

- **`db.selectAll(table)`** is the convenience form of `db.from(table).select()`; both return the dbcore `FromStatement` (asserted in the factory unit tests).
- **Expression operators** — the package's `from.test.ts` exercises `equals`, `greaterThan`, `lessThan`, `in`, `like`, `between`, `isNull`, `isNotNull`, and nested `and`/`or` groups; cover the operators your application uses and assert both `rowCount` and the parameter values (`p1…pN` in white-box form, positional in compiled form).
- **Computed and `CASE` aliases** — object-syntax selects accept expressions (`{ full_name: "first_name || ' ' || last_name" }`); integration-test the computed values directly.

### Query Hooks

Hooks run at two points: `beforeQuery` transforms the parameter map before compilation, `afterQuery` transforms result rows before they reach your code. Integration-test the combined normalization-and-masking pattern:

```typescript
import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

interface AccountRow {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
  role?: string;
}

describe('statement hooks', () => {
  test('beforeQuery normalizes input and afterQuery masks sensitive fields', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    try {
      const created = await db.withTransaction(async (txDb) => {
        await txDb.executeQuery(`
          CREATE TEMP TABLE test_combined_hooks (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255),
            role VARCHAR(20) DEFAULT 'user',
            created_at TIMESTAMP DEFAULT NOW()
          )
        `);

        return txDb
          .insert<AccountRow>('test_combined_hooks')
          .values({
            name: 'Combined Test',
            email: 'COMBINED@EXAMPLE.COM',
            password_hash: 'plaintext123',
            role: 'admin',
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
          .afterQuery((records) =>
            records.map((record) => {
              const safe = { ...record };
              delete safe.password_hash;
              return safe;
            })
          )
          .returning('*')
          .executeReturnSingle();
      });

      expect(created).toMatchObject({
        name: 'Combined Test',
        email: 'combined@example.com',
        role: 'admin',
      });
      expect(created).not.toHaveProperty('password_hash');
    } finally {
      await db.disconnect();
    }
  });
});
```

The unit view with the driver mock proves that `beforeQuery` runs **before** compilation — the recorded values are the transformed ones (`tests/pg-mock.ts` registration as in [Mocking & Stubbing](#mocking--stubbing)):

```typescript
import { beforeEach, expect, test, vi } from 'vitest';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';
import { pgMockState, resetPgMockState } from './pg-mock.js';

vi.mock('pg', async () => {
  const { MockPool } = await import('./pg-mock.js');
  return { Pool: MockPool };
});

const baseConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

beforeEach(() => {
  resetPgMockState();
});

test('beforeQuery transforms parameters before compilation', async () => {
  const db = new PostgreSQLDatabase(baseConfig);

  await db
    .insert<{ email: string }>('users')
    .values({ email: 'UPPER@EXAMPLE.COM' })
    .beforeQuery((params) => {
      const transformed = { ...params };
      if (typeof transformed.email === 'string') {
        transformed.email = transformed.email.toLowerCase();
      }
      return transformed;
    })
    .execute();

  expect(pgMockState.queries).toEqual([
    { text: 'INSERT INTO users (email) VALUES ($1)', values: ['upper@example.com'] },
  ]);
});
```

Additional patterns:

- **Parameter namespaces in hooks** — INSERT parameters are keyed by column name; UPDATE parameters are `v_`-prefixed values plus `p1…pN` filters; DELETE parameters are `p1…pN`. Hooks that transform filters (e.g., normalizing an email before a delete) must target `params.p1`.
- **`executeQuery` options** — the same transforms are available per call via `options.beforeQuery` / `options.afterQuery`; note that `afterQuery` is skipped when a query returns zero rows.
- **Errors propagate** — make a hook throw and assert the operation rejects (and, inside a transaction, that it rolls back).

### Lifecycle and Error Handling

Cover the shutdown guards and the failure paths that must not corrupt or wedge the instance:

```typescript
import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase, PostgreSQLConfig } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

describe('lifecycle and errors', () => {
  test('rejects invalid SQL and stays usable afterwards', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    try {
      await expect(db.executeQuery('INVALID SQL QUERY')).rejects.toThrow();

      // The failed client was released — the instance accepts new work
      const result = await db.executeQuery<{ test: number }>('SELECT 1 as test');
      expect(result.records[0].test).toBe(1);
    } finally {
      await db.disconnect();
    }
  });

  test('disconnects cleanly even when no query ever ran', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    await expect(db.disconnect()).resolves.not.toThrow();
  });

  test('rejects when the server is unreachable and still disconnects cleanly', async () => {
    const unreachable: PostgreSQLConfig = {
      ...connectionConfig,
      host: 'invalid-host',
      port: 9999,
    };
    const db = new PostgreSQLDatabase(unreachable);

    await expect(db.executeQuery('SELECT 1')).rejects.toThrow();
    await expect(db.disconnect()).resolves.not.toThrow();
  });
});
```

Additional patterns:

- **Shutdown guards (unit, driver mock)** — after `disconnect()` starts, `executeQuery` rejects with `Cannot execute query: database is shutting down` and `withTransaction` rejects with `Cannot start transaction: database is shutting down`; both are asserted in [Mocking & Stubbing](#mocking--stubbing).
- **Release accounting** — `pgMockState.releases` makes connection leaks detectable: every atomic query and every transaction must increment it exactly once.
- **Timeout behavior** — `disconnect(timeoutMs)` falls back to forced client release after the timeout; there is no need to simulate this in consumer tests, but calling `disconnect(5000)` explicitly is a valid assertion that custom timeouts are accepted.

---

**Working rules for this package:** run `pnpm run test:fast` while writing SQL-generation tests (no Docker required); run the full Docker-orchestrated suite before committing integration changes; assert on real rows rather than mocks whenever the behavior involves SQL semantics; and reserve mocking for the driver boundary, where it buys speed without hiding the parameter compilation and transaction control that make this package worth testing.

---

# postgresql Troubleshooting

This document covers the errors you will encounter when working with `blendsdk/postgresql`, how to diagnose them, and the subtle behaviors that cause most "impossible" bugs. Errors surface from four layers, and knowing which layer produced a message is the fastest route to a fix:

| Layer | Example message | Error carries |
| --- | --- | --- |
| Adapter guards (`PostgreSQLDatabase`) | `Cannot execute query: database is shutting down` | Plain `Error`, no code |
| Statement builders | `Cannot build UPDATE statement for table "users": no values provided...` | Plain `Error`, no code |
| Driver and pool (`pg`, `yesql`) | `connect ECONNREFUSED 127.0.0.1:5432`, `timeout exceeded when trying to connect` | Plain `Error` with Node/driver codes (`ECONNREFUSED`, `ENOTFOUND`, `CONNECTION_TIMEOUT`, …) |
| PostgreSQL server | `duplicate key value violates unique constraint "users_email_key"` | `DatabaseError` from `pg` with a SQLSTATE in `error.code` (e.g. `23505`) |

All asynchronous failures arrive as rejected promises — `executeQuery()`, `withTransaction()`, the builder `execute*` terminators, and `disconnect()` — so normal `try`/`catch` handling applies everywhere.

---

## Common Errors

### Connection and Authentication Errors

#### `Cannot execute query: database is shutting down` / `Cannot start transaction: database is shutting down`

**Error message**

```text
Cannot execute query: database is shutting down
Cannot start transaction: database is shutting down
```

**Cause**

`disconnect()` sets the internal `isShuttingDown` flag as its very first action — before the pool has actually closed, and even if closing later fails. From that moment, every new `executeQuery()` and `withTransaction()` on that instance is rejected by the guard, and the flag is never reset.

Typical triggers:

- A shutdown path (signal handler, test cleanup, `finally` block) that runs while other code is still issuing queries.
- A single long-lived instance shared by modules where one module disconnects it while another still uses it.
- Test suites where an `afterEach` hook disconnects an instance a second time after the test already did.

**Fix**

Make the shutdown single-owner and sequence it after all in-flight work. A disconnected instance is a one-way door — if you need to keep working, create a new instance.

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

await db.executeQuery('SELECT pg_sleep(0.1)'); // all work completes first…
await db.disconnect();                          // …then the pool closes

try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message); // Cannot execute query: database is shutting down
  }
}

// The instance cannot be revived — create a new one instead.
const fresh = new PostgreSQLDatabase(config);
try {
  await fresh.executeQuery('SELECT 1');
} finally {
  await fresh.disconnect();
}
```

---

#### `connect ECONNREFUSED 127.0.0.1:5432`

**Error message**

```text
Error: connect ECONNREFUSED 127.0.0.1:5432
```

The error is a plain `Error` (not a `DatabaseError`) with `error.code === 'ECONNREFUSED'`.

**Cause**

Nothing is listening on the configured host and port: the PostgreSQL server is not running, the port in `PostgreSQLConfig` does not match the port the server listens on (common with Docker port mappings), or a firewall rejects the connection. Because the constructor builds a lazy `pg.Pool`, creating the instance never fails — the very first query does, and `disconnect()` still resolves cleanly afterwards.

**Fix**

1. Confirm the server is reachable: `pg_isready -h localhost -p 5432`.
2. Align `host`/`port` in `PostgreSQLConfig` with the actual server (for the package's own test database, the docker container must be started, e.g. `pnpm run db:up`).
3. Re-run a minimal query to confirm.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432, // must match the port PostgreSQL actually listens on
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config); // never throws — the pool connects lazily

try {
  const { records } = await db.executeQuery<{ ok: number }>('SELECT 1 AS ok');
  console.log(records[0].ok);
} catch (error) {
  console.error('First query failed — verify the server is running and reachable:', error);
} finally {
  await db.disconnect(); // always safe, even when the query failed
}
```

---

#### `getaddrinfo ENOTFOUND database.internal`

**Error message**

```text
Error: getaddrinfo ENOTFOUND database.internal
```

`error.code === 'ENOTFOUND'`.

**Cause**

DNS resolution of the `host` failed: typo in the hostname, a hostname that only resolves inside another network, or a Docker service name resolved from the wrong place. Inside a container, `localhost` means that container — not the database container.

**Fix**

Use a hostname that resolves from where the code runs. Inside a Compose network, use the service name (the package's compose service is called `postgres-test`):

```typescript fragment
import { PostgreSQLConfig } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'postgres-test', // resolves inside the compose network — not 'localhost'
  port: 5432,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
};
```

Verify with `nslookup database.internal` (or `getent hosts database.internal`) before blaming the adapter.

---

#### `password authentication failed for user "app"`

**Error message**

```text
error: password authentication failed for user "app"
```

SQLSTATE `28P01`, surfaced as a `DatabaseError`.

**Cause**

The `user`/`pass` pair in `PostgreSQLConfig` does not match an existing role, or the environment you are pointing at uses different credentials than expected. Note that `pass` is mapped to the driver's `password` option — `.pgpass` files and `PGPASSWORD` are not consulted.

**Fix**

Confirm the credentials interactively first: `psql "postgresql://app:secret@localhost:5432/appdb" -c 'SELECT 1'`. Then correct the configuration, and switch on the SQLSTATE in code when you need to report it:

```typescript fragment
import { DatabaseError } from 'pg';

try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  if (error instanceof DatabaseError && error.code === '28P01') {
    console.error('Check PostgreSQLConfig.user / PostgreSQLConfig.pass against the actual role credentials');
  }
  throw error;
}
```

---

#### `database "appdb" does not exist`

**Error message**

```text
error: database "appdb" does not exist
```

SQLSTATE `3D000`.

**Cause**

The `database` name in the configuration was never created, was misspelled, or belongs to a different environment. Unlike the host and port, this can only be verified after a successful connection, so it appears as the first query's failure.

**Fix**

Connect to the maintenance database `postgres` and list the available databases:

```typescript fragment
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const maintenanceConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'postgres', // always-present maintenance database
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(maintenanceConfig);
const { records } = await db.executeQuery<{ datname: string }>(
  'SELECT datname FROM pg_database ORDER BY datname'
);
console.log(records.map((row) => row.datname));
await db.disconnect();
```

Then set `database` to the correct name (or create the database).

---

#### `timeout exceeded when trying to connect` / `Connection terminated due to connection timeout`

**Error message**

```text
Error: timeout exceeded when trying to connect
Error: Connection terminated due to connection timeout
```

**Cause**

Both come from the driver layer and both are governed by `poolConfig.connectionTimeoutMillis`:

- `timeout exceeded when trying to connect` — the pool could not hand a client to a caller within `connectionTimeoutMillis` (connection establishment, or waiting while all pooled clients are busy).
- `Connection terminated due to connection timeout` — a TCP connection attempt itself did not complete in time (unreachable host that blackholes packets).

The driver default is `connectionTimeoutMillis: 0`, meaning **no timeout at all** — with an exhausted pool or an unreachable host, queries can wait forever and the process appears to hang. If you set `connectionTimeoutMillis`, saturation fails fast instead.

**Fix**

Always set `connectionTimeoutMillis` in production configurations, and use the pool-statistics technique from [Debugging Strategies](#debugging-strategies) to find out why the pool was saturated (leaked clients, long transactions, or a large concurrent burst).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  poolConfig: {
    max: 10,
    connectionTimeoutMillis: 5000, // fail fast instead of waiting forever
    idleTimeoutMillis: 30000,
  },
};

const db = new PostgreSQLDatabase(config);

try {
  const { records } = await db.executeQuery<{ ok: number }>('SELECT 1 AS ok');
  console.log(records[0].ok);
} finally {
  await db.disconnect();
}
```

---

#### `Connection terminated unexpectedly`

**Error message**

```text
Error: Connection terminated unexpectedly
```

**Cause**

The server closed a connection that was in use: a server restart, `pg_terminate_backend()`, a network drop, or an idle-connection reset by a proxy/firewall. Any transaction on that connection is lost — nothing is committed, and there is no automatic retry.

**Fix**

Treat it as a transport failure: let it propagate out of `withTransaction()` (the adapter attempts a `ROLLBACK`, which fails harmlessly and is logged — your original error is rethrown), then decide whether to retry the whole unit of work. The pool discards dead clients, so the same instance is usable again afterwards.

```typescript fragment
try {
  await db.withTransaction(async (tx) => {
    await tx.executeQuery('UPDATE accounts SET balance = balance - :amount WHERE id = :id', {
      amount: 100,
      id: 1,
    });
  });
} catch (error) {
  if (error instanceof Error && error.message.includes('Connection terminated unexpectedly')) {
    // Nothing was committed. Retry the entire unit once with fresh state —
    // never retry statement-by-statement inside the rolled-back transaction.
  }
  throw error;
}
```

---

### Statement Builder Errors

#### `Cannot build INSERT statement for table "users": no values provided...`

**Error message**

```text
Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.
```

**Cause**

The INSERT builder was executed (or its query built) before `.values(...)` was called, or `.values({})` was called with an empty object — for example when a conditional object turned out empty at runtime. An INSERT with no columns is invalid SQL, so the builder refuses to generate it.

**Fix**

Always pass at least one column. When the values object is built dynamically, guard against the empty case:

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
  const created = await db
    .insert<UserRow>('users')
    .values({ name: 'Ada Lovelace', email: 'ada@example.com' })
    .returning('*')
    .executeReturnSingle();

  console.log(created?.id);
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  }
} finally {
  await db.disconnect();
}
```

Guard for the dynamic case:

```typescript fragment
function hasColumns<T>(values: Partial<T>): boolean {
  return Object.keys(values).length > 0;
}

const values: Partial<UserRow> = { name: 'Ada Lovelace' };

if (!hasColumns(values)) {
  throw new Error('Nothing to insert — .values() needs at least one column');
}

await db.insert<UserRow>('users').values(values).execute();
```

---

#### `Cannot build UPDATE statement for table "users": no values provided...`

**Error message**

```text
Cannot build UPDATE statement for table "users": no values provided. Call .values() with at least one column before executing.
```

**Cause**

Same validation as INSERT: an UPDATE with an empty `SET` clause is invalid SQL. A `.filter(...)` alone does not make an UPDATE valid — the filter only describes *which* rows, never *what* to change.

**Fix**

```typescript fragment
// The filter alone is not enough — UPDATE needs at least one SET column
await db
  .update<UserRow, UserFilter>('users')
  .values({ active: false })
  .filter({ email: 'ada@example.com' })
  .execute();
```

---

#### `executeReturnSingle()` resolves to `null` although rows were affected

**Symptom**

A DELETE or UPDATE clearly changed data (or `executeReturnCount()` reports rows), but `executeReturnSingle()` resolves `null` and `executeReturnAll()` resolves `[]`. No error is thrown.

**Cause**

You omitted `.returning(...)`. Without a `RETURNING` clause the statement produces no row data — only a row count — so the `executeReturn*` terminators have nothing to extract. The mutation succeeded; there is simply nothing to return. Note also that `execute()` can resolve `null`, so always guard its result.

**Fix**

Add `.returning('*')` (or an explicit column list) before the terminators that hand you rows. `.executeReturnCount()` never needs it — it uses the row count:

```typescript fragment
const removedSession = await db
  .delete<SessionFilter>('sessions')
  .filter({ user_id: 42 })
  .returning('*') // required — without this, executeReturnSingle() resolves to null
  .executeReturnSingle();

if (removedSession === null) {
  console.log('No session matched (or RETURNING was omitted)');
}

const affected = await db
  .delete<SessionFilter>('sessions')
  .filter({ status: 'expired' })
  .executeReturnCount(); // works without RETURNING — row count only
console.log(affected);
```

---

### SQL and Schema Errors

#### `error: relation "test_users" does not exist`

**Error message**

```text
error: relation "test_users" does not exist
```

SQLSTATE `42P01`.

**Cause**

Several very different problems produce this message:

- The table name is wrong or lives in a schema outside the connection's `search_path`.
- A migration was never applied in this environment.
- The table is a **temporary table** that was created on a different pooled connection. Temp tables are session-scoped, and the pool is free to hand your next query a different client — see [Known Pitfalls](#known-pitfalls).
- The table was created with a mixed-case quoted name (`CREATE TABLE "Users"`) — PostgreSQL folds unquoted identifiers to lowercase, so `users` and `Users` reference different objects.

**Fix**

Verify what actually exists, and address temp objects to the correct scope:

```typescript fragment
const { records } = await db.executeQuery<{ table_schema: string; table_name: string }>(
  `SELECT table_schema, table_name
     FROM information_schema.tables
    WHERE table_name = :name`,
  { name: 'test_users' }
);
console.log(records);
```

If your schema really uses mixed-case quoted identifiers, you must quote them in raw SQL: `SELECT * FROM "Users"`. Keep temporary tables inside a single `withTransaction()` so they always live on the pinned client.

---

#### `error: column "username" does not exist`

**Error message**

```text
error: column "username" does not exist
```

SQLSTATE `42703`.

**Cause**

The SQL references a column the table does not have: a typo, a stale schema, or a generic interface (`executeQuery<{ username: string }>`) that describes your *hope* rather than the table. TypeScript generics are compile-time only — they never validate against the database. The same error appears when `.values()` or `.filter()` on a builder uses a key that is not a real column.

**Fix**

Check the actual column list before matching it to an interface:

```typescript fragment
const { records } = await db.executeQuery<{ column_name: string; data_type: string }>(
  `SELECT column_name, data_type
     FROM information_schema.columns
    WHERE table_name = :table
    ORDER BY ordinal_position`,
  { table: 'users' }
);
console.log(records);
```

Keep the generic in sync with the schema, or generate the types from the schema instead of writing them by hand.

---

#### `error: syntax error at or near "order"`

**Error message**

```text
error: syntax error at or near "order"
```

SQLSTATE `42601`.

**Cause**

The SQL text itself is invalid: a typo, a reserved word used unquoted as a column or alias, or a statement that mixes named (`:name`) and positional (`$1`) placeholders — only the named ones are compiled by `yesql`, so positional markers left in the text do not line up with the values that are bound.

**Fix**

Run the bare SQL in `psql` first to isolate SQL problems from adapter problems, then:

```typescript fragment
// ❌ "order" is a reserved word — must be quoted
await db.executeQuery('SELECT order, count(*) AS count FROM orders GROUP BY order');

// ✅ quote reserved identifiers
await db.executeQuery('SELECT "order", count(*) AS count FROM orders GROUP BY "order"');
```

Also standardize on named placeholders everywhere: `SELECT * FROM users WHERE id = :id AND email = :email`.

---

#### Constraint violations: duplicate key, not-null, and foreign key failures

**Error message**

```text
error: duplicate key value violates unique constraint "users_email_key"
error: null value in column "email" of relation "users" violates not-null constraint
error: insert or update on table "posts" violates foreign key constraint "posts_user_id_fkey"
```

SQLSTATEs `23505` (unique), `23502` (not-null), `23503` (foreign key).

**Cause**

The data violates schema rules — usually expected behavior, not a bug:

- `23505` — a unique column (or a race between two inserts) produced a duplicate key.
- `23502` — a required column was omitted or explicitly `null`.
- `23503` — a referenced parent row does not exist, or you are deleting a parent that still has children.

Inside a `withTransaction()` callback, a constraint violation aborts the transaction; the adapter issues `ROLLBACK` and rethrows — which is exactly what you want.

**Fix**

Switch on the SQLSTATE at the boundary where you can react, instead of string-matching messages:

```typescript
import { DatabaseError } from 'pg';
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

async function insertUser(user: UserRow): Promise<'created' | 'duplicate'> {
  try {
    await db.insert<UserRow>('users').values(user).execute();
    return 'created';
  } catch (error) {
    if (error instanceof DatabaseError && error.code === '23505') {
      return 'duplicate';
    }
    throw error;
  }
}

try {
  console.log(await insertUser({ name: 'Ada', email: 'ada@example.com' }));
} finally {
  await db.disconnect();
}
```

Do not catch a constraint error *inside* a `withTransaction()` callback and continue querying — see the next entry.

---

### Transaction Errors

#### `error: current transaction is aborted, commands ignored until end of transaction block`

**Error message**

```text
error: current transaction is aborted, commands ignored until end of transaction block
```

SQLSTATE `25P02`.

**Cause**

A statement failed inside your transaction, you **caught the error inside the `withTransaction()` callback**, and then continued issuing queries. PostgreSQL marks the transaction as aborted after any error; until it is rolled back, every further statement fails with this message. The adapter's automatic `ROLLBACK` only runs when the callback lets the error propagate — swallowing it defeats that mechanism.

**Fix**

Let errors propagate out of the callback; the adapter rolls back and rethrows the original error. If you genuinely need to survive a failed statement and continue, guard it with an explicit `SAVEPOINT`:

```typescript fragment
// ❌ catching inside the callback and continuing — everything after this fails with 25P02
await db.withTransaction(async (tx) => {
  try {
    await tx.executeQuery('INSERT INTO users (email) VALUES (:email)', { email: 'team@example.com' });
    await tx.executeQuery('INSERT INTO users (email) VALUES (:email)', { email: 'team@example.com' });
  } catch (error) {
    // the transaction is already aborted here
  }
  await tx.executeQuery('SELECT 1'); // error: current transaction is aborted, ...
});

// ✅ let the error propagate: the adapter issues ROLLBACK and rethrows
await db
  .withTransaction(async (tx) => {
    await tx.executeQuery('INSERT INTO users (email) VALUES (:email)', { email: 'team@example.com' });
    await tx.executeQuery('INSERT INTO users (email) VALUES (:email)', { email: 'team@example.com' });
  })
  .catch((error) => console.error('rolled back:', error));
```

Savepoint-based alternative, when continuing is truly required:

```typescript fragment
await tx.executeQuery('SAVEPOINT before_insert');
try {
  await tx.executeQuery('INSERT INTO users (email) VALUES (:email)', { email: 'team@example.com' });
} catch {
  await tx.executeQuery('ROLLBACK TO SAVEPOINT before_insert');
}
// the transaction is healthy again — continue with other work
```

---

#### `WARNING: there is already a transaction in progress`

**Error message**

```text
WARNING: there is already a transaction in progress
```

**Cause**

You called `withTransaction()` on the same instance from inside another `withTransaction()` callback. The implementation is not reentrant: the inner call finds the already-pinned client, issues a second `BEGIN` (the warning above), runs your inner logic, then issues `COMMIT` — which commits the **outer** transaction early — and finally releases the pinned client and clears the internal slot. Statements the outer callback executes after the inner call then run on freshly acquired connections, outside the transaction, and the outer `COMMIT` has no client left to send it to. The result is partial, confusing commits.

**Fix**

Keep exactly one transaction boundary per unit of work and compose ordinary functions that receive the transaction-bound instance:

```typescript fragment
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function setStatus(tx: PostgreSQLDatabase, email: string, status: string): Promise<void> {
  await tx.executeQuery('UPDATE users SET status = :status WHERE email = :email', { status, email });
}

// ❌ nested withTransaction on the same instance
await db.withTransaction(async (tx) => {
  await db.withTransaction(async (inner) => {
    await setStatus(inner, 'ada@example.com', 'active');
  });
});

// ✅ one transaction boundary; pass `tx` into helper functions
await db.withTransaction(async (tx) => {
  await setStatus(tx, 'ada@example.com', 'active');
});
```

---

### Lifecycle and Shutdown Errors

#### `Error: Called end on pool more than once`

**Error message**

```text
Error: Called end on pool more than once
```

Emitted by `pg`'s pool and rethrown from `disconnect()`.

**Cause**

`disconnect()` was called twice on the same instance — for example, once explicitly and again from a cleanup hook, or from two shutdown paths racing. The first call ends the pool; the second `pool.end()` rejects. Note that even a *failed* `disconnect()` leaves the shutdown flag set, so the instance stays unusable either way. (The package's own tests wrap their cleanup `disconnect()` calls in `try`/`catch` for exactly this reason.)

**Fix**

Give shutdown a single owner. If cleanup must be defensive, make it idempotent and tolerate the second-call rejection:

```typescript fragment
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';

let shutdownStarted = false;

async function closeDatabase(db: PostgreSQLDatabase): Promise<void> {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  try {
    await db.disconnect();
  } catch (error) {
    // A second pool.end() rejects with "Called end on pool more than once".
    // During process teardown this is not actionable — log and move on.
    console.error('disconnect() failed during shutdown:', error);
  }
}
```

---

#### `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 SIGINT listeners added`

**Error message**

```text
MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 SIGINT listeners added to [process]. Use emitter.setMaxListeners() to increase limit
```

**Cause**

Every `PostgreSQLDatabase` constructed with `enableGracefulShutdown: true` registers permanent `SIGINT` and `SIGTERM` listeners on the process and never removes them. Creating more than five such instances (or recreating them per test/per request) trips Node's default listener limit, and all those handlers race to call `process.exit()` on the first signal. The same setting also conflicts with frameworks (such as a `WebApplication` from `blendsdk/webafx`) that install their own signal handling.

**Fix**

Enable `enableGracefulShutdown` on at most one long-lived, standalone instance — everywhere else (frameworks, tests, short-lived instances) keep it off and disconnect explicitly:

```typescript fragment
import { PostgreSQLConfig } from 'blendsdk/postgresql';

// Standalone process: let the adapter own shutdown once, for the one app-lifetime instance
const standaloneConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  enableGracefulShutdown: true,
};

// Framework-managed app, or tests: keep it off — the framework (or the test) owns shutdown
const managedConfig: PostgreSQLConfig = {
  ...standaloneConfig,
  enableGracefulShutdown: false,
};
```

---

### TypeScript and Module Resolution Errors

#### `error TS2345: Argument of type 'string[]' is not assignable to parameter of type 'Array<keyof UserRow>'`

**Error message**

```text
error TS2345: Argument of type 'string[]' is not assignable to parameter of type 'Array<keyof UserRow>'.
  Type 'string' is not assignable to type 'keyof UserRow'.
```

**Cause**

The `returning()` typings accept `'*'` or an array of keys of the statement's generic. An array assembled separately (a variable, a function result, a map) is inferred as `string[]`, which the compiler cannot narrow to the key union. Inline literals whose entries are all valid keys usually infer correctly — dynamic lists do not.

**Fix**

Declare dynamic column lists with the key type, or pass `'*'` when you want every column:

```typescript fragment
interface UserRow {
  id?: number;
  name: string;
  email: string;
}

const row: Partial<UserRow> = { name: 'Ada', email: 'ada@example.com' };

const columns = ['id', 'name', 'email']; // inferred as string[]
await db.insert<UserRow>('users').values(row).returning(columns).execute();
// error TS2345: Argument of type 'string[]' is not assignable to parameter of type 'Array<keyof UserRow>'.

const safeColumns: Array<keyof UserRow> = ['id', 'name', 'email'];
await db.insert<UserRow>('users').values(row).returning(safeColumns).execute();
```

If you deliberately return columns outside the generic (the database may have more columns than your interface declares), assert the type — as the package's own tests do — with `as Array<keyof UserRow>`.

---

#### `error TS1484: 'PostgreSQLConfig' is a type and must be imported using a type-only import...`

**Error message**

```text
error TS1484: 'PostgreSQLConfig' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.
```

**Cause**

Strict ESM projects enable `verbatimModuleSyntax`, which forbids importing type-only exports through value imports. `PostgreSQLConfig`, `PoolConfig`, and `PostgreSQLQueryResult` are interfaces and are erased at runtime.

**Fix**

Split value imports from type-only imports:

```typescript fragment
// ❌ mixing value and type imports under verbatimModuleSyntax
import { PostgreSQLConfig, PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

// ✅ import values and types separately
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import type { PostgreSQLConfig, PostgreSQLQueryResult } from 'blendsdk/postgresql';
```

---

#### `error TS1479: The current file is a CommonJS module...` / `ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined`

**Error message**

```text
error TS1479: The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module and cannot be imported with 'require'. Consider writing a dynamic 'import("blendsdk/postgresql")' call instead.
```

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in /app/node_modules/blendsdk/postgresql/package.json
```

**Cause**

The package is ESM-only: its `exports` map declares only `types` and `import` conditions — there is no `require` condition, and the package has `"type": "module"`. A CommonJS consumer cannot load it, either at compile time (TS1479 under `module: node16`/`nodenext`) or at runtime (resolution failure with `ERR_PACKAGE_PATH_NOT_EXPORTED`).

**Fix**

Either run your project as ESM — `"type": "module"` in `package.json`, with `"module": "nodenext"` and `"moduleResolution": "nodenext"` in `tsconfig.json` — or bridge with a dynamic `import()`, which works from CommonJS:

```typescript fragment
async function loadDatabase() {
  const { PostgreSQLDatabase } = await import('blendsdk/postgresql');
  return PostgreSQLDatabase;
}
```

---

#### `ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './dist/...' is not defined by "exports"`

**Error message**

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/database.js' is not defined by "exports" in /app/node_modules/blendsdk/postgresql/package.json
```

**Cause**

Importing from a package subpath — `blendsdk/postgresql/dist/...` or anything else below the root — bypasses the `exports` map, which defines only `"."`. These paths are internal and unstable.

**Fix**

Import from the package root only; everything public is re-exported there:

```typescript fragment
import { PostgreSQLDatabase, PostgreSQLConfig } from 'blendsdk/postgresql';
```

The root exports `PostgreSQLDatabase`, the three statement builders (`PostgreSQLInsertStatement`, `PostgreSQLUpdateStatement`, `PostgreSQLDeleteStatement`), and the `PostgreSQLConfig`, `PoolConfig`, and `PostgreSQLQueryResult` types. Shared contract types (`InsertStatement`, `ExecuteQueryOptions`, …) come from `blendsdk/dbcore`.

---

## Debugging Strategies

### 1. Read the PostgreSQL error object before changing anything

Server errors carry far more than the message. Steps:

1. Log `error.code` (SQLSTATE), `error.detail`, `error.table`, and `error.constraint` — not just `error.message`.
2. Use the SQLSTATE table below to classify the failure before touching code.
3. Remember that transport failures (ECONNREFUSED, ENOTFOUND, timeouts) are *not* `DatabaseError` and have no SQLSTATE — check for them in the `else` branch.

| SQLSTATE | Meaning | Example |
| --- | --- | --- |
| `23505` | unique violation | `duplicate key value violates unique constraint "users_email_key"` |
| `23502` | not-null violation | `null value in column "email" of relation "users" violates not-null constraint` |
| `23503` | foreign-key violation | `insert or update on table "posts" violates foreign key constraint "posts_user_id_fkey"` |
| `42P01` | undefined table | `relation "users" does not exist` |
| `42703` | undefined column | `column "username" does not exist` |
| `42601` | syntax error | `syntax error at or near "order"` |
| `25P02` | failed SQL transaction | `current transaction is aborted, commands ignored until end of transaction block` |
| `28P01` | invalid password | `password authentication failed for user "app"` |
| `3D000` | invalid database | `database "appdb" does not exist` |

```typescript
import { DatabaseError } from 'pg';
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
  await db.executeQuery('INSERT INTO users (email) VALUES (:email)', {
    email: 'ada@example.com',
  });
} catch (error) {
  if (error instanceof DatabaseError) {
    console.error({
      message: error.message,       // full server error text
      code: error.code,             // SQLSTATE, e.g. '23505'
      detail: error.detail,         // e.g. 'Key (email)=(ada@example.com) already exists.'
      table: error.table,           // e.g. 'users'
      constraint: error.constraint, // e.g. 'users_email_key'
    });
  } else {
    console.error('transport or guard error (no SQLSTATE):', error);
  }
} finally {
  await db.disconnect();
}
```

### 2. Reproduce connection and authentication problems in isolation

Work through these steps in order — each one rules out a layer:

1. Check reachability of the server: `pg_isready -h localhost -p 5432`.
2. Try a raw client with the exact credentials: `psql "postgresql://app:secret@localhost:5432/appdb" -c 'SELECT 1'`.
3. Run the minimal adapter program below — remember the constructor never fails, the first query does, and `disconnect()` resolves even after failed queries.
4. Only after the smoke test passes, investigate the failing statement itself.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config); // never connects here — the pool is lazy

try {
  const { records } = await db.executeQuery<{ ok: number; server_version: string }>(
    'SELECT 1 AS ok, version() AS server_version'
  );
  console.log(records[0].ok === 1 ? 'connection OK' : 'unexpected result');
  console.log(records[0].server_version.split(' ')[0]);
} finally {
  await db.disconnect(); // resolves even if the query above failed
}
```

### 3. Inspect generated SQL and parameters without a database

The statement builders are fully testable offline — building SQL never opens a connection. Expose the protected `buildQuery()` / `buildParameters()` steps through subclasses:

```typescript
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLDeleteStatement,
  PostgreSQLInsertStatement,
  PostgreSQLUpdateStatement,
} from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name: string;
  email: string;
}

interface UserFilter {
  email?: string;
}

class InspectableInsert<T> extends PostgreSQLInsertStatement<T> {
  toSql(): { query: string; params: Record<string, unknown> } {
    return { query: this.buildQuery(), params: this.buildParameters() };
  }
}

class InspectableUpdate<T, F> extends PostgreSQLUpdateStatement<T, F> {
  toSql(): { query: string; params: Record<string, unknown> } {
    return { query: this.buildQuery(), params: this.buildParameters() };
  }
}

class InspectableDelete<F> extends PostgreSQLDeleteStatement<F> {
  toSql(): { query: string; params: Record<string, unknown> } {
    return { query: this.buildQuery(), params: this.buildParameters() };
  }
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

const insertStatement = new InspectableInsert<UserRow>('users');
insertStatement.values({ name: 'Ada', email: 'ada@example.com' }).returning('*');
console.log(insertStatement.toSql());

const updateStatement = new InspectableUpdate<UserRow, UserFilter>('users');
updateStatement.values({ name: 'Ada Lovelace' }).filter({ email: 'ada@example.com' });
console.log(updateStatement.toSql());

const deleteStatement = new InspectableDelete<UserFilter>('users');
deleteStatement.filter({ email: 'ada@example.com' }).returning('*');
console.log(deleteStatement.toSql());

await db.disconnect();
```

Expected output — note the `v_` prefix on UPDATE values and the `p1` filter names:

```text
{ query: 'INSERT INTO users (name, email) VALUES (:name, :email) RETURNING *',
  params: { name: 'Ada', email: 'ada@example.com' } }
{ query: 'UPDATE users SET name = :v_name WHERE email = :p1',
  params: { v_name: 'Ada Lovelace', p1: 'ada@example.com' } }
{ query: 'DELETE FROM users WHERE email = :p1 RETURNING *',
  params: { p1: 'ada@example.com' } }
```

This is the same style of check the repository's statement-builder unit tests use — run them with `pnpm run test:fast`, which needs no database at all.

### 4. Instrument execution with hooks and timings

Wrap `executeQuery()` with a timing/logging helper, and use builder hooks to see the exact parameter maps the adapter will compile:

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

async function timedQuery<R>(
  sql: string,
  params: Record<string, unknown> = {}
): Promise<PostgreSQLQueryResult<R>> {
  const startedAt = performance.now();
  const result = await db.executeQuery<R>(sql, params);
  const elapsed = (performance.now() - startedAt).toFixed(1);
  console.log(`${result.rowCount} row(s) in ${elapsed} ms :: ${sql}`);
  return result;
}

try {
  const { records } = await timedQuery<{ now: Date }>('SELECT now() AS now');
  console.log(records[0].now.toISOString());
} finally {
  await db.disconnect();
}
```

For builder statements, log the parameter map at execution time — remembering that INSERT keys are column names, UPDATE values are `v_`-prefixed, and filters are `p1`, `p2`, …:

```typescript fragment
await db
  .update<UserRow, UserFilter>('users')
  .values({ name: 'Ada Lovelace' })
  .filter({ email: 'ada@example.com' })
  .beforeQuery((params) => {
    console.log('params at execution time:', params); // { v_name: 'Ada Lovelace', p1: 'ada@example.com' }
    return params;
  })
  .afterQuery((records) => {
    console.log('rows delivered to the caller:', records.length);
    return records;
  })
  .execute();
```

Caveat: in `executeQuery()`, the `afterQuery` hook is skipped when the query returns zero rows — do not rely on it for logging or bookkeeping that must always run.

### 5. Measure pool health when queries hang or shutdown is slow

Extend the database class to expose the pool counters (`totalCount`, `idleCount`, `waitingCount` are public on the `pg` pool):

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

class InspectableDatabase extends PostgreSQLDatabase {
  poolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  poolConfig: { max: 10 },
};

const db = new InspectableDatabase(config);

await db.executeQuery('SELECT 1');
console.log(db.poolStats()); // { total: 1, idle: 1, waiting: 0 }

await db.disconnect();
```

Reading the numbers:

- **`waiting > 0` with `idle === 0`** — the pool is saturated. Find the clients that never returned: a manually acquired client without `release()`, an overlapping or nested transaction, or a burst of simultaneous queries on the one instance.
- **`total` creeping upward while your workload is steady** — clients are being checked out and not returned. Check the logs for `Error releasing query client:` / `Error releasing transaction client:` (these failures are logged, never thrown).
- **`disconnect()` returning only after nearly its full timeout** — the pool had to force-release checked-out clients. The forced path may interrupt in-flight queries and transactions; treat it as a signal to investigate, not as normal shutdown.

### 6. Inspect the server side

When the client-side picture is unclear, ask the server what it is doing:

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface ActivityRow {
  pid: number;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  query: string;
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
  const { records } = await db.executeQuery<ActivityRow>(
    `SELECT pid, state, wait_event_type, wait_event, query
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
      ORDER BY query_start`
  );
  console.table(records);
} finally {
  await db.disconnect();
}
```

To find lock waits behind a hanging query:

```sql
SELECT blocked.pid AS blocked_pid,
       blocking.pid AS blocking_pid,
       blocked.query AS blocked_query
  FROM pg_stat_activity AS blocked
  JOIN pg_stat_activity AS blocking
    ON blocking.pid = ANY (pg_blocking_pids(blocked.pid));
```

For persistent investigation, enable statement logging on the server (`ALTER SYSTEM SET log_statement = 'all';` plus a reload) and correlate timestamps with your `timedQuery` output.

### 7. Isolate with a transaction-scoped temp-table sandbox

To reproduce a bug against real SQL without touching real tables, create everything inside one `withTransaction()` — the pinned client guarantees the temp table is visible for every statement in the callback, and `ON COMMIT DROP` guarantees it disappears afterwards:

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface DebugRow {
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
  const names = await db.withTransaction(async (tx) => {
    await tx.executeQuery(`
      CREATE TEMP TABLE debug_users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL
      ) ON COMMIT DROP
    `);

    await tx
      .insert<DebugRow>('debug_users')
      .values({ name: 'Ada', email: 'ada@example.com' })
      .execute();

    const { records } = await tx.executeQuery<DebugRow>('SELECT * FROM debug_users ORDER BY id');
    return records.map((row) => row.name);
  });

  console.log(names); // ['Ada'] — the table vanished with the commit
} finally {
  await db.disconnect();
}
```

For full integration testing, the package repository provides the harness: `pnpm run db:up` starts a PostgreSQL container, `pnpm test` runs the suite against it and tears everything down, and `pnpm run test:fast` runs only the statement-builder tests with no database required.

---

## Known Pitfalls

### 1. Missing or empty filters mutate entire tables

`UPDATE` and `DELETE` builders generate *no* `WHERE` clause when you omit `.filter()`/`.filterByExpression()` or pass an empty object — both silently affect every row:

```typescript fragment
// ❌ empty filter → DELETE FROM sessions (no WHERE) → removes every session
await db.delete<SessionFilter>('sessions').filter({}).execute();

// ✅ scope destructive statements and inspect what they touched
const removed = await db
  .delete<SessionFilter>('sessions')
  .filter({ status: 'expired' })
  .returning('*')
  .execute();

console.log(`removed ${removed?.rowCount ?? 0} session(s)`);
```

Bulk operations are sometimes intentional — but treat "no filter" as a deliberate decision, and prefer running them inside a `withTransaction()` you can inspect before committing.

### 2. `executeReturnSingle()` is an extractor, not a uniqueness check

If several rows match, `executeReturnSingle()` resolves with the first one and leaves the rest unobserved — it does not throw on multiple matches, and it resolves `null` when nothing matched. When you expect exactly one row, use `executeReturnAll()` and check the length:

```typescript fragment
const updated = await db
  .update<UserRow, UserFilter>('users')
  .values({ active: false })
  .filter({ email: 'ada@example.com' })
  .returning('*')
  .executeReturnSingle();
// 'updated' is the first matching row — additional matches are silently ignored
```

### 3. Hooks must use the engine's parameter names

`beforeQuery()` receives parameters under different naming schemes per statement type, and using the wrong name makes your transformation a silent no-op:

| Statement | Parameter names |
| --- | --- |
| INSERT | Column names (`email`, `password_hash`) |
| UPDATE | `v_` + column name for SET values (`v_name`), `p1`, `p2`, … for filters |
| DELETE | `p1`, `p2`, … for filters |

Filter parameter numbers follow the order of the keys you passed, so hooks keyed to `p1` break when the filter object changes. Prefer value-based transformations that iterate the map:

```typescript fragment
// UPDATE hook: prefix the value parameters you are updating
await db
  .update<UserRow, UserFilter>('users')
  .values({ name: 'Ada Lovelace' })
  .filter({ email: 'ada@example.com' })
  .beforeQuery((params) => {
    if (typeof params.v_name === 'string') {
      params.v_name = params.v_name.toUpperCase();
    }
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        params[key] = value.trim();
      }
    }
    return params;
  })
  .execute();
```

### 4. Zero rows short-circuit `executeQuery()`'s hook and metadata

When `executeQuery()` affects or returns zero rows, it resolves `{ records: [], rowCount: 0, fields: [] }` immediately — the `afterQuery` hook is **not** invoked, and column metadata is dropped even though the SELECT listed columns. Do not use `fields` from empty results to discover a result shape, and do not rely on `afterQuery` for logging or metrics that must run on every call:

```typescript fragment
const result = await db.executeQuery<UserRow>(
  'SELECT id, name, email FROM users WHERE id = :id',
  { id: -1 },
  {
    afterQuery: (records) => {
      // ⚠️ never called when the query matches no rows
      return records.map((record) => ({ ...record, name: record.name.trim() }));
    },
  }
);

console.log(result.rowCount); // 0
console.log(result.fields);   // [] — column metadata is dropped for empty results
```

### 5. A `null` filter value is not a guaranteed `IS NULL`

Do not assume that filtering with `{ deleted_at: null }` compiles to `IS NULL` — verify the generated SQL with the preview technique, or use the expression API's dedicated null checks:

```typescript fragment
// ⚠️ verify what this generates before trusting it (see Debugging Strategy 3)
await db.delete<UserFilter>('users').filter({ deleted_at: null }).execute();

// ✅ explicit NULL semantics via the expression API
await db
  .delete<UserFilter>('users')
  .filterByExpression((q) => q.where('deleted_at').isNull())
  .execute();
```

### 6. A transaction-bound instance is busy — keep it to one unit of work

While `withTransaction()` runs, the instance holds a single pinned client, and every `executeQuery()` call on that instance reuses it. A fire-and-forget query started elsewhere in the app at that moment will silently **join the transaction**, and starting a transaction while other calls are still in flight binds it to one of their clients. Await everything, pass the `tx` argument into all code that participates, and serialize units of work per instance:

```typescript fragment
await db.withTransaction(async (tx) => {
  await tx.executeQuery('UPDATE accounts SET balance = balance - :amount WHERE id = :id', {
    amount: 100,
    id: 1,
  });
  // Any un-awaited db.executeQuery() issued from elsewhere right now would
  // reuse this pinned client and become part of this transaction.
});
```

### 7. High-fan-out concurrency shares one client slot

The instance keeps a single `transactionClient` slot that doubles as the bookkeeping for atomic queries. When many `executeQuery()` calls start in the same tick, they all observe an empty slot before any of them stores its client, and the release step later operates on whatever client occupies the slot — not necessarily the caller's own. In large bursts, some pooled clients can stay checked out after the queries finish. Symptoms: `totalCount` high and `idleCount` low after bursts (see Debugging Strategy 5), `waitingCount > 0`, and then either `timeout exceeded when trying to connect` (if `connectionTimeoutMillis` is set) or queries that wait forever (the default is no timeout).

Mitigate by bounding the fan-out (await in batches rather than firing hundreds of parallel queries), always configuring `connectionTimeoutMillis`, and treating `disconnect()`'s forced fallback as the recovery path of last resort.

### 8. Temp tables and session state belong to pooled connections

`CREATE TEMP TABLE` (and session settings like `SET search_path`) are scoped to a single physical connection. With a pool, the next statement may run on a different client and not see them — intermittently, depending on pool scheduling:

```typescript fragment
// ❌ the next query may land on a different pooled client and not see the temp table
await db.executeQuery('CREATE TEMP TABLE staging (id int)');
await db.executeQuery('SELECT * FROM staging'); // may fail: relation "staging" does not exist

// ✅ session-scoped objects stay inside one transaction (one pinned client)
await db.withTransaction(async (tx) => {
  await tx.executeQuery('CREATE TEMP TABLE staging (id int) ON COMMIT DROP');
  await tx.executeQuery('INSERT INTO staging (id) VALUES (:id)', { id: 1 });
  const { records } = await tx.executeQuery<{ id: number }>('SELECT * FROM staging');
  console.log(records);
});
```

Also remember that the pool's `idleTimeoutMillis` can close an idle session — and with it any temp tables — without warning.

### 9. Result-shape surprises: strings for numbers, `Date` for timestamps, `?column?` for expressions

The driver maps PostgreSQL types onto JavaScript in ways that do not match the natural interface you would write:

- `COUNT(*)`, `NUMERIC`/`DECIMAL`, and `BIGINT` arrive as **strings** (precision is preserved deliberately) — cast in SQL or convert explicitly.
- `TIMESTAMP` and `DATE` columns arrive as JavaScript **`Date` objects** — typing them as `string` compiles but misleads at runtime.
- Unaliased expressions get the column label **`?column?`** — alias everything you select.

```typescript fragment
// COUNT comes back as a string — cast in SQL or parse in code
const { records } = await db.executeQuery<{ count: number }>(
  'SELECT COUNT(*)::int AS count FROM users'
);

// NUMERIC keeps full precision as a string
const order = await db.executeQuery<{ total: string }>(
  'SELECT total FROM orders WHERE id = :id',
  { id: 1 }
);
const total = Number(order.records[0].total);

// Timestamps are Dates, not strings
const user = await db.executeQuery<{ created_at: Date }>(
  'SELECT created_at FROM users WHERE id = :id',
  { id: 1 }
);
console.log(user.records[0].created_at.toISOString());

// Always alias expressions — this column is literally named "?column?"
const odd = await db.executeQuery<{ '?column?': number }>('SELECT 1');
```

### 10. `disconnect()` is a one-way door, and its timeout tells a story

The shutdown flag is set before the pool closes and is never reset: after `disconnect()` — whether it succeeded, failed, or timed out — the instance rejects all further work. If `disconnect()` returns only after nearly its full timeout, the pool had to force-release clients that were still checked out, potentially interrupting in-flight queries. Create a fresh instance instead of trying to reuse a closed one:

```typescript fragment
// If this returns only after ~5000 ms, clients were still checked out
// and the forced release path interrupted them.
await db.disconnect(5000);

// The instance is finished — build a new one for further work.
const fresh = new PostgreSQLDatabase(config);
```

### 11. `enableGracefulShutdown` conflicts with framework-managed shutdown

`enableGracefulShutdown: true` installs SIGINT/SIGTERM handlers that `console.log`, disconnect, and call `process.exit()` — and leaves them registered forever. Never enable it when a `WebApplication` from `blendsdk/webafx` (or any other framework) manages process lifecycle: two sets of signal handlers produce unpredictable shutdown, and `process.exit()` can kill the process while unrelated resources are still flushing. Use it only for standalone, self-managed processes, and only on the one long-lived instance:

```typescript fragment
const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
  enableGracefulShutdown: false, // true only for a standalone, self-managed process
};
```

### 12. Cleanup failures only reach your logs

When a `ROLLBACK` fails or a client cannot be released, the adapter logs the failure and keeps the original error:

```text
Error during transaction rollback: <the rollback failure>
Error releasing query client: <the release failure>
Error releasing transaction client: <the release failure>
```

Your code sees the *original* error — cleanup problems never replace it. That is deliberate, but it means a flaky connection can hide behind a clean-looking stack trace. If these lines appear in your logs, investigate the connection health (server restarts, network drops) before trusting further results from that instance.

### 13. Builders do not quote identifiers — stick to lowercase snake_case

The builders emit column names verbatim. PostgreSQL folds unquoted identifiers to lowercase, so camelCase keys break against conventionally named columns, and reserved words fail outright:

```typescript fragment
// ❌ emits INSERT INTO users (firstName) ... → folded to "firstname" → column does not exist
await db.insert('users').values({ firstName: 'Ada' }).execute();

// ✅ database columns use lowercase snake_case names
await db.insert('users').values({ first_name: 'Ada' }).execute();
```

If your schema genuinely contains mixed-case quoted identifiers, use raw `executeQuery()` with explicit quoting rather than the builders.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
