> **Package**: `blendsdk/postgresql`

# postgresql Best Practices

This document collects the practices that keep code built on `blendsdk/postgresql` correct, fast and safe. Every rule below is grounded in the adapter's actual implementation (`src/database.ts` and the three statement builders) and in the behaviour asserted by the package test suite. Install the umbrella once with `npm install blendsdk` and import from `blendsdk/postgresql`, as the examples do.

---

## Do / Don't Pairs

The fragments below assume a live `PostgreSQLDatabase` instance named `db`. The complete example shows how such an instance is constructed, health-checked and closed; the paired snippets that follow stay inside that same lifecycle and keep the same types (`User`, `UserFilter`).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

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

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);

try {
  const { rowCount } = await db.executeQuery('SELECT 1');
  console.log(`connection ok: ${rowCount === 1}`);
} finally {
  await db.disconnect();
}
```

### 1. Bind every value as a parameter

**❌ Wrong — string interpolation**

```typescript fragment
const email = 'ada@example.com';
await db.executeQuery(`SELECT id, name FROM users WHERE email = '${email}'`);
```

**✅ Correct — named parameters**

```typescript fragment
const { records } = await db.executeQuery<{ id: number; name: string }>(
  'SELECT id, name FROM users WHERE email = :email',
  { email: 'ada@example.com' }
);
console.log(records[0]?.name ?? 'not found');
```

**Why:** interpolation concatenates input directly into SQL text; a quote, backslash or comment sequence in the value changes the statement. Named parameters are rewritten by `yesql` into the driver's positional `$1…$n` form and bound by `pg`, so the value can never become syntax. The suite's `handles SQL injection prevention` test passes `"'; DROP TABLE injection_test; --"` as a parameter value and verifies the table survives untouched.

### 2. Make multi-statement work one transaction

**❌ Wrong — sequential autocommit statements**

```typescript fragment
await db.executeQuery(
  'UPDATE accounts SET balance = balance - :amount WHERE id = :fromId',
  { amount: 100, fromId: 1 }
);
await db.executeQuery(
  'UPDATE accounts SET balance = balance + :amount WHERE id = :toId',
  { amount: 100, toId: 2 }
);
```

**✅ Correct — one `withTransaction()` boundary**

```typescript fragment
await db.withTransaction(async (tx) => {
  await tx.executeQuery(
    'UPDATE accounts SET balance = balance - :amount WHERE id = :fromId',
    { amount: 100, fromId: 1 }
  );
  await tx.executeQuery(
    'UPDATE accounts SET balance = balance + :amount WHERE id = :toId',
    { amount: 100, toId: 2 }
  );
});
```

**Why:** outside a transaction each `executeQuery()` acquires and releases its own pooled client, so a failure between two calls leaves the first change committed and the second missing. `withTransaction()` issues BEGIN, runs the callback on one client, and issues ROLLBACK when the callback throws. Use the callback's `tx` for every statement so the transactional scope is visible in the code; the context follows the async call chain, so unrelated concurrent tasks keep their own clients and never join your transaction.

### 3. Never emit an UPDATE or DELETE without a WHERE clause by accident

**❌ Wrong — no filter, or an empty filter**

```typescript fragment
await db.delete<UserFilter>('users').execute();
await db.update<User, UserFilter>('users').values({ active: false }).execute();

// This reads as "filtered" but compiles to the same unconditional statement:
await db.delete<UserFilter>('users').filter({}).execute();
```

**✅ Correct — an explicit boundary**

```typescript fragment
const purged = await db
  .delete<UserFilter>('users')
  .filter({ active: false })
  .executeReturnCount();

const deactivated = await db
  .update<User, UserFilter>('users')
  .values({ active: false })
  .filterByExpression((q) => q.where('id').equals(7))
  .executeReturnCount();

console.log(`purged=${purged} deactivated=${deactivated}`);
```

**Why:** `buildQuery()` appends `WHERE` only when the compiled expression contains SQL. Calling `.filter({})` compiles to no expression at all, producing `DELETE FROM users` / `UPDATE users SET active = :v_active` with no restriction. The test suite exercises both cases — `executes bulk delete without filter conditions` and `executes update without filter conditions (updates all rows)` — and they affect every row. Table-wide operations are legitimate, but make them explicit and reviewable rather than accidental.

### 4. Prefer `executeQuery()`; release raw clients in `finally`

**❌ Wrong — a borrowed client with no release**

```typescript fragment
const userId = 7;
const client = await db.connect();
await client.query('SELECT id, email FROM users WHERE id = $1', [userId]);
// No client.release() — the connection never returns to the pool.
```

**✅ Correct — the managed pipeline**

```typescript fragment
const userId = 7;
const { records } = await db.executeQuery<{ id: number; email: string }>(
  'SELECT id, email FROM users WHERE id = :id',
  { id: userId }
);
console.log(records[0]?.email ?? 'not found');
```

**✅ Correct — a raw client only when the driver feature requires it**

```typescript fragment
const client = await db.connect();
try {
  const result = await client.query('SELECT 1 AS value');
  console.log(result.rows[0]?.value ?? null);
} finally {
  client.release();
}
```

**Why:** every leaked client permanently removes one slot from the pool (`max`, default 10). Once the pool is exhausted, new work queues until `connectionTimeoutMillis` — which defaults to `0`, meaning it can wait forever. A raw client also bypasses named-parameter conversion, query hooks and result normalization (`executeOnClient()`), so prefer `executeQuery()` unless you need driver-level behaviour, and always release in `finally`.

### 5. Keep transaction work inside the callback

**❌ Wrong — a detached task that outlives the transaction**

```typescript fragment
await db.withTransaction(async (tx) => {
  await tx.executeQuery('INSERT INTO audit_log (message) VALUES (:message)', {
    message: 'user updated',
  });

  void (async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    // Runs after the callback settled: the transaction is already committed
    // and the client is back in the pool.
    await tx.executeQuery('INSERT INTO audit_log (message) VALUES (:message)', {
      message: 'follow-up',
    });
  })();
});
```

**✅ Correct — all transactional work inside the callback**

```typescript fragment
await db.withTransaction(async (tx) => {
  await tx.executeQuery('INSERT INTO audit_log (message) VALUES (:message)', {
    message: 'user updated',
  });
  await tx.executeQuery('INSERT INTO audit_log (message) VALUES (:message)', {
    message: 'follow-up',
  });
});
```

**Why:** when the callback settles, the adapter closes the async-local context *before* COMMIT and returns the client to the pool. A later call on the retained handle is rejected with `Cannot execute a query after the transaction has completed. Do not use the transaction handle outside its callback.` rather than borrowing a released connection. If work must happen after commit, capture plain data inside the callback, return it, and start the follow-up after `withTransaction()` resolves.

### 6. Write `beforeQuery` hooks against the statement's real parameter keys

**❌ Wrong — an INSERT-style hook attached to an UPDATE**

```typescript fragment
await db
  .update<User, UserFilter>('users')
  .values({ email: 'ADA@EXAMPLE.COM' })
  .filter({ id: 7 })
  .beforeQuery((params) => ({
    ...params,
    email: String(params.email).toLowerCase(),
  }))
  .execute();
```

**✅ Correct — the keys the UPDATE builder produces**

```typescript fragment
await db
  .update<User, UserFilter>('users')
  .values({ email: 'ADA@EXAMPLE.COM' })
  .filter({ id: 7 })
  .beforeQuery((params) => ({
    ...params,
    v_email: String(params.v_email).toLowerCase(),
  }))
  .execute();
```

**Why:** the parameter object handed to `beforeQuery` differs per statement kind, as asserted throughout the hook tests:

| Builder | `beforeQuery` keys | `afterQuery` receives |
| --- | --- | --- |
| `executeQuery()` | Exactly the keys you supplied | `res.rows` after execution |
| INSERT | Column names (`email`, `password_hash`, …) | Rows produced by `RETURNING` |
| UPDATE | SET values as `v_<column>`, WHERE values as `p1…pN` | Rows produced by `RETURNING` |
| DELETE | WHERE values as `p1…pN` | Rows produced by `RETURNING` |

A hook that looks for `email` on an UPDATE finds nothing, adds an unused key, and the value reaches the database in its original form — a silent bug. The suite demonstrates the correct keys: `params.v_password_hash` on UPDATE and `params.p1` on DELETE.

### 7. Type driver values honestly — numeric and COUNT arrive as strings

**❌ Wrong — claiming numbers the driver never produces**

```typescript fragment
interface OrderSummary {
  total: number;
  line_count: number;
}

const { records } = await db.executeQuery<OrderSummary>(
  'SELECT SUM(amount) AS total, COUNT(*) AS line_count FROM order_lines WHERE order_id = :orderId',
  { orderId: 7 }
);

const summary = records[0];
if (summary && summary.line_count === 0) {
  // Never true: line_count is the string '0' at runtime.
  console.log('empty order');
}
```

**✅ Correct — declare the wire type and convert at the boundary**

```typescript fragment
interface OrderSummaryRow {
  total: string | null;
  line_count: string;
}

const { records } = await db.executeQuery<OrderSummaryRow>(
  'SELECT SUM(amount) AS total, COUNT(*) AS line_count FROM order_lines WHERE order_id = :orderId',
  { orderId: 7 }
);

const summary = records[0];
const lineCount = summary ? Number(summary.line_count) : 0;
const total = summary?.total ? Number(summary.total) : 0;

if (lineCount === 0) {
  console.log('empty order');
} else {
  console.log(`total=${total}`);
}
```

**Why:** node-postgres returns `numeric`/`decimal`, `bigint` and `COUNT(*)` as strings to avoid precision loss — the suite asserts `price: '29.99'`, `count: '2'` and `total_sum: '175.75'`. Typing them as `number` makes the compiler lie, and checks like `=== 0` or `if (count)` misbehave because the string `'0'` is truthy. Declare string types and convert once — either at the call site or in an `afterQuery` mapper. Timestamps are the opposite case: `timestamp` columns come back as `Date` objects, so do not re-parse them unnecessarily.

### 8. Share one database instance — and one pool — per process

**❌ Wrong — a new pool per call**

```typescript fragment
async function loadUser(id: number): Promise<User | null> {
  const db = new PostgreSQLDatabase(config);
  const { records } = await db.executeQuery<User>(
    'SELECT id, name, email, active FROM users WHERE id = :id',
    { id }
  );
  await db.disconnect();
  return records[0] ?? null;
}
```

**✅ Correct — one instance at module scope**

```typescript fragment
const db = new PostgreSQLDatabase(config);

async function loadUser(id: number): Promise<User | null> {
  const { records } = await db.executeQuery<User>(
    'SELECT id, name, email, active FROM users WHERE id = :id',
    { id }
  );
  return records[0] ?? null;
}
```

**Why:** the constructor creates a `pg.Pool`, and each pool can open up to `poolConfig.max` connections (default 10) against the server. Four replicas that build a pool per request can multiply into hundreds of connections and hit the server's `max_connections`; every call also pays pool startup and teardown instead of reusing a warm connection. One instance per process (managed by `blendsdk/webafx` in a web application) is the intended usage; if the query throws before `disconnect()` in the wrong example, the pool leaks entirely.

### 9. Let exactly one owner handle shutdown

**❌ Wrong — two signal owners**

```typescript fragment
const db = new PostgreSQLDatabase({
  ...config,
  enableGracefulShutdown: true,
});

// The surrounding WebApplication also installs SIGINT/SIGTERM handlers.
```

**✅ Correct — the framework owns the lifecycle**

```typescript fragment
const db = new PostgreSQLDatabase(config);
```

**Why:** `enableGracefulShutdown: true` registers `process.on('SIGINT')` and `process.on('SIGTERM')` listeners that call `disconnect()` and then `process.exit()`; `blendsdk/webafx` installs its own handlers for the same signals, producing handler conflicts and unpredictable shutdown. Inside a web application, omit the flag. In a standalone script, call `disconnect()` yourself in a `finally` block (as in the setup example), and remember that the shutdown flag is sticky: once `disconnect()` starts, queries fail with `Cannot execute query: database is shutting down` and transactions with `Cannot start transaction: database is shutting down`. Construct a new instance if you genuinely need to reconnect.

### 10. Use the terminator that matches the row cardinality

**❌ Wrong — `executeReturnSingle()` on a multi-row statement**

```typescript fragment
const first = await db
  .update<User, UserFilter>('users')
  .values({ active: false })
  .filter({ active: true })
  .returning('*')
  .executeReturnSingle();

// `first` is one user, but every active user was deactivated.
console.log(`deactivated ${first?.name ?? 'nobody'}`);
```

**✅ Correct — all rows, or just the count**

```typescript fragment
const deactivated = await db
  .update<User, UserFilter>('users')
  .values({ active: false })
  .filter({ active: true })
  .returning('*')
  .executeReturnAll();

console.log(`deactivated ${deactivated.length} users`);

const affected = await db
  .update<User, UserFilter>('users')
  .values({ active: false })
  .filter({ active: true })
  .executeReturnCount();

console.log(`affected rows: ${affected}`);
```

**Why:** `executeReturnSingle()` resolves the first returned row or `null`; it does not verify that only one row matched. `executeReturnAll()` returns every affected row, and `executeReturnCount()` returns just the number. The zero-row contract is uniform across terminators — `null`, `[]`, `0` — and `afterQuery` is skipped entirely when `rowCount === 0`, so never use an `afterQuery` mapper to supply defaults for empty results.

---

## Anti-Patterns

These are the failure modes that show up repeatedly in the package's test suite and in code reviews.

| Anti-pattern | Why it bites | Do instead |
| --- | --- | --- |
| Calling `executeReturnSingle()` on a statement that can affect many rows | Only the first row is returned even though every matching row changed | `executeReturnAll()` for the row set, `executeReturnCount()` for the number |
| Expecting `afterQuery` to run for zero-row results | `executeQuery()` returns `{ records: [], rowCount: 0, fields: [] }` before hooks are applied | Handle `null`/`[]`/`0` at the call site |
| Reading `result.fields` on an empty result | `fields` is `[]` on the zero-row short-circuit | Request column metadata only when at least one row exists |
| Reusing an instance after `disconnect()` | The shutdown flag is sticky; all new work is rejected | Construct a new `PostgreSQLDatabase` |
| Nested `withTransaction()` for partial rollback | PostgreSQL has no nested `BEGIN`; the adapter throws `Cannot start a nested transaction: a transaction is already active on this database handle.` | Flatten the work into one callback, or use explicit `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` through `tx.executeQuery` |
| Passing a string, array or unknown isolation level to `withTransaction()` | Rejected before a client is acquired: `Transaction options must be an object.` / `Unsupported transaction isolation level. …` | Pass `{ isolation: 'serializable' }` with one of the three allowed literals |
| Calling `buildQuery()` / `buildParameters()` from application code | They are protected and only exist as test seams; you bypass hooks, parameter conversion and result typing | Finish statements with `execute` / `executeReturnSingle` / `executeReturnAll` / `executeReturnCount` |
| Constructing a `PostgreSQLDatabase` per request | Multiplies pools against the server's connection limit and leaks on error paths | One instance per process (see pair 8) |
| Logging parameter objects wholesale | Parameter objects may contain passwords, tokens and PII | Log statement identity, row counts and durations — never values |

### Session state does not follow the pool

`executeQuery()` outside a transaction acquires a client per call. PostgreSQL session state — `CREATE TEMP TABLE`, `SET`, advisory locks, `LISTEN` — belongs to one connection, and the next call may land on a different pooled client. The test suite always creates and consumes temp tables inside a single `withTransaction()` callback for exactly this reason.

**❌ Wrong — assuming the same connection**

```typescript fragment
await db.executeQuery('CREATE TEMP TABLE session_cache (id integer)');
await db.executeQuery('INSERT INTO session_cache (id) VALUES (:id)', { id: 1 });
// Under concurrency this may run on a different client:
// "relation session_cache does not exist".
```

**✅ Correct — do session-scoped work on one client**

```typescript fragment
await db.withTransaction(async (tx) => {
  await tx.executeQuery('CREATE TEMP TABLE session_cache (id integer)');
  await tx.executeQuery('INSERT INTO session_cache (id) VALUES (:id)', { id: 1 });
});
```

### Undefined filter values silently match nothing

**❌ Wrong — a filter built from a possibly-undefined value**

```typescript fragment
const maybeEmail: string | undefined = process.env.USER_EMAIL;
await db.delete<UserFilter>('users').filter({ email: maybeEmail }).execute();
```

When `maybeEmail` is `undefined`, the expression binds `p1: null` (asserted by the suite's `handles null and undefined values in filter` case), producing `WHERE email = NULL` — which matches no rows. The delete reports zero affected rows instead of failing, so a missing configuration value looks like "nothing to delete".

**✅ Correct — validate before building the filter**

```typescript fragment
const maybeEmail: string | undefined = process.env.USER_EMAIL;
if (maybeEmail === undefined) {
  throw new Error('USER_EMAIL must be set');
}
await db.delete<UserFilter>('users').filter({ email: maybeEmail }).execute();
```

If `NULL` is the value you actually mean, express it explicitly with `filterByExpression((q) => q.where('email').isNull())`; and if every condition is optional, remember pair 3: an empty filter is an unconditional statement.

### Swallowing errors inside `withTransaction()`

**❌ Wrong — the transaction still commits**

```typescript fragment
const sku = 'ABC-1';
await db.withTransaction(async (tx) => {
  try {
    await tx.executeQuery('UPDATE inventory SET stock = stock - 1 WHERE sku = :sku', { sku });
  } catch {
    // Swallowed: the callback resolves, so the partial work is committed.
  }
});
```

**✅ Correct — rethrow so the rollback happens**

```typescript fragment
const sku = 'ABC-1';
await db.withTransaction(async (tx) => {
  try {
    await tx.executeQuery('UPDATE inventory SET stock = stock - 1 WHERE sku = :sku', { sku });
  } catch (error) {
    console.error('stock update failed', error);
    throw error;
  }
});
```

`withTransaction()` rolls back only when the callback rejects. If you handle an error and continue, the adapter issues COMMIT on whatever partial state exists; rethrow (or rethrow a wrapped error) so the caller sees the failure and the transaction unwinds.

---

## Performance Tips

1. **Reuse one instance with a deliberately sized pool.** One `PostgreSQLDatabase` per process means one pool whose `max` (default 10) bounds concurrency. Size it to what the server can serve across all replicas — four replicas with `max: 20` can hold 80 connections — and tune the other knobs in the same place:

   ```typescript fragment
   const db = new PostgreSQLDatabase({
     ...config,
     poolConfig: { max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 },
   });
   ```

2. **Always set `connectionTimeoutMillis`.** The default is `0` — no timeout — so a saturated or unreachable pool makes requests wait indefinitely. A finite value turns pool exhaustion into a fast, observable failure instead of a hung request.

3. **Return changed rows in the same round trip.** Combine `.returning([...])` with `executeReturnSingle()` / `executeReturnAll()` instead of an `UPDATE` followed by a `SELECT`. Outside a transaction the second statement also costs another pool acquisition; inside one it still costs an extra round trip.

4. **Don't pay for rows you won't read.** When only the affected count matters, call `executeReturnCount()` *without* `.returning('*')` so the driver never materializes or transfers row data. For reads, select only the needed columns (`db.from<T>(table).select(['id', 'name'])`) rather than pulling every column of every row.

5. **Batch multi-row inserts into one statement.** One `INSERT ... VALUES (...), (...), (...)` with numbered named parameters beats N separate inserts: fewer round trips, fewer pool acquisitions, one parse/plan. The suite's multi-value inserts show the shape:

   ```typescript fragment
   await db.executeQuery(
     `INSERT INTO audit_log (message, created_at) VALUES
        (:message1, :createdAt1),
        (:message2, :createdAt2),
        (:message3, :createdAt3)`,
     {
       message1: 'one',
       createdAt1: new Date(),
       message2: 'two',
       createdAt2: new Date(),
       message3: 'three',
       createdAt3: new Date(),
     }
   );
   ```

6. **Wrap sequences of statements in a transaction — but not single statements.** N statements outside a transaction are N client acquisitions and releases; inside `withTransaction()` they share one client (plus the BEGIN/COMMIT round trips), and the atomicity is the real reason. Wrapping a single statement adds BEGIN and COMMIT overhead for no benefit.

7. **Keep hooks cheap.** `beforeQuery` runs once per statement; `afterQuery` runs once per result set but iterates every row. Do value coercion and field stripping in a single allocation-light pass, and never perform I/O (logging services, lookups) inside a hook.

8. **Tune `idleTimeoutMillis` to your traffic.** The default (30000 ms) keeps connections warm through short quiet periods but holds server slots. Lower it for bursty, memory-constrained servers to release connections quickly; raise it for steady traffic to avoid reconnecting (and re-authenticating) on every lull.

---

## Security Considerations

Security for this adapter reduces to three boundaries: **values are parameterized, identifiers are not, and the execution pipeline is where policy hooks live.**

### Values are parameterized; identifiers are not

Named parameters protect values only. Table names, column names (the keys of `values()` and `filter()` objects), and the column list passed to `returning()` are concatenated into SQL text. Never accept them from user input without an allowlist.

**❌ Wrong — user-controlled identifier**

```typescript fragment
const tableName = process.argv[2] ?? 'users'; // user-controlled
await db.insert<{ name: string }>(tableName).values({ name: 'Ada' }).execute();
```

**✅ Correct — map to a fixed allowlist**

```typescript fragment
const tableByEntity = {
  user: 'users',
  order: 'orders',
  product: 'products',
} as const;

type Entity = keyof typeof tableByEntity;

function isEntity(value: string): value is Entity {
  return value in tableByEntity;
}

const entityInput = process.argv[2] ?? 'user';
if (!isEntity(entityInput)) {
  throw new Error(`unknown entity: ${entityInput}`);
}

await db.insert<{ name: string }>(tableByEntity[entityInput]).values({ name: 'Ada' }).execute();
```

The same rule applies to `filter()` keys and `returning()` columns: if they can vary at runtime, they must come from a closed set defined in code, not from a request.

### Let `TransactionOptions` render the `BEGIN` statement

The `isolation` option is validated against an allowlist (`'read committed' | 'repeatable read' | 'serializable'`) *before* a client is acquired, and rendered through a fixed lookup table. Passing the option through as a string can never inject SQL — the suite verifies that `"serializable'; DROP TABLE customer; --"` is rejected.

```typescript fragment
await db.withTransaction(
  async (tx) => {
    await tx.executeQuery('UPDATE counters SET value = value + 1 WHERE name = :name', {
      name: 'orders',
    });
  },
  { isolation: 'serializable' }
);
```

Never build `BEGIN ISOLATION LEVEL ${…}` yourself, and never pass a raw options string: the adapter rejects non-object options with `Transaction options must be an object.` before touching the pool.

### Use hooks as a data-minimization boundary — knowing their limits

`afterQuery` is the right place to strip `password_hash`, `api_key`, `ssn`, `salary` and similar fields before results leave the data layer; the hook tests do exactly this for single and multiple rows. But two rules apply:

- Prefer not to select sensitive columns at all. Hooks are defense in depth, not a license to `SELECT *`.
- Raw `connect()` bypasses the pipeline entirely — no `beforeQuery`, no `afterQuery`, no named parameters. If a project-wide stripping policy must be guaranteed, keep feature code on `executeQuery()` and the statement builders.

### Keep credentials and parameters out of code and logs

- Supply `pass` from a secret store or environment variable in real deployments; the literal in the docs exists for readability only.
- Connect with a least-privilege role that owns only the privileges the service needs — the adapter cannot protect data the role is allowed to drop.
- Never log parameter objects; they routinely contain passwords, tokens and PII. Log statement identity, row counts and durations instead.
- Hash credentials with a real KDF (bcrypt, scrypt, argon2) before they are bound. The `bcrypt_` prefix used in the hook tests is illustrative; `beforeQuery` is a transformation hook, not a hashing boundary.

---

# postgresql Testing Patterns

This document explains how to test code built on `blendsdk/postgresql`. There are two distinct kinds of tests, and the package's own suite in `tests/` treats them separately:

- **Offline tests** — the INSERT/UPDATE/DELETE builders are pure SQL producers. They never touch a socket, so their query text and parameter objects can be asserted synchronously in milliseconds.
- **Integration tests** — anything that awaits the pool (`executeQuery`, `withTransaction`, the `execute*` terminators, hooks) runs against a disposable PostgreSQL server started from the compose file that ships with the package.

Every pattern below is taken from the package's own test files; the suite is the source of truth.

---

## Test Setup

### The test stack

| Package | Role |
| --- | --- |
| `vitest` | Test runner, assertions, `vi` spying utilities. |
| `@vitest/coverage-v8` | Coverage provider used by `test:coverage`. |
| `typescript` | Strict-mode compilation of sources and tests. |
| `@types/node`, `@types/pg`, `@types/yesql` | Type declarations for the runtime dependencies. |
| `blendsdk/expression` | Builds compiled WHERE expressions used by the SELECT/UPDATE/DELETE filter tests. |

Add the runner to a project that already has the SDK:

```bash
npm install blendsdk
npm install --save-dev vitest @vitest/coverage-v8
```

### Test scripts

| Script | Command | When to use it |
| --- | --- | --- |
| `test:fast` | `vitest run --reporter=verbose tests/statement-builders.test.ts` | SQL-generation tests only; **no Docker required**. |
| `test:watch` | `vitest watch --reporter=verbose` | TDD while a database is running. |
| `test` | `pnpm run db:down && pnpm run db:up && vitest run --reporter=verbose && pnpm run db:down` | Full cycle: fresh server, full suite, teardown. |
| `test:coverage` | `vitest run --coverage` | Coverage run; the database must already be up. |
| `db:up` | `docker-compose -p postgresql -f ./docker/docker-compose${MODE}.yml up -d && sleep 5` | Start the disposable server. |
| `db:down` | `docker-compose ... down -v --remove-orphans` | Stop it and wipe its volumes. |
| `db:logs` | `docker-compose ... logs postgres-test` | Inspect the server when a test hangs. |

### Docker-backed PostgreSQL

The live tests expect a server that the bundled compose file provides:

| Setting | Value |
| --- | --- |
| Compose project | `postgresql` |
| Service | `postgres-test` |
| Host port | `5599` |
| Database / user / password | `testdb` / `testdb` / `testdb` |

A few operational details matter:

- The compose filename is parameterised by `MODE` (`docker-compose${MODE}.yml`). With `MODE` unset it resolves to `docker/docker-compose.yml`; whatever you choose must be the same for `db:up`, `db:down` and `db:logs`.
- `db:up` sleeps five seconds after `up -d`. On a slow machine the first connection can arrive before the server accepts it — if the first test fails with `ECONNREFUSED`, check `pnpm run db:logs` and re-run.
- `db:down` passes `-v --remove-orphans`, so each `pnpm test` cycle starts from an empty database.
- No test creates a permanent schema. Suites either use `CREATE TEMP TABLE` inside a transaction or create a real table with a unique, timestamp-and-random suffixed name and drop it in a `finally` block.

### A single connection fixture

Every live-server suite imports the same object so the port and credentials exist in exactly one place:

```typescript
import { PostgreSQLConfig } from 'blendsdk/postgresql';

/**
 * Coordinates of the disposable PostgreSQL instance started by `pnpm run db:up`.
 * Live-server suites import this object instead of hard-coding the port.
 */
export const connectionConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5599,
  database: 'testdb',
  pass: 'testdb',
  user: 'testdb',
};
```

The package's own `tests/params.ts` imports `PostgreSQLConfig` from `../src/database.js` because it lives inside the package; application tests import from the published entry point, as shown.

### Vitest configuration

A `vitest.config.ts` equivalent to what the package scripts rely on:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporters: ['verbose'],
    testTimeout: 15000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
```

`hookTimeout` is the one setting not to shorten: `afterEach` calls `db.disconnect()`, and the connection-pool suite allows that up to 30 seconds (`afterEach(..., 30000)`).

### Offline fixtures for statement builders

The builders need a `PostgreSQLDatabase` instance but never a connection, because the constructor only builds a lazy `pg.Pool`. This support module gives the unit tests a server-free database and a typed way to reach the protected SQL methods:

```typescript
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLDeleteStatement,
  PostgreSQLInsertStatement,
  PostgreSQLUpdateStatement,
} from 'blendsdk/postgresql';

/**
 * Config used by tests that never open a socket. Creating a PostgreSQLDatabase only
 * constructs a lazy pg.Pool, so statement builders can be exercised without a server.
 */
const offlineConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  pass: 'secret',
};

/** The SQL-producing methods are protected; tests reach them through this structural view. */
export interface StatementInternals {
  buildQuery(): string;
  buildParameters(): Record<string, unknown>;
}

export function internals(statement: object): StatementInternals {
  return statement as unknown as StatementInternals;
}

export function createOfflineDatabase(): PostgreSQLDatabase {
  return new PostgreSQLDatabase(offlineConfig);
}

export function createInsertStatement<T>(tableName: string): PostgreSQLInsertStatement<T> {
  return new PostgreSQLInsertStatement<T>(tableName, createOfflineDatabase());
}

export function createUpdateStatement<T, F>(tableName: string): PostgreSQLUpdateStatement<T, F> {
  return new PostgreSQLUpdateStatement<T, F>(tableName, createOfflineDatabase());
}

export function createDeleteStatement<F>(tableName: string): PostgreSQLDeleteStatement<F> {
  return new PostgreSQLDeleteStatement<F>(tableName, createOfflineDatabase());
}
```

No `disconnect()` is needed for these instances: no client is ever acquired, so nothing has to be drained.

### Test helper inventory

| Helper | Lives in | Purpose |
| --- | --- | --- |
| `connectionConfig` | `tests/params.ts` | Shared coordinates for the Docker-backed server. |
| `internals(statement)` | `tests/support/statements.ts` | Typed view of the protected `buildQuery()` / `buildParameters()`. |
| `createInsertStatement<T>()` / `createUpdateStatement<T, F>()` / `createDeleteStatement<F>()` | `tests/support/statements.ts` | Server-free builder factories. |
| `deferred<T>()` | concurrency suites | A promise plus its externally callable `resolve` / `reject`, used to hold one transaction open while another runs. |
| `uniqueTableName(label)` | concurrency suites | Collision-free table names for tests that need a real table visible on more than one session. |
| `CountingDatabase` | `tests/transaction-isolation.impl.test.ts` | Subclass that spies on `client.release` to prove "released exactly once". |
| `FailingClientDatabase` | `tests/transaction-isolation.impl.test.ts` | Subclass that fakes BEGIN/COMMIT/ROLLBACK failures the server cannot produce on demand. |

### What the suite covers where

| Test file | Needs Docker | Covers |
| --- | --- | --- |
| `statement-builders.test.ts` | No | SQL text and parameter objects for all three builders, empty-values errors, expression caching. |
| `database.test.ts` | Yes | Named parameters, field metadata, empty result sets, complex types, SQL-injection safety, factory methods, config handling. |
| `connection-pool.test.ts` | Yes | `poolConfig`, `disconnect()` with and without a timeout, shutdown rejection, release on query/transaction error, concurrency. |
| `transaction.test.ts` | Yes | Commit persistence, rollback on error, constraint violations, connection lifecycle, empty transaction. |
| `transaction-isolation.impl.test.ts` | Yes | Release accounting, BEGIN/COMMIT/ROLLBACK failure paths, detached-task rejection. |
| `transaction-isolation.spec.test.ts` | Yes | Concurrent transactions on distinct sessions, isolation levels, nested-transaction rejection. |
| `insert.test.ts`, `update.test.ts`, `delete.test.ts` | Yes | Builder integration, `RETURNING`, terminators, edge cases. |
| `from.test.ts` | Yes | FROM/SELECT shapes plus `byExpression` filtering. |
| `hooks.test.ts` | Yes | `beforeQuery` / `afterQuery` on every builder and on raw SQL. |

---

## Unit Testing

Unit tests here are **synchronous**. They instantiate a statement builder, call `values()` / `filter()` / `returning()`, and assert the exact SQL string and parameter object the builder would hand to the driver. No `await`, no pool, no Docker.

### Testing SQL generation without a server

```typescript
import { describe, expect, test } from 'vitest';
import {
  PostgreSQLDeleteStatement,
  PostgreSQLInsertStatement,
  PostgreSQLUpdateStatement,
} from 'blendsdk/postgresql';
import {
  createDeleteStatement,
  createInsertStatement,
  createOfflineDatabase,
  createUpdateStatement,
  internals,
} from './support/statements.js';

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

describe('INSERT SQL generation', () => {
  test('renders the column list from the value keys', () => {
    const statement = createInsertStatement<User>('users');

    statement.values({ name: 'Ada', email: 'ada@example.com' }).returning('*');

    expect(internals(statement).buildQuery()).toBe(
      'INSERT INTO users (name, email) VALUES (:name, :email) RETURNING *'
    );
    expect(internals(statement).buildParameters()).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
    });
  });

  test('fails while building, not while collecting values', () => {
    const statement = createInsertStatement<User>('users');

    expect(() => statement.values({})).not.toThrow();
    expect(() => internals(statement).buildQuery()).toThrow('no values provided');
  });
});

describe('UPDATE SQL generation', () => {
  test('keeps SET values and WHERE values in separate namespaces', () => {
    const statement = createUpdateStatement<User, UserFilter>('users');

    statement.values({ active: true }).filter({ active: false });

    expect(internals(statement).buildQuery()).toBe(
      'UPDATE users SET active = :v_active WHERE active = :p1'
    );
    expect(internals(statement).buildParameters()).toEqual({ v_active: true, p1: false });
  });

  test('omits WHERE when no filter was set', () => {
    const statement = createUpdateStatement<User, UserFilter>('users');

    statement.values({ name: 'Ada' });

    expect(internals(statement).buildQuery()).toBe('UPDATE users SET name = :v_name');
  });

  test('throws when the SET payload is empty even with a filter', () => {
    const statement = createUpdateStatement<User, UserFilter>('users');

    statement.values({}).filter({ id: 1 });

    expect(() => internals(statement).buildQuery()).toThrow(
      'Cannot build UPDATE statement for table "users": no values provided'
    );
  });
});

describe('DELETE SQL generation', () => {
  test('renders an unconditional DELETE when there is no filter', () => {
    const statement = createDeleteStatement<UserFilter>('sessions');

    expect(internals(statement).buildQuery()).toBe('DELETE FROM sessions');
    expect(internals(statement).buildParameters()).toEqual({});
  });

  test('renders WHERE and RETURNING together', () => {
    const statement = createDeleteStatement<UserFilter>('sessions');
    const columns: (keyof UserFilter)[] = ['id', 'email'];

    statement.filter({ active: false }).returning(columns);

    expect(internals(statement).buildQuery()).toBe(
      'DELETE FROM sessions WHERE active = :p1 RETURNING id, email'
    );
  });
});

describe('factory methods', () => {
  test('return dialect-specific builders', () => {
    const db = createOfflineDatabase();

    expect(db.insert<User>('users')).toBeInstanceOf(PostgreSQLInsertStatement);
    expect(db.update<User, UserFilter>('users')).toBeInstanceOf(PostgreSQLUpdateStatement);
    expect(db.delete<UserFilter>('sessions')).toBeInstanceOf(PostgreSQLDeleteStatement);
  });
});
```

This file is exactly what `pnpm run test:fast` executes: it finishes in milliseconds and never opens a socket.

### What to assert at this level

| Concern | Assertion |
| --- | --- |
| Column order | `buildQuery()` — keys of `values()` become the column list, in insertion order. |
| Placeholder naming | `:name` / `:email` for INSERT, `:v_<column>` for UPDATE SET, `:p1…pN` for WHERE. |
| `RETURNING` shape | `'RETURNING *'` versus `'RETURNING id, name, email'`. |
| Missing payload | `buildQuery()` throws; `values({})` alone does not. |
| No filter | UPDATE/DELETE emit no `WHERE` clause at all — that affects every row. |
| Parameter collisions | `values({ active: true }).filter({ active: false })` yields both `v_active` and `p1`. |
| Expression caching | Calling `buildQuery()` and `buildParameters()` twice yields identical output (the compiled WHERE expression is cached). |

---

## Integration Testing

Integration tests run against the Docker-backed server. Two lifecycle rules keep them deterministic.

### Rule 1 — one instance per test, always disconnect

```typescript fragment
let db: PostgreSQLDatabase;

beforeEach(() => {
  db = new PostgreSQLDatabase(connectionConfig);
});

afterEach(async () => {
  try {
    await db.disconnect(15000);
  } catch {
    // a test may have drained the pool already; cleanup must not mask the assertion
  }
}, 30000);
```

A fresh instance per test also gives a fresh pool: temp tables that linger in a reused pooled session cannot collide with the next test. `disconnect()` is sticky, so never share one instance between tests.

### Rule 2 — create fixtures inside the transaction that uses them

The workhorse pattern of the whole suite is `CREATE TEMP TABLE` as the first statement of a `withTransaction()` callback, followed by inserts, the operation under test, and the verification query — all on the same client.

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
  active?: boolean;
}

interface UserFilter {
  email?: string;
  active?: boolean;
}

const createUsersTable = `
  CREATE TEMP TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    age INTEGER,
    active BOOLEAN DEFAULT true
  )
`;

describe('users repository against a live server', () => {
  let db: PostgreSQLDatabase;

  beforeEach(() => {
    db = new PostgreSQLDatabase(connectionConfig);
  });

  afterEach(async () => {
    try {
      await db.disconnect(15000);
    } catch {
      // see rule 1
    }
  }, 30000);

  test('returns committed rows from the transaction', async () => {
    const created = await db.withTransaction(async (tx) => {
      await tx.executeQuery(createUsersTable);

      return tx
        .insert<User>('users')
        .values({ name: 'Ada Lovelace', email: 'ada@example.com', age: 36 })
        .returning('*')
        .executeReturnSingle();
    });

    expect(created).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      age: 36,
      active: true,
    });
    expect(created?.id).toBeTypeOf('number');
  });

  test('rolls back every statement when the callback throws', async () => {
    await db.withTransaction(async (tx) => {
      await tx.executeQuery(createUsersTable);
      await tx
        .insert<User>('users')
        .values({ name: 'Grace Hopper', email: 'grace@example.com' })
        .execute();
    });

    await expect(
      db.withTransaction(async (tx) => {
        await tx
          .update<User, UserFilter>('users')
          .values({ active: false })
          .filter({ email: 'grace@example.com' })
          .execute();
        throw new Error('intentional rollback');
      })
    ).rejects.toThrow('intentional rollback');

    const { records } = await db.executeQuery<{ active: boolean }>(
      'SELECT active FROM users WHERE email = :email',
      { email: 'grace@example.com' }
    );
    expect(records).toEqual([{ active: true }]);
  });

  test('returns null, [], and 0 when no row matches', async () => {
    const outcome = await db.withTransaction(async (tx) => {
      await tx.executeQuery(createUsersTable);

      const single = await tx
        .update<User, UserFilter>('users')
        .values({ name: 'nobody' })
        .filter({ email: 'missing@example.com' })
        .returning('*')
        .executeReturnSingle();

      const all = await tx
        .delete<UserFilter>('users')
        .filter({ email: 'missing@example.com' })
        .returning('*')
        .executeReturnAll();

      const count = await tx
        .delete<UserFilter>('users')
        .filter({ email: 'missing@example.com' })
        .executeReturnCount();

      return { single, all, count };
    });

    expect(outcome.single).toBeNull();
    expect(outcome.all).toEqual([]);
    expect(outcome.count).toBe(0);
  });
});
```

The second and third tests read the temp table after the transaction that created it. That works because a sequential workload on one instance normally reuses the same idle pooled client — the package's own suite relies on the same behaviour. Treat it as a convenience, not a contract: when the verification *must* see the same session, put it inside the same `withTransaction()` callback, as the first test does.

### Testing concurrency and isolation

Concurrency tests need two sessions open at once, so they use `deferred()` to gate one transaction while another runs, and `uniqueTableName()` for tables visible across sessions:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PostgreSQLDatabase, TransactionIsolation } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Real tables are shared across sessions, so their names must not collide between suites. */
function uniqueTableName(label: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `tx_${label}_${Date.now()}_${random}`;
}

describe('transaction isolation on a shared instance', () => {
  let db: PostgreSQLDatabase;

  beforeEach(() => {
    db = new PostgreSQLDatabase(connectionConfig);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test('runs concurrent transactions on different sessions', async () => {
    const pids = await Promise.all([
      db.withTransaction(async (tx) => {
        const { records } = await tx.executeQuery<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid'
        );
        await tx.executeQuery('SELECT pg_sleep(0.2)');
        return records[0]?.pid;
      }),
      db.withTransaction(async (tx) => {
        const { records } = await tx.executeQuery<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid'
        );
        return records[0]?.pid;
      }),
    ]);

    expect(pids[0]).toBeTypeOf('number');
    expect(pids[1]).toBeTypeOf('number');
    expect(pids[0]).not.toBe(pids[1]);
  });

  test('keeps a committed transaction when a concurrent transaction rolls back', async () => {
    const table = uniqueTableName('rollback');
    await db.executeQuery(`CREATE TABLE "${table}" (label text NOT NULL)`);

    const firstInserted = deferred();
    const releaseFirst = deferred();

    try {
      const first = db.withTransaction(async (tx) => {
        await tx.executeQuery(`INSERT INTO "${table}" (label) VALUES ('first')`);
        firstInserted.resolve();
        await releaseFirst.promise;
        throw new Error('rollback the first transaction');
      });

      await firstInserted.promise;

      await db.withTransaction(async (tx) => {
        await tx.executeQuery(`INSERT INTO "${table}" (label) VALUES ('second')`);
      });

      releaseFirst.resolve();
      await expect(first).rejects.toThrow('rollback the first transaction');

      const { records } = await db.executeQuery<{ label: string }>(
        `SELECT label FROM "${table}" ORDER BY label`
      );
      expect(records.map((record) => record.label)).toEqual(['second']);
    } finally {
      releaseFirst.resolve();
      await db.executeQuery(`DROP TABLE IF EXISTS "${table}"`);
    }
  });

  test('applies the requested isolation level', async () => {
    const isolation: TransactionIsolation = 'serializable';

    const level = await db.withTransaction(
      async (tx) => {
        const { records } = await tx.executeQuery<{ transaction_isolation: string }>(
          'SHOW transaction_isolation'
        );
        return records[0]?.transaction_isolation;
      },
      { isolation }
    );

    expect(level).toBe('serializable');
  });

  test('rejects a nested transaction', async () => {
    await db.withTransaction(async () => {
      await expect(db.withTransaction(async () => 'nested')).rejects.toThrow(
        /nested transaction/u
      );
    });
  });

  test('rejects a query issued after the transaction settled', async () => {
    const gate = deferred();
    let detached!: Promise<unknown>;

    await db.withTransaction(async (tx) => {
      detached = gate.promise.then(() => tx.executeQuery('SELECT 1'));
    });
    gate.resolve();

    await expect(detached).rejects.toThrow(
      'Cannot execute a query after the transaction has completed'
    );
  });
});
```

### Parallel-suite safety

Vitest runs test files in parallel threads against one `testdb`. Two conventions keep that safe, and application suites should copy them:

1. **Temp tables only when one session suffices.** Each test builds its own `PostgreSQLDatabase`, so each test starts on a fresh session and cannot collide with another file's `test_users`.
2. **Real tables get a unique name and a `finally` drop.** Anything that must be visible to two sessions (isolation and locking tests) is created outside the transaction as `tx_<label>_<timestamp>_<random>` and dropped in `finally`, as above.

---

## Mocking & Stubbing

### Choose the seam first

| Goal | Seam | Mechanism |
| --- | --- | --- |
| Assert generated SQL | The builders themselves | No mock — the offline fixture. |
| Test your code around a query result | `executeQuery()` | `vi.spyOn(db, 'executeQuery').mockResolvedValue(...)`. |
| Test your code around a whole transaction | `withTransaction()` | Same spy, `mockImplementation(...)`. |
| Test BEGIN/COMMIT/ROLLBACK failure handling | `connect()` | Subclass returning a fake `PoolClient`. |
| Prove clients are released exactly once | `client.release` | Spy installed per acquisition in a subclass. |
| Silence expected `console.error` output | `console.error` | `vi.spyOn(console, 'error').mockImplementation(() => {})`. |

### Stubbing `executeQuery`

```typescript
import { describe, expect, test, vi } from 'vitest';
import { PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

interface AccountRow {
  id: number;
  email: string;
  balance: string;
}

async function findAccountByEmail(
  db: PostgreSQLDatabase,
  email: string
): Promise<AccountRow | null> {
  const result: PostgreSQLQueryResult<AccountRow> = await db.executeQuery<AccountRow>(
    'SELECT id, email, balance FROM accounts WHERE email = :email',
    { email }
  );
  return result.records[0] ?? null;
}

describe('findAccountByEmail', () => {
  test('returns the first row returned by the database', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);
    const spy = vi.spyOn(db, 'executeQuery');

    spy.mockResolvedValue({
      records: [{ id: 1, email: 'ada@example.com', balance: '10.00' }],
      rowCount: 1,
      fields: [],
    });

    try {
      const account = await findAccountByEmail(db, 'ada@example.com');

      expect(account).toEqual({ id: 1, email: 'ada@example.com', balance: '10.00' });
      expect(spy).toHaveBeenCalledWith(
        'SELECT id, email, balance FROM accounts WHERE email = :email',
        { email: 'ada@example.com' }
      );
    } finally {
      spy.mockRestore();
      await db.disconnect();
    }
  });
});
```

A spy on `executeQuery` replaces the entire pipeline — hooks, `yesql` placeholder conversion, driver, result normalization. Use it only to test *your* logic around a result; never to assert generated SQL (that belongs to the offline builder tests) or hook behaviour.

### Simulating driver failures

`BEGIN`, `COMMIT` and `ROLLBACK` failures cannot be produced on a healthy server. Subclassing `connect()` keeps the real `withTransaction()` implementation under test while the fake client makes the failure deterministic:

```typescript
import { describe, expect, test } from 'vitest';
import type { PoolClient } from 'pg';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

type Failure = 'begin' | 'commit' | 'rollback' | 'commit-and-rollback';

class FailingClientDatabase extends PostgreSQLDatabase {
  readonly releases: Array<boolean | undefined> = [];

  constructor(
    config: PostgreSQLConfig,
    private readonly failure: Failure
  ) {
    super(config);
  }

  override connect(): Promise<PoolClient> {
    const client = {
      query: async (text: string) => {
        if (text === 'BEGIN' && this.failure === 'begin') {
          throw new Error('BEGIN failed');
        }
        if (
          text === 'COMMIT' &&
          (this.failure === 'commit' || this.failure === 'commit-and-rollback')
        ) {
          throw new Error('COMMIT failed');
        }
        if (
          text === 'ROLLBACK' &&
          (this.failure === 'rollback' || this.failure === 'commit-and-rollback')
        ) {
          throw new Error('ROLLBACK failed');
        }
        return { rows: [], rowCount: 0, fields: [] };
      },
      release: (destroy?: Error | boolean) => {
        this.releases.push(typeof destroy === 'boolean' ? destroy : undefined);
      },
    } as unknown as PoolClient;

    return Promise.resolve(client);
  }
}

describe('transaction failure paths', () => {
  test('destroys the client when BEGIN fails', async () => {
    const db = new FailingClientDatabase(connectionConfig, 'begin');

    await expect(db.withTransaction(async () => 'never runs')).rejects.toThrow('BEGIN failed');
    expect(db.releases).toEqual([true]);

    await db.disconnect();
  });

  test('releases normally when COMMIT fails but ROLLBACK succeeds', async () => {
    const db = new FailingClientDatabase(connectionConfig, 'commit');

    await expect(db.withTransaction(async () => 'value')).rejects.toThrow('COMMIT failed');
    expect(db.releases).toEqual([false]);

    await db.disconnect();
  });

  test('destroys the client when COMMIT and ROLLBACK both fail', async () => {
    const db = new FailingClientDatabase(connectionConfig, 'commit-and-rollback');

    await expect(db.withTransaction(async () => 'value')).rejects.toThrow('COMMIT failed');
    expect(db.releases).toEqual([true]);

    await db.disconnect();
  });
});
```

`PoolClient` is a `pg` type; the adapter depends on `pg`, and `@types/pg` supplies the declarations used here.

### Counting client acquisitions and releases

To prove the "released exactly once" contract, count per acquisition. `pg-pool` replaces `client.release` on every acquisition, so the spy has to be re-installed each time:

```typescript
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

interface Acquisition {
  id: number;
  released: boolean;
}

class CountingDatabase extends PostgreSQLDatabase {
  connects = 0;
  releases = 0;
  doubleReleases = 0;
  readonly acquisitions: Acquisition[] = [];
  private readonly current = new WeakMap<PoolClient, Acquisition>();

  override connect(): Promise<PoolClient> {
    this.connects += 1;
    const acquisition: Acquisition = { id: this.connects, released: false };
    this.acquisitions.push(acquisition);

    return super.connect().then((client) => {
      this.current.set(client, acquisition);
      const release = client.release.bind(client);
      vi.spyOn(client, 'release').mockImplementation((error?: Error | boolean) => {
        const tracked = this.current.get(client);
        if (tracked) {
          if (tracked.released) {
            this.doubleReleases += 1;
          } else {
            tracked.released = true;
            this.releases += 1;
          }
        }
        release(error);
      });
      return client;
    });
  }
}

describe('client lifecycle accounting', () => {
  let db: CountingDatabase;

  beforeEach(() => {
    db = new CountingDatabase(connectionConfig);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test('acquires and releases exactly one client per query and transaction', async () => {
    await db.executeQuery('SELECT 1');
    await db.withTransaction(async (tx) => {
      await tx.executeQuery('SELECT 2');
    });
    await expect(
      db.withTransaction(async () => {
        throw new Error('roll back');
      })
    ).rejects.toThrow('roll back');

    expect(db.connects).toBe(3);
    expect(db.releases).toBe(3);
    expect(db.doubleReleases).toBe(0);
    expect(db.acquisitions.every((acquisition) => acquisition.released)).toBe(true);
  });
});
```

The spy calls through to the original `release`, so the pool's own bookkeeping still works.

### Silencing expected log output

Error paths log with `console.error` before the client is destroyed. Spy on it and restore in `finally` so a failing assertion cannot leave the spy installed:

```typescript fragment
const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

try {
  await expect(db.withTransaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
} finally {
  consoleSpy.mockRestore();
}
```

### What not to mock

- **Do not mock `pg` and `yesql` at module level.** The package's suite keeps the real driver and the real placeholder conversion; a fake client behind `connect()` is enough to simulate failures and still exercises hooks, `yesql` and result normalization.
- **Do not assert SQL through a mocked `executeQuery`.** Use the offline builder tests.
- **Do not mock `withTransaction` to test hook behaviour.** Hooks live in `executeOnClient()`; a mocked transaction never reaches them.

---

## Test Patterns by Feature

### Connection and configuration

Constructing a database never connects, so config handling is a pure unit test:

```typescript fragment
expect(() => new PostgreSQLDatabase(connectionConfig)).not.toThrow();
expect(() => new PostgreSQLDatabase({ ...connectionConfig, port: '5400' })).not.toThrow();
expect(() => new PostgreSQLDatabase({ ...connectionConfig, poolConfig: { max: 20 } })).not.toThrow();
expect(() => new PostgreSQLDatabase({ ...connectionConfig, poolConfig: {} })).not.toThrow();
```

| What you are checking | Assertion |
| --- | --- |
| Full, partial and absent `poolConfig` | Construction does not throw. |
| `port` as a numeric string | Construction does not throw; the constructor applies `Number()`. |
| Omitted `port` | Construction does not throw. |
| Bad host / port | The first `executeQuery()` rejects; `disconnect()` still resolves. |

### `executeQuery`

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

describe('executeQuery', () => {
  let db: PostgreSQLDatabase;

  beforeEach(() => {
    db = new PostgreSQLDatabase(connectionConfig);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test('binds named parameters instead of interpolating them', async () => {
    const { records, rowCount } = await db.executeQuery<{ name: string }>(
      'SELECT :name AS name',
      { name: 'john' }
    );

    expect(rowCount).toBe(1);
    expect(records).toEqual([{ name: 'john' }]);
  });

  test('reports column metadata', async () => {
    const { fields } = await db.executeQuery('SELECT 1 AS id, :name AS name, true AS active', {
      name: 'test',
    });

    expect(fields.map((field) => field.name)).toEqual(['id', 'name', 'active']);
  });

  test('returns an empty, fieldless result for a query that matched nothing', async () => {
    const { records, rowCount, fields } = await db.executeQuery<{ id: number }>(
      'SELECT 1 AS id WHERE false'
    );

    expect(records).toEqual([]);
    expect(rowCount).toBe(0);
    expect(fields).toEqual([]);
  });

  test('keeps hostile input out of the SQL text', async () => {
    const outcome = await db.withTransaction(async (tx) => {
      await tx.executeQuery('CREATE TEMP TABLE injection_probe (name TEXT NOT NULL)');
      await tx.executeQuery('INSERT INTO injection_probe (name) VALUES (:name)', {
        name: 'legitimate',
      });

      const hostile = "'; DROP TABLE injection_probe; --";
      const attack = await tx.executeQuery('SELECT * FROM injection_probe WHERE name = :name', {
        name: hostile,
      });

      const survivors = await tx.executeQuery<{ name: string }>('SELECT name FROM injection_probe');
      return { attack, survivors };
    });

    expect(outcome.attack.rowCount).toBe(0);
    expect(outcome.survivors.records).toEqual([{ name: 'legitimate' }]);
  });
});
```

The pattern for injection tests is always the same: run the hostile value through a parameterized statement, assert zero matches, then assert the table still exists and still holds the legitimate row.

### Transactions

| Guarantee | How to test it | Expected outcome |
| --- | --- | --- |
| Commit persists | Insert in `withTransaction`, return the row, assert it outside | Row present |
| Rollback on throw | Mutate, then `throw`, assert with `rejects.toThrow(...)` | Original state intact |
| Constraint violation rolls back | Insert a duplicate into a `UNIQUE` column inside the transaction | Whole transaction undone |
| Isolation level applied | `SHOW transaction_isolation` inside the callback | Matches the requested level |
| Nested call rejected | Call `db.withTransaction()` inside an active one | Rejects with `/nested transaction/` |
| Detached task rejected | `gate.then(() => tx.executeQuery(...))` after the callback settles | Rejects with `Cannot execute a query after the transaction has completed` |
| Client released once | `CountingDatabase` from the mocking section | `doubleReleases === 0` |
| Empty transaction | `withTransaction(async () => 'done')` | Resolves with `'done'` |

Exact rejection messages are stable and safe to assert on:

| Condition | Message |
| --- | --- |
| Shutdown started | `Cannot start transaction: database is shutting down` |
| Nested transaction | `Cannot start a nested transaction: a transaction is already active on this database handle.` |
| Settled context | `Cannot start a transaction from a completed transaction context.` |
| Non-object options | `Transaction options must be an object.` |
| Unknown isolation | `Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".` |
| Query after the callback | `Cannot execute a query after the transaction has completed. Do not use the transaction handle outside its callback.` |

Invalid options are rejected **before** a client is acquired — a useful assertion when you have a `CountingDatabase`:

```typescript fragment
await expect(
  db.withTransaction(async () => 'never runs', { isolation: 'read uncommitted' as TransactionIsolation })
).rejects.toThrow('Unsupported transaction isolation level');
expect(counting.connects).toBe(0);
```

### Statement builders

Generated SQL for the common chains:

| Chain | Generated SQL |
| --- | --- |
| `insert<User>('users').values({ name, email })` | `INSERT INTO users (name, email) VALUES (:name, :email)` |
| `... .returning('*')` | `INSERT INTO users (name, email) VALUES (:name, :email) RETURNING *` |
| `update<T, F>('users').values({ active })` | `UPDATE users SET active = :v_active` |
| `... .filter({ id: 1 })` | `UPDATE users SET active = :v_active WHERE id = :p1` |
| `delete<F>('sessions')` | `DELETE FROM sessions` |
| `delete<F>('sessions').filter({ active: false })` | `DELETE FROM sessions WHERE active = :p1` |
| `... .returning(['id', 'name'])` | `DELETE FROM sessions WHERE active = :p1 RETURNING id, name` |

Integration tests then verify behaviour, not text — for example that a bulk `DELETE` with `filter({})` really removes every row, or that `executeReturnAll()` returns multiple deleted records:

```typescript fragment
const deleted = await tx
  .delete<{ category: string }>('products')
  .filter({ category: 'Electronics' })
  .returning('*')
  .executeReturnAll();

expect(deleted).toHaveLength(2);
expect(deleted[0]).toMatchObject({ category: 'Electronics' });
```

### `RETURNING` and terminators

| Terminator | Rows matched | No row matched |
| --- | --- | --- |
| `execute()` | `PostgreSQLQueryResult<T>` with records | Result with `rowCount: 0` |
| `executeReturnSingle()` | First record | `null` |
| `executeReturnAll()` | All records | `[]` |
| `executeReturnCount()` | Affected count | `0` |

`executeReturnSingle()` **requires** `returning()` to have been called; without it there is nothing to map and the assertion on the returned row will fail. The zero-row contract is asserted in one place per builder, as in the integration file above.

### Query hooks

`beforeQuery` sees different key names depending on the statement, which is what a hook test should pin down:

| Statement | Keys passed to `beforeQuery` |
| --- | --- |
| `executeQuery()` (raw SQL) | Exactly the keys you supplied. |
| INSERT | Column names — `name`, `email`, …. |
| UPDATE | SET values as `v_<column>`, WHERE values as `p1`, `p2`, …. |
| DELETE | WHERE values as `p1`, `p2`, …. |

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

interface ProbeRow {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

interface ProbeFilter {
  email?: string;
  active?: boolean;
}

describe('query hooks', () => {
  let db: PostgreSQLDatabase;

  beforeEach(() => {
    db = new PostgreSQLDatabase(connectionConfig);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test('shows which parameter keys each builder hands to beforeQuery', async () => {
    const observed: Array<{ statement: string; keys: string[] }> = [];

    await db.withTransaction(async (tx) => {
      await tx.executeQuery(`
        CREATE TEMP TABLE hook_probe (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          active BOOLEAN DEFAULT true
        )
      `);

      await tx
        .insert<ProbeRow>('hook_probe')
        .values({ name: 'Ada', email: 'ada@example.com' })
        .beforeQuery((params) => {
          observed.push({ statement: 'insert', keys: Object.keys(params) });
          return params;
        })
        .execute();

      await tx
        .update<ProbeRow, ProbeFilter>('hook_probe')
        .values({ active: false })
        .filter({ email: 'ada@example.com' })
        .beforeQuery((params) => {
          observed.push({ statement: 'update', keys: Object.keys(params) });
          return params;
        })
        .execute();

      await tx
        .delete<ProbeFilter>('hook_probe')
        .filter({ email: 'ada@example.com' })
        .beforeQuery((params) => {
          observed.push({ statement: 'delete', keys: Object.keys(params) });
          return params;
        })
        .execute();
    });

    expect(observed).toEqual([
      { statement: 'insert', keys: ['name', 'email'] },
      { statement: 'update', keys: ['v_active', 'p1'] },
      { statement: 'delete', keys: ['p1'] },
    ]);
  });

  test('strips sensitive columns and skips afterQuery for empty results', async () => {
    const calls: string[] = [];

    const outcome = await db.withTransaction(async (tx) => {
      await tx.executeQuery(`
        CREATE TEMP TABLE secrets (
          id SERIAL PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL
        )
      `);

      await tx.executeQuery(
        'INSERT INTO secrets (email, password_hash) VALUES (:email, :password_hash)',
        { email: 'ada@example.com', password_hash: 'hash' }
      );

      const safeRow = await tx
        .delete<ProbeFilter>('secrets')
        .filter({ email: 'ada@example.com' })
        .afterQuery((rows) => {
          calls.push('after');
          return rows.map((row) => ({ id: Number(row.id), email: String(row.email) }));
        })
        .returning('*')
        .executeReturnSingle();

      const empty = await tx
        .delete<ProbeFilter>('secrets')
        .filter({ email: 'missing@example.com' })
        .afterQuery((rows) => {
          calls.push('after');
          return rows;
        })
        .returning('*')
        .executeReturnAll();

      return { safeRow, empty };
    });

    expect(outcome.safeRow).toEqual({ id: expect.any(Number), email: 'ada@example.com' });
    expect(outcome.safeRow).not.toHaveProperty('password_hash');
    expect(outcome.empty).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
```

Two hook facts worth repeating as assertions:

- `afterQuery` is **not called** when `rowCount === 0`, because `executeQuery()` returns the empty result before mapping rows.
- An exception thrown inside either hook propagates out of the statement terminator and rolls the surrounding transaction back — assert with `rejects.toThrow('BeforeQuery hook error')`.

### SELECT and expression filters

`from()` and `selectAll()` are inherited from `blendsdk/dbcore`; this package tests them for behaviour rather than SQL text. `filterByExpression` (on UPDATE/DELETE) and `byExpression` (on FROM) take a compiled expression from `blendsdk/expression`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { query } from 'blendsdk/expression';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
  active?: boolean;
}

describe('SELECT with compiled expressions', () => {
  let db: PostgreSQLDatabase;

  beforeEach(() => {
    db = new PostgreSQLDatabase(connectionConfig);
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test('filters rows with byExpression', async () => {
    const result = await db.withTransaction(async (tx) => {
      await tx.executeQuery(`
        CREATE TEMP TABLE expression_users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true
        )
      `);

      await tx.executeQuery(`
        INSERT INTO expression_users (name, email, age, active) VALUES
          ('John Doe', 'john@example.com', 25, true),
          ('Jane Smith', 'jane@example.com', 30, true),
          ('Bob Johnson', 'bob@example.com', 25, false)
      `);

      return tx
        .from<User>('expression_users')
        .select(['id', 'name', 'age'])
        .byExpression(query<User>().where('age').equals(25).compile())
        .execute();
    });

    expect(result?.rowCount).toBe(2);
    expect(result?.records.map((record) => record.age)).toEqual([25, 25]);
  });

  test('combines expression filters with builder updates', async () => {
    const updated = await db.withTransaction(async (tx) => {
      await tx.executeQuery(`
        CREATE TEMP TABLE expression_updates (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true
        )
      `);

      await tx.executeQuery(`
        INSERT INTO expression_updates (name, age) VALUES
          ('Young Adult', 25),
          ('Senior', 70)
      `);

      return tx
        .update<{ active: boolean }, { age?: number }>('expression_updates')
        .values({ active: false })
        .filterByExpression((q) => q.where('age').greaterThan(65))
        .executeReturnCount();
    });

    expect(updated).toBe(1);
  });
});
```

`blendsdk/expression` ships in the `blendsdk` umbrella; the package's own suite loads it with a dynamic `await import(...)` inside each test, which is equivalent but unnecessary in application tests.

### Shutdown and lifecycle

```typescript fragment
test('rejects new work once disconnect has started', async () => {
  const pending = db.disconnect();

  await expect(db.executeQuery('SELECT 1')).rejects.toThrow(
    'Cannot execute query: database is shutting down'
  );
  await expect(db.withTransaction(async () => 'never runs')).rejects.toThrow(
    'Cannot start transaction: database is shutting down'
  );

  await pending;
});
```

Two habits to carry over:

- The shutdown flag is sticky. After `disconnect()` the instance is unusable — build a new one instead of reconnecting.
- A second `disconnect()` on an already drained pool can reject, which is why every `afterEach` in the suite wraps it in `try/catch` and never lets cleanup mask the real assertion.

---

## Assertion Reference

PostgreSQL's wire types surface in JavaScript in ways that surprise first-time assertions:

| Column type | Value in `records` | Assertion |
| --- | --- | --- |
| `INTEGER`, `SERIAL` | `number` | `toBe(36)` |
| `NUMERIC`, `DECIMAL`, `BIGINT` | `string` | `toBe('29.99')`, `parseFloat(...)` |
| `COUNT(*)`, `SUM()` | `string` | `parseInt(record.count, 10)` |
| `BOOLEAN` | `boolean` | `toBe(true)` |
| `TEXT`, `VARCHAR` | `string` | `toBe('Ada')` |
| `JSONB` | parsed object | `toEqual({ settings: { theme: 'dark' } })` |
| `TEXT[]` | string array | `toEqual(['a', 'b'])` |
| `TIMESTAMP`, `DATE` | `Date` | `toEqual(expect.any(Date))` |
| No matching rows | `{ records: [], rowCount: 0, fields: [] }` | `toEqual([])` |

Recurring gotchas:

- **Unfiltered UPDATE/DELETE hit every row.** `.values(...)` without `.filter(...)` is a valid statement; assert the affected count deliberately.
- **`executeReturnSingle()` needs `returning()`.** Without a RETURNING clause there is no row to return.
- **`afterQuery` never sees empty results.** Assert `[]` from the terminator, not a mapped empty array.
- **Temp tables belong to a session.** Keep table creation and verification in the same `withTransaction()` callback when it matters.
- **Errors are plain `Error` objects with exact messages.** `toThrow('substring')` is enough and survives message extensions.
- **Assert "did not throw" with `resolves.not.toThrow()`.** The package suite uses this shape for `disconnect()`.

---

For the feature-level summary see the Overview; for the abstractions behind these tests see Core Concepts; for task-oriented recipes see Basic Usage.

---

# postgresql Troubleshooting

This document catalogues the failures you will actually hit with `blendsdk/postgresql`: errors raised by the adapter itself, errors raised by the `pg` driver, errors raised by the PostgreSQL server, and the TypeScript compiler errors that the package's type surface produces. Every entry follows the same shape — **error or symptom → cause → fix** — and every fix ends in a runnable example.

Two rules make the rest of this document easier to read:

- **Adapter errors** are thrown from `src/database.ts` and the three statement builders, and their text is exact.
- **Server errors** arrive as `pg` errors; the human-readable `message` changes with locale and version, so match on `error.code` (SQLSTATE) whenever you branch on them.

---

## Common Errors

A phrase table for orientation. Search for the message in this section.

| Message or symptom | Usually means | Group |
| --- | --- | --- |
| `Cannot execute query: database is shutting down` | Work arrived after `disconnect()` | Connection |
| `Cannot use a pool after calling end on the pool` | `connect()` called after `disconnect()` | Connection |
| Query never settles / `timeout exceeded when trying to connect` | Pool exhaustion or a leaked client | Connection |
| `ECONNREFUSED`, `password authentication failed`, `database "…" does not exist` | Configuration | Connection |
| `no pg_hba.conf entry … SSL off` | TLS cannot be configured through the adapter | Connection |
| `Connection terminated unexpectedly` | Idle client killed by a proxy | Connection |
| `Cannot start a nested transaction …` | `withTransaction()` inside `withTransaction()` | Transaction |
| `Cannot start a transaction from a completed transaction context.` | Detached task inherited a closed context | Transaction |
| `Cannot execute a query after the transaction has completed.` | Retained `tx` handle | Transaction |
| `Transaction options must be an object.` / `Unsupported transaction isolation level …` | Bad `TransactionOptions` | Transaction |
| `current transaction is aborted …` | Error swallowed inside the callback | Transaction |
| `could not serialize access due to concurrent update` | Serializable conflict, no retry | Transaction |
| `Cannot build INSERT/UPDATE statement … no values provided` | Empty `.values({})` | Builders |
| `executeReturnCount()` returns `0` although rows match | `null`/`undefined` filter values | Builders |
| `syntax error at or near ":"`, `there is no parameter $1` | Placeholder style mismatch | SQL |
| `cannot insert multiple commands into a prepared statement` | Multi-statement script through `executeQuery()` | SQL |
| `duplicate key value violates unique constraint …` | SQLSTATE `23505` | SQL |
| `null value in column … violates not-null constraint` | Explicit `null`/`undefined` value | SQL |
| `invalid input syntax for type integer: "…"` | Unparseable bound value | SQL |
| `relation "…" does not exist` after `CREATE TEMP TABLE` | Temp table on a different pooled session | SQL |
| `column "…" must appear in the GROUP BY clause …` | Grouped query through the FROM builder | SQL |
| `price`/`count` come back as strings | `numeric`/`int8`/`count` stringify | SQL |
| `TS2307`, `TS1479`, `TS7006`, `TS18047`, `TS18048`, `TS2322` | Module resolution, ESM, strict-mode narrowing | TypeScript |

---

### Connection and pool errors

#### `Cannot execute query: database is shutting down`

**Error**

```text
Error: Cannot execute query: database is shutting down
```

**Cause**

`disconnect()` sets the protected `isShuttingDown` flag *synchronously*, before it awaits `pool.end()`. Both `executeQuery()` and `withTransaction()` check that flag as their very first statement, so anything that reaches the adapter after the shutdown began — a queued request, a timer callback, a retry loop — is rejected. The flag is never cleared, so a disconnected instance cannot be revived.

**Fix**

1. Stop accepting new work *before* calling `disconnect()` (close the HTTP listener, unsubscribe consumers).
2. Treat the error as terminal for that instance — never retry on the same `PostgreSQLDatabase`.
3. Build a new instance if you genuinely need to reconnect.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);
await db.executeQuery('SELECT 1');

const draining = db.disconnect(5000);

try {
  await db.executeQuery('SELECT 1');
} catch (error) {
  // Drain the request queue here; do not reconnect this instance.
  console.log(error instanceof Error ? error.message : error);
}

await draining;

const reconnected = new PostgreSQLDatabase(config);
const { rowCount } = await reconnected.executeQuery('SELECT 1');
console.log(`reconnected rowCount=${rowCount}`);
await reconnected.disconnect();
```

---

#### `Cannot use a pool after calling end on the pool`

**Error**

```text
Error: Cannot use a pool after calling end on the pool
```

**Cause**

`executeQuery()` and `withTransaction()` guard against shutdown, but `connect()` does not — it delegates straight to `pool.connect()`. Once `disconnect()` has ended the pool, `pg-pool` raises this error instead of the adapter's own message, which is why the symptom looks like a different failure mode.

**Fix**

Prefer `executeQuery()`. When you need driver-level access, funnel every acquisition through one helper that always releases the client and treats the pool-ended error as "already closed".

```typescript
import { PoolClient } from 'pg';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
};

async function withRawClient<T>(
  db: PostgreSQLDatabase,
  fn: (client: PoolClient) => Promise<T>
): Promise<T | null> {
  try {
    const client = await db.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Cannot use a pool after calling end on the pool') {
      return null;
    }
    throw error;
  }
}

const db = new PostgreSQLDatabase(config);

const raw = await withRawClient(db, async (client) => {
  const { rows } = await client.query<{ value: number }>('SELECT 1 AS value');
  return rows[0]?.value ?? 0;
});
console.log(`raw client read ${raw}`);

await db.disconnect();

const afterShutdown = await withRawClient(db, async (client) => {
  const { rows } = await client.query<{ value: number }>('SELECT 1 AS value');
  return rows[0]?.value ?? 0;
});
console.log(`after shutdown: ${afterShutdown}`);
```

---

#### Queries hang forever, or `timeout exceeded when trying to connect`

**Symptom**

`await db.executeQuery(...)` never settles. If `connectionTimeoutMillis` is configured, it eventually rejects with:

```text
Error: timeout exceeded when trying to connect
```

**Cause**

Pool exhaustion. `poolConfig.max` defaults to 10 and `connectionTimeoutMillis` defaults to **0 — wait forever**. A single leaked client is enough to stall a service: `db.connect()` without `client.release()`, a transaction whose callback awaits an untrusted promise, or `disconnect()` never being called during tests. new acquires then queue invisibly.

**Fix**

1. Release every raw client in a `finally` block.
2. Set `connectionTimeoutMillis` so exhaustion fails loudly instead of hanging.
3. Instrument the pool with a subclass; `pool { totalCount, idleCount, waitingCount }` tells you instantly whether you have a leak.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

class ObservableDatabase extends PostgreSQLDatabase {
  snapshot(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }
}

const db = new ObservableDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig: { max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000 },
});

const client = await db.connect();
try {
  await client.query('SELECT 1');
} finally {
  client.release();
}

console.log(db.snapshot()); // { total: 1, idle: 1, waiting: 0 }
await db.disconnect();
```

If `waiting` keeps growing while `idle` stays at `0`, the leak is a client that was acquired and never released.

---

#### `connect ECONNREFUSED 127.0.0.1:5432`

**Error**

```text
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Cause**

Nothing is listening on the configured host and port. The pool is created lazily in the constructor, so a bad address does **not** fail at `new PostgreSQLDatabase(...)` — it fails at the first query, several layers away from the configuration mistake.

**Fix**

Verify that the server is reachable and that `config.port` matches. The integration suite in this repository reads `tests/params.ts` and expects PostgreSQL on `localhost:5599` with database, user and password all set to `testdb`; run `pnpm run db:up` before the suite and `pnpm run db:down` afterwards.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5599,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
});

try {
  const { rowCount } = await db.executeQuery('SELECT 1');
  console.log(`connected, rowCount=${rowCount}`);
} catch (error) {
  console.error(`cannot reach PostgreSQL: ${error instanceof Error ? error.message : error}`);
  throw error;
} finally {
  await db.disconnect();
}
```

---

#### `password authentication failed for user "appuser"`

**Error**

```text
error: password authentication failed for user "appuser"
```

**Cause**

`PostgreSQLConfig.pass` is mapped to node-postgres' `password` field. There is no `password` option, so a config that spells it `password: '…'` compiles against an unrelated field at best and is ignored at worst — the driver then connects with no password and authentication fails against a `scram-sha-256` or `md5` role.

**Fix**

Supply `pass`, and read credentials from the environment so a missing value fails loudly instead of silently authenticating as the OS user.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

function readEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing environment variable ${name}`);
  }
  return value;
}

const config: PostgreSQLConfig = {
  host: readEnv('PGHOST'),
  port: Number(readEnv('PGPORT')),
  database: readEnv('PGDATABASE'),
  user: readEnv('PGUSER'),
  pass: readEnv('PGPASSWORD'),
};

const db = new PostgreSQLDatabase(config);

try {
  await db.executeQuery('SELECT 1');
  console.log('authenticated');
} finally {
  await db.disconnect();
}
```

---

#### `database "appdb" does not exist`

**Error**

```text
error: database "appdb" does not exist
```

**Cause**

The pool connects to `config.database`. `pg` creates databases — it never does; the database must already exist on the server.

**Fix**

Point the configuration at an existing database, or create it once from a maintenance connection. `42P04` is `duplicate_database`, which you can treat as success.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const adminConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  pass: 'secret',
};

const admin = new PostgreSQLDatabase(adminConfig);

try {
  await admin.executeQuery('CREATE DATABASE appdb');
  console.log('created appdb');
} catch (error) {
  const code = (error as { code?: string }).code;
  if (code !== '42P04') {
    throw error;
  }
  console.log('appdb already exists');
} finally {
  await admin.disconnect();
}
```

---

#### `no pg_hba.conf entry for host "…", no encryption` together with `'ssl' does not exist in type 'PostgreSQLConfig'`

**Error**

```text
error: no pg_hba.conf entry for host "10.0.0.5", user "appuser", database "appdb", no encryption
```

or, at compile time:

```text
error TS2353: Object literal may only specify known properties, and 'ssl' does not exist in type 'PostgreSQLConfig'.
```

**Cause**

The constructor builds the pool from a fixed field list — `database`, `host`, `password`, `port`, `user`, plus the three `poolConfig` knobs. TLS options are never forwarded, and `PostgreSQLConfig` has no `ssl` property, so a server that requires TLS rejects the connection and the obvious workaround (`ssl: {…}` in the config) does not type-check.

**Fix**

Either terminate TLS in front of the adapter (Cloud SQL Auth Proxy, `stunnel`, an internal load balancer) and point the config at the local proxy, or subclass and replace the pool in the constructor. Both keep the rest of the adapter intact.

```typescript
import { Pool } from 'pg';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

class TlsPostgreSQLDatabase extends PostgreSQLDatabase {
  constructor(config: PostgreSQLConfig, caCertificate: string) {
    super(config);
    const { database, host, pass, port, user } = this.config as PostgreSQLConfig;
    // The pool created by super() has no open sockets yet, so discarding it is safe.
    this.pool = new Pool({
      database,
      host,
      password: pass,
      port: port ? Number(port) : undefined,
      user,
      ssl: { ca: caCertificate, rejectUnauthorized: true },
    });
  }
}

const caCertificate = process.env.PG_CA_CERT;
if (caCertificate === undefined) {
  throw new Error('PG_CA_CERT is required');
}

const db = new TlsPostgreSQLDatabase(
  { host: 'db.internal', port: 5432, database: 'appdb', user: 'appuser', pass: 'secret' },
  caCertificate
);

const { rowCount } = await db.executeQuery('SELECT 1');
console.log(`TLS connection established, rowCount=${rowCount}`);
await db.disconnect();
```

The replacement pool does not forward `poolConfig`; add `max`, `idleTimeoutMillis` and `connectionTimeoutMillis` to the `new Pool({...})` call if you rely on them.

---

#### `Connection terminated unexpectedly`

**Error**

```text
Error: Connection terminated unexpectedly
Error: Connection terminated due to connection timeout
```

**Cause**

An idle client that the pool still considers healthy was closed by something in between: a managed proxy idle cutoff, a firewall, a PgBouncer `server_idle_timeout`, or a failover. `poolConfig.idleTimeoutMillis` defaults to 30 000 ms; if the network cutoff is shorter, the pool keeps handing out dead clients and the next query fails on first use.

**Fix**

Set `idleTimeoutMillis` below the network cutoff, and make idempotent work retryable. One retry is usually enough because the retry acquires a fresh client.

```typescript
import { PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'db.internal',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
  poolConfig: { max: 10, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 },
});

async function queryWithRetry<R>(
  sql: string,
  params: Record<string, string | number | boolean | null>
): Promise<PostgreSQLQueryResult<R>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.executeQuery<R>(sql, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('Connection terminated') || attempt >= 2) {
        throw error;
      }
    }
  }
}

const { rowCount } = await queryWithRetry('SELECT :value AS value', { value: 1 });
console.log(`rowCount=${rowCount}`);
await db.disconnect();
```

Only retry statements that are safe to repeat. Wrapping a transaction is safer than wrapping individual statements — see the serialization-failure entry below.

---

### Transaction errors

#### `Cannot start a nested transaction: a transaction is already active on this database handle.`

**Error**

```text
Error: Cannot start a nested transaction: a transaction is already active on this database handle.
```

**Cause**

`withTransaction()` stores its client in an `AsyncLocalStorage<TransactionContext>`. The callback receives `tx`, which is the **same object** as `db` (`fn(this)`), so calling `tx.withTransaction(...)` or `db.withTransaction(...)` from inside the callback hits the existing context. PostgreSQL has no nested `BEGIN`, and the adapter refuses to silently join the outer transaction.

**Fix**

Thread the handle through your helpers instead of opening a second transaction; use an explicit `SAVEPOINT` if you need partial rollback.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface OrderRow {
  id: number;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

await db.withTransaction(async (tx) => {
  const { records } = await tx.executeQuery<OrderRow>(
    'INSERT INTO orders (customer) VALUES (:customer) RETURNING id',
    { customer: 'ada@example.com' }
  );

  const orderId = records[0]?.id;
  if (orderId === undefined) {
    throw new Error('insert returned no id');
  }

  // Same handle, same transaction — no second BEGIN.
  await tx.executeQuery('INSERT INTO order_lines (order_id, sku) VALUES (:orderId, :sku)', {
    orderId,
    sku: 'SKU-1',
  });
});

await db.disconnect();
```

---

#### `Cannot start a transaction from a completed transaction context.` / `Cannot execute a query after the transaction has completed.`

**Error**

```text
Error: Cannot start a transaction from a completed transaction context.
Error: Cannot execute a query after the transaction has completed. Do not use the transaction handle outside its callback.
```

**Cause**

Both messages mean the same thing: a code path that belongs to a finished transaction tried to use it.

- The callback settled, so the adapter set `context.active = false` and `context.client = null` before `COMMIT`.
- A **detached task** created inside the callback (a `setTimeout`, a `queueMicrotask`, an unawaited promise, an event-emitter handler) still inherits the async-local store and therefore still sees the closed context.
- Alternatively you **retained `tx`** past the callback and used it later.

**Fix**

Await everything that belongs to the transaction inside the callback, and return data — never the handle.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  email: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const users = await db.withTransaction(async (tx) => {
  const { records } = await tx.executeQuery<UserRow>(
    'SELECT id, email FROM users ORDER BY id LIMIT 10'
  );
  return records; // data, not the handle
});

// Post-commit work runs on the database handle, outside the callback.
const { rowCount } = await db.executeQuery('SELECT 1');
console.log(`loaded ${users.length} users, probe rowCount=${rowCount}`);
await db.disconnect();
```

The pattern that produces the error, for reference:

```typescript fragment
await db.withTransaction(async (tx) => {
  setTimeout(() => {
    void tx.executeQuery('SELECT 1'); // rejects: the context is closed
  }, 10);
});
```

---

#### `Transaction options must be an object.`

**Error**

```text
Error: Transaction options must be an object.
```

**Cause**

The second argument must be a plain object. `null`, an array, a bare string (`'serializable'` instead of `{ isolation: 'serializable' }`) and anything non-object are rejected — deliberately, *before* a client is acquired, so a bad call never leaks a connection.

**Fix**

Pass an object literal, or omit the argument entirely.

```typescript
import { PostgreSQLDatabase, TransactionOptions } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const options: TransactionOptions = { isolation: 'repeatable read' };

const observed = await db.withTransaction(async (tx) => {
  const { records } = await tx.executeQuery<{ transaction_isolation: string }>(
    'SHOW transaction_isolation'
  );
  return records[0]?.transaction_isolation ?? '';
}, options);

console.log(observed); // repeatable read
await db.disconnect();
```

---

#### `Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".`

**Error**

```text
Error: Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".
```

**Cause**

The value is checked against an allowlist before it is rendered into `BEGIN ISOLATION LEVEL …`, which is what keeps the option from carrying injected SQL. `'SERIALIZABLE'`, `'read uncommitted'`, `'snapshot'` and whitespace-padded strings all fail. Because the check happens before `connect()`, a rejected value costs no connection.

**Fix**

Use the `TransactionIsolation` union, and parse untrusted strings with a switch so the compiler enforces the exhaustiveness.

```typescript
import { PostgreSQLDatabase, TransactionIsolation } from 'blendsdk/postgresql';

function parseIsolation(value: string): TransactionIsolation {
  switch (value) {
    case 'read committed':
    case 'repeatable read':
    case 'serializable':
      return value;
    default:
      throw new Error(`unsupported isolation level: ${value}`);
  }
}

const isolation = parseIsolation(process.env.PG_ISOLATION ?? 'serializable');

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const observed = await db.withTransaction(async (tx) => {
  const { records } = await tx.executeQuery<{ transaction_isolation: string }>(
    'SHOW transaction_isolation'
  );
  return records[0]?.transaction_isolation ?? '';
}, { isolation });

console.log(observed);
await db.disconnect();
```

---

#### `current transaction is aborted, commands ignored until end of transaction block`

**Error**

```text
error: current transaction is aborted, commands ignored until end of transaction block
```

SQLSTATE `25P02`.

**Cause**

A statement inside the transaction failed and the error was **swallowed inside the callback**. PostgreSQL marks the entire transaction aborted; every subsequent statement is rejected with `25P02` until `ROLLBACK`. The adapter only issues `ROLLBACK` when the callback itself rejects, so catching-and-continuing inside the callback turns one failure into an avalanche of confusing errors.

**Fix**

Let errors escape the callback. When a failure is genuinely expected, isolate it in a `SAVEPOINT`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

await db.withTransaction(async (tx) => {
  await tx.executeQuery('INSERT INTO audit_events (message) VALUES (:message)', {
    message: 'start',
  });

  // Expected failure: contain it with a savepoint instead of catching and continuing.
  await tx.executeQuery('SAVEPOINT optional_step');
  try {
    await tx.executeQuery('INSERT INTO users (email) VALUES (:email)', {
      email: 'ada@example.com',
    });
  } catch (error) {
    await tx.executeQuery('ROLLBACK TO SAVEPOINT optional_step');
    console.warn('optional step skipped', error instanceof Error ? error.message : error);
  }
  await tx.executeQuery('RELEASE SAVEPOINT optional_step');
});

await db.disconnect();
```

---

#### `could not serialize access due to concurrent update`

**Error**

```text
error: could not serialize access due to concurrent update
```

SQLSTATE `40001` (`serialization_failure`) or `40P01` (`deadlock_detected`).

**Cause**

You asked for `isolation: 'repeatable read'` or `'serializable'` and a concurrent writer made the snapshot unusable. PostgreSQL aborts one transaction by design. The adapter performs exactly one commit attempt per `withTransaction()` call and does **not** retry.

**Fix**

Retry the whole transaction — never the individual statement, because the snapshot has to be re-taken. Retry only on `40001`/`40P01`, and cap the attempts.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function withSerializableRetry<T>(
  db: PostgreSQLDatabase,
  fn: (tx: PostgreSQLDatabase) => Promise<T>,
  attempts = 3
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.withTransaction(fn, { isolation: 'serializable' });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code === '40001' || code === '40P01') && attempt < attempts) {
        continue;
      }
      throw error;
    }
  }
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const balance = await withSerializableRetry(db, async (tx) => {
  await tx.executeQuery('UPDATE accounts SET balance = balance - :amount WHERE id = :id', {
    amount: 100,
    id: 1,
  });
  const { records } = await tx.executeQuery<{ balance: string }>(
    'SELECT balance FROM accounts WHERE id = :id',
    { id: 1 }
  );
  return records[0]?.balance ?? '0';
});

console.log(balance);
await db.disconnect();
```

The callback must be safe to re-run: no `Date.now()` captured outside, no external side effects before the commit.

---

#### `Error during transaction rollback:` / `Error releasing query client:` in the log

**Symptom**

The application log contains one of the adapter's `console.error` lines even though your `catch` block saw a different error:

```text
Error during transaction rollback: <driver error>
Error releasing transaction client: <driver error>
Error releasing query client: <driver error>
```

**Cause**

These are suppressed cleanup failures, not primary errors:

- `Error during transaction rollback:` — `ROLLBACK` itself failed after the callback threw. The connection state is unknown, so the adapter calls `release(true)` to destroy the client instead of returning it to the pool, then re-throws the original error.
- `Error releasing transaction client:` / `Error releasing query client:` — `release()` threw inside a `finally`; the error is logged and swallowed so it cannot mask the real result.

Seeing them means the *connection* was already damaged when cleanup ran, commonly because `disconnect()` fired mid-transaction (the forced path releases clients out from under running work) or the server closed the socket.

**Fix**

Treat these lines as a pool-health signal, and always diagnose the error your `catch` block received — the logged one is a symptom. Classify by SQLSTATE rather than by message.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface PgErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const email = 'ada@example.com';

try {
  await db.withTransaction(async (tx) => {
    await tx.executeQuery('INSERT INTO users (email) VALUES (:email)', { email });
  });
} catch (error) {
  const pgError = error as PgErrorLike;
  if (pgError.code === '23505') {
    console.warn(`duplicate on ${pgError.constraint ?? 'unknown constraint'}`);
  } else if (pgError.code === undefined) {
    console.error(`not a server error: ${error instanceof Error ? error.message : error}`);
  } else {
    throw error;
  }
}

await db.disconnect();
```

---

### Statement builder errors

#### `Cannot build INSERT statement for table "users": no values provided.`

**Error**

```text
Error: Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.
```

**Cause**

`PostgreSQLInsertStatement.buildQuery()` throws when `Object.keys(this._values).length === 0`. An empty `INSERT INTO users () VALUES ()` is invalid SQL, so the builder refuses to produce it. The usual trigger is a dynamically assembled payload that turned out to be empty — for instance a PATCH handler that passed a filtered object through to `insert()`.

**Fix**

Guard before executing and give the caller a real error instead of a builder error raised three layers deep.

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
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

async function insertUser(patch: Partial<User>): Promise<User> {
  if (Object.keys(patch).length === 0) {
    throw new Error('insertUser requires at least one column');
  }

  const created = await db
    .insert<User>('users')
    .values(patch)
    .returning('*')
    .executeReturnSingle();

  if (created === null) {
    throw new Error('INSERT did not return a row');
  }
  return created;
}

console.log(await insertUser({ name: 'Ada', email: 'ada@example.com' }));
await db.disconnect();
```

---

#### `Cannot build UPDATE statement for table "users": no values provided.`

**Error**

```text
Error: Cannot build UPDATE statement for table "users": no values provided. Call .values() with at least one column before executing.
```

**Cause**

`PostgreSQLUpdateStatement.buildQuery()` validates `_values` exactly like the INSERT builder: an empty `SET` clause is invalid SQL. Note the mirror-image hazard — an UPDATE *with* values but *without* a filter is perfectly valid SQL and rewrites **every row** in the table.

**Fix**

Validate both sides: an empty payload is an error, and so is an empty filter.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

interface UserFilter {
  id?: number;
  email?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

async function updateUser(filter: UserFilter, patch: Partial<User>): Promise<number> {
  if (Object.keys(patch).length === 0) {
    throw new Error('updateUser requires at least one column to set');
  }
  if (Object.keys(filter).length === 0) {
    throw new Error('updateUser refuses to update every row');
  }

  return db
    .update<User, UserFilter>('users')
    .values(patch)
    .filter(filter)
    .executeReturnCount();
}

console.log(await updateUser({ email: 'ada@example.com' }, { name: 'Ada Lovelace' }));
await db.disconnect();
```

---

#### `beforeQuery` sees `v_…` and `p1…` keys instead of column names

**Symptom**

A hook that normalizes `params.email` works for INSERTs and raw queries but silently does nothing on UPDATE. On DELETE, `params.email` is always `undefined` while `params.p1` holds the value.

**Cause**

Each builder hands `beforeQuery` a different key scheme, because that is what the generated SQL references:

| Statement | Keys passed to `beforeQuery` |
| --- | --- |
| `executeQuery()` | Exactly the keys you supplied. |
| INSERT | Column names (`name`, `email`, …) — `buildParameters()` returns `_values` verbatim. |
| UPDATE | SET values as `v_<column>`, WHERE values as `p1`, `p2`, … |
| DELETE | WHERE values only, as `p1`, `p2`, … |

The `v_` prefix is what allows `values({ active: true }).filter({ active: false })` to coexist — the SET value and the filter value must not collide.

**Fix**

Address the prefixed keys, and return every key the SQL references. Dropping a key here produces a placeholder error from the driver later.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email: string;
}

interface UserFilter {
  id?: number;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const updated = await db
  .update<User, UserFilter>('users')
  .values({ email: 'ADA@EXAMPLE.COM' })
  .filter({ id: 1 })
  .beforeQuery((params: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...params };
    // UPDATE SET values are prefixed with v_
    if (typeof next.v_email === 'string') {
      next.v_email = next.v_email.toLowerCase();
    }
    return next;
  })
  .executeReturnCount();

console.log(`normalized ${updated} rows`);
await db.disconnect();
```

---

#### `executeReturnCount()` returns `0` although rows match

**Symptom**

`db.delete<UserFilter>('users').filter({ email: null }).executeReturnCount()` returns `0` on a table full of `NULL` emails. Same for `executeReturnAll()` (empty array) and `execute()` (`rowCount: 0`).

**Cause**

A `null` or `undefined` filter value is bound as a SQL `NULL`, and `column = NULL` is never true in SQL — the three-valued logic makes the comparison `NULL`, so the WHERE clause matches nothing. The statement-builders test asserts exactly this parameter shape (`{ p1: null, p2: null }`).

**Fix**

When you mean "is null", say so with the expression builder.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserFilter {
  email?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const purged = await db
  .delete<UserFilter>('users')
  .filterByExpression((q) => q.where('email').isNull())
  .executeReturnCount();

console.log(`purged ${purged} users without an email`);
await db.disconnect();
```

---

### SQL and driver errors

#### `syntax error at or near ":"`

**Error**

```text
error: syntax error at or near ":"
```

**Cause**

Named placeholders are rewritten by `yesql` inside `executeQuery()`, which is why every statement builder gets them for free. A client obtained from `db.connect()` sends the SQL text to the server **verbatim**, so `:name` is parsed as PostgreSQL syntax and rejected.

**Fix**

Use `executeQuery()` for `:named` placeholders, and `$1…$n` on a raw client. Never mix the two in one statement.

```typescript
import { PoolClient } from 'pg';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const { records } = await db.executeQuery<{ name: string }>('SELECT :name AS name', {
  name: 'Ada',
});
console.log(`named parameter: ${records[0]?.name}`);

const client: PoolClient = await db.connect();
try {
  const { rows } = await client.query<{ name: string }>('SELECT $1::text AS name', ['Ada']);
  console.log(`positional parameter: ${rows[0]?.name}`);
} finally {
  client.release();
}

await db.disconnect();
```

---

#### `there is no parameter $1` / `bind message supplies 0 parameters, but prepared statement "" requires 1`

**Error**

```text
error: there is no parameter $1
error: bind message supplies 0 parameters, but prepared statement "" requires 1
```

**Cause**

The number of placeholders in the final SQL does not match the number of bound values. Three common routes:

- Mixing styles: SQL that contains both `:name` and `$2`. `yesql` only supplies positions for the named placeholders, so the `$2` reference has no value.
- A `$1` in text routed through `executeQuery()` with a named-parameter object.
- A `beforeQuery` hook that **removed** a key the SQL still references.

**Fix**

Pick one placeholder style per statement, and make hooks transform values without deleting keys.

```typescript
import { PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const result: PostgreSQLQueryResult<{ name: string; n: number }> = await db.executeQuery(
  'SELECT :name AS name, :n::int AS n',
  { name: 'Ada', n: 1 }
);
console.log(result.records[0]);

await db.disconnect();
```

The broken shape, for reference:

```typescript fragment
// :name is converted by yesql, $2 is left to the driver — which never receives a second value.
await db.executeQuery('SELECT :name AS name, $2::int AS n', { name: 'Ada', n: 1 });
```

---

#### `cannot insert multiple commands into a prepared statement`

**Error**

```text
error: cannot insert multiple commands into a prepared statement
```

**Cause**

`executeQuery()` always calls `client.query(text, values)` — even when `values` is an empty array. Supplying a values array puts `pg` on the extended-protocol path (parse/bind/execute), and the extended protocol allows exactly one statement per message. A multi-statement script — several `CREATE TABLE`s separated by semicolons, or a `CREATE …; INSERT …;` pair — fails, even with no parameters.

**Fix**

Execute one statement per `executeQuery()` call, or use a raw client with `client.query(sql)` and no values array.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

// One statement per call — extended protocol friendly.
await db.executeQuery('CREATE TEMP TABLE scratch (id serial primary key, name text)');
await db.executeQuery('INSERT INTO scratch (name) VALUES (:name)', { name: 'Ada' });

const client = await db.connect();
try {
  // No values array: the simple protocol accepts a whole script.
  await client.query(`
    CREATE TEMP TABLE batch_a (id serial primary key);
    CREATE TEMP TABLE batch_b (id serial primary key);
  `);
  console.log('script executed on one client');
} finally {
  client.release();
}

await db.disconnect();
```

---

#### `duplicate key value violates unique constraint "users_email_key"`

**Error**

```text
error: duplicate key value violates unique constraint "users_email_key"
```

SQLSTATE `23505`.

**Cause**

A unique index rejected the write. The builder emits plain `INSERT … VALUES …`; it has no upsert support, so `values()` cannot express `ON CONFLICT`.

**Fix**

Match on the SQLSTATE (and `constraint` when one table has several unique indexes), or write the upsert as raw SQL through `executeQuery()`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface InsertedRow {
  id: number;
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const { records } = await db.executeQuery<InsertedRow>(
  `INSERT INTO users (name, email) VALUES (:name, :email)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  { name: 'Ada', email: 'ada@example.com' }
);
console.log(`upserted id=${records[0]?.id}`);

try {
  await db
    .insert<{ name: string; email: string }>('users')
    .values({ name: 'Grace', email: 'ada@example.com' })
    .execute();
} catch (error) {
  const pgError = error as PgErrorLike;
  if (pgError.code !== '23505') {
    throw error;
  }
  console.warn(`duplicate on ${pgError.constraint ?? 'unknown constraint'}`);
}

await db.disconnect();
```

Inside a transaction, this error aborts the whole transaction — see the `25P02` entry above.

---

#### `null value in column "email" of relation "users" violates not-null constraint`

**Error**

```text
error: null value in column "email" of relation "users" violates not-null constraint
```

SQLSTATE `23502`.

**Cause**

A `NOT NULL` column received an explicit `NULL`. Two routes produce it: the key was present in `values()` with a `null`/`undefined` value, or a `beforeQuery` hook replaced the value with `null`. (Omitting the key entirely is different — the column default, if any, applies.)

**Fix**

Validate required fields before building the statement, so the failure surfaces as a domain error instead of a driver error.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserInput {
  name?: string;
  email?: string;
}

interface User {
  id: number;
  name: string;
  email: string;
}

function requireFields(input: UserInput): { name: string; email: string } {
  if (input.name === undefined || input.email === undefined) {
    throw new Error('name and email are required');
  }
  return { name: input.name, email: input.email };
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const values = requireFields({ name: 'Ada', email: 'ada@example.com' });
const created = await db.insert<User>('users').values(values).returning('*').executeReturnSingle();

console.log(created?.id);
await db.disconnect();
```

---

#### `invalid input syntax for type integer: "abc"`

**Error**

```text
error: invalid input syntax for type integer: "abc"
```

SQLSTATE `22P02`.

**Cause**

`yesql` binds values positionally and `pg` sends them as text; PostgreSQL then coerces them to the type inferred from context. A value that cannot be parsed — `''` for an `int` column, a float for an `integer`, a malformed timestamp — fails at bind time. The type of the parameter is decided by the SQL, not by the TypeScript type you declared.

**Fix**

Coerce and validate before binding, and use an explicit cast to make the expected type visible.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const raw = process.env.MAX_ITEMS ?? '10';
const maxItems = Number.parseInt(raw, 10);
if (Number.isNaN(maxItems)) {
  throw new Error(`MAX_ITEMS is not a number: ${raw}`);
}

const { records } = await db.executeQuery<{ n: number }>('SELECT :maxItems::int AS n', {
  maxItems,
});
console.log(records[0]?.n);

await db.disconnect();
```

---

#### `relation "scratch" does not exist` right after `CREATE TEMP TABLE`

**Error**

```text
error: relation "scratch" does not exist
```

**Cause**

Temporary tables live in a **session**. Outside a transaction, every `executeQuery()` acquires its own pooled client and releases it afterwards, so the `CREATE TEMP TABLE` and the following `SELECT` can land on two different sessions. The `CREATE` succeeds, the `SELECT` fails. This is why every integration test in this package creates temp tables inside `withTransaction()`.

**Fix**

Create and use the temp table inside one `withTransaction()` call, or hold a single raw client for the whole sequence.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

await db.withTransaction(async (tx) => {
  // One client, one session for the entire block.
  await tx.executeQuery('CREATE TEMP TABLE scratch (id serial primary key, name text)');
  await tx.executeQuery('INSERT INTO scratch (name) VALUES (:name)', { name: 'Ada' });
  const { rowCount } = await tx.executeQuery('SELECT * FROM scratch');
  console.log(`temp rows: ${rowCount}`);
});

await db.disconnect();
```

---

#### `column "…" must appear in the GROUP BY clause or be used in an aggregate function`

**Error**

```text
error: column "orders.category" must appear in the GROUP BY clause or be used in an aggregate function
```

SQLSTATE `42803`.

**Cause**

`db.from()` / `db.selectAll()` build a `SELECT` list, an optional `WHERE` clause, and nothing else — the assertions in `tests/from.test.ts` show `SELECT … FROM … [WHERE …]` and no other clause. Aggregates mixed with plain columns therefore need a `GROUP BY` the builder will not produce. The same is true for `HAVING`, `ORDER BY` and `LIMIT`.

**Fix**

Express grouped, sorted or paged queries through `executeQuery()`, where you own the full statement.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface CategoryTotal {
  category: string;
  total: string;
  item_count: number;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const { records } = await db.executeQuery<CategoryTotal>(
  `SELECT category,
          SUM(amount)     AS total,
          COUNT(*)::int   AS item_count
     FROM orders
    GROUP BY category
    ORDER BY category
    LIMIT :limit`,
  { limit: 20 }
);

for (const row of records) {
  console.log(`${row.category}: ${row.total} across ${row.item_count} orders`);
}

await db.disconnect();
```

---

#### `total` and `count` come back as strings

**Symptom**

`records[0].price` is `'29.99'` and `records[0].count` is `'2'`, although you declared them as `number` in the generic. Arithmetic on them produces `NaN` or concatenation.

**Cause**

`numeric`/`decimal`, `bigint`/`int8` and `COUNT()` results are returned as strings by `pg` to avoid precision loss. `executeQuery<R>()` **casts** the driver rows to `R` — it does not convert them. The type parameter is a promise the runtime does not keep.

**Fix**

Cast in SQL when the value fits a JS number, or convert in `afterQuery`.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

// 1. Cast on the server: COUNT(*)::int arrives as a number.
const counted = await db.executeQuery<{ total: number }>(
  'SELECT COUNT(*)::int AS total FROM users'
);
console.log(`users: ${counted.records[0]?.total}`);

// 2. Or convert on the client, where the column type is fixed but stringified.
const priced = await db.executeQuery<{ price: number }>(
  'SELECT price FROM products WHERE id = :id',
  { id: 1 },
  {
    afterQuery: (rows) => rows.map((row: { price: string }) => ({ price: Number(row.price) })),
  }
);
console.log(`price: ${priced.records[0]?.price}`);

await db.disconnect();
```

Prefer the server-side cast: it keeps the type honest for every caller and costs nothing.

---

### TypeScript compiler errors

#### TS2307 `Cannot find module 'blendsdk/postgresql' or its corresponding type declarations.`

**Error**

```text
error TS2307: Cannot find module 'blendsdk/postgresql' or its corresponding type declarations.
```

**Cause**

Two distinct causes:

1. The package is not installed. It ships inside the `blendsdk` umbrella — there is no standalone `blendsdk/postgresql` install.
2. `moduleResolution` is `node`/`node10`. The package exposes only an `exports` map with `types` and `import` conditions (no top-level `main` or `types`), which legacy resolution cannot read.

**Fix**

Install the umbrella and switch the consuming project to Node-style ESM resolution.

```bash
npm install blendsdk
```

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);
const { rowCount } = await db.executeQuery('SELECT 1');
console.log(`resolved and connected, rowCount=${rowCount}`);
await db.disconnect();
```

---

#### TS1479 `The current file is a CommonJS module whose imports will produce 'require' calls…`

**Error**

```text
error TS1479: The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module and cannot be imported with 'require'.
```

**Cause**

The package is ESM-only: `"type": "module"` and a single `import` condition in `exports`. A CommonJS consumer cannot `require()` it, and `require is not defined in ES module scope` appears at runtime if you force the issue.

**Fix**

Make the consuming package ESM (`"type": "module"` in `package.json`, `"module": "nodenext"` in `tsconfig.json`). If the CJS project cannot be converted, load the adapter with a dynamic `import()` from an async entry point.

```typescript
async function main(): Promise<void> {
  const { PostgreSQLDatabase } = await import('blendsdk/postgresql');

  const db = new PostgreSQLDatabase({
    host: 'localhost',
    port: 5432,
    database: 'appdb',
    user: 'appuser',
    pass: 'secret',
  });

  const { rowCount } = await db.executeQuery('SELECT 1');
  console.log(`loaded dynamically, rowCount=${rowCount}`);
  await db.disconnect();
}

await main();
```

Never use `require()` against this package, and never import from `dist/` or `src/` paths — only the package root is public.

---

#### TS2322 `Type 'string[]' is not assignable to type '(keyof User)[]'` on `.returning([...])`

**Error**

```text
error TS2322: Type 'string[]' is not assignable to type '(keyof User)[]'.
  Type 'string' is not assignable to type 'keyof User'.
```

**Cause**

`returning()` accepts `'*'` or `(keyof T)[]`. An inline array literal widens to `string[]`, which is not assignable to the keyed array. The test suite works around it with `as (keyof UserFilter)[]` casts; application code should not need them.

**Fix**

Declare the column list once with the keyed type, or use `returning('*')` and let the generic carry the row shape.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  created_at?: Date;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const userColumns: (keyof User)[] = ['id', 'name', 'email'];

const created = await db
  .insert<User>('users')
  .values({ name: 'Ada', email: 'ada@example.com' })
  .returning(userColumns)
  .executeReturnSingle();

console.log(created);
await db.disconnect();
```

---

#### TS18047 `'created' is possibly 'null'` after `executeReturnSingle()`

**Error**

```text
error TS18047: 'created' is possibly 'null'.
```

**Cause**

The terminators are honest about empty results: `executeReturnSingle()` returns `T | null` (no row matched, or no `RETURNING` clause), `execute()` returns `PostgreSQLQueryResult<T> | null`, `executeReturnAll()` returns `T[]`. Strict mode forces you to narrow before touching a property.

**Fix**

Narrow explicitly and convert the `null` into a domain error with context.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

interface UserFilter {
  email?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const updated = await db
  .update<User, UserFilter>('users')
  .values({ name: 'Ada Lovelace' })
  .filter({ email: 'ada@example.com' })
  .returning('*')
  .executeReturnSingle();

if (updated === null) {
  throw new Error('no user matched ada@example.com');
}
console.log(`updated user ${updated.id}`);

const all = await db
  .update<User, UserFilter>('users')
  .values({ name: 'Ada Lovelace' })
  .filter({ email: 'ada@example.com' })
  .returning('*')
  .executeReturnAll();
console.log(`rows touched: ${all.length}`);

await db.disconnect();
```

---

#### TS7006 `Parameter 'params' implicitly has an 'any' type.`

**Error**

```text
error TS7006: Parameter 'params' implicitly has an 'any' type.
```

**Cause**

Hooks written inline at the call site are contextually typed, so they need no annotation. A hook extracted into a standalone function loses that context, and `noImplicitAny` rejects it.

**Fix**

Annotate with `Record<string, unknown>` — it is assignable to the hook signature and forces you to narrow before mutating values.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

const normalizeEmail = (params: Record<string, unknown>): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...params };
  if (typeof next.email === 'string') {
    next.email = next.email.toLowerCase();
  }
  return next;
};

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const created = await db
  .insert<User>('users')
  .values({ name: 'Ada', email: 'ADA@EXAMPLE.COM' })
  .beforeQuery(normalizeEmail)
  .returning('*')
  .executeReturnSingle();

console.log(created?.email);
await db.disconnect();
```

---

#### TS18048 `'records[0]' is possibly 'undefined'`

**Error**

```text
error TS18048: 'records[0]' is possibly 'undefined'.
```

**Cause**

With `noUncheckedIndexedAccess`, index access on `T[]` yields `T | undefined` — correct, because a query that matched nothing returns `records: []`. The `PostgreSQLQueryResult.fields` array is likewise `[]` whenever `rowCount === 0`.

**Fix**

Guard the first element (or use optional chaining) and treat "no rows" as a case the code handles, not an impossibility.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  email: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const { records, rowCount } = await db.executeQuery<UserRow>(
  'SELECT id, email FROM users ORDER BY id LIMIT 1'
);

const first = records[0];
if (first === undefined) {
  console.log(`no rows (rowCount=${rowCount})`);
} else {
  console.log(`first user id=${first.id} email=${first.email}`);
}

await db.disconnect();
```

---

## Debugging Strategies

### 1. Reproduce the SQL without a database

The statement builders are pure SQL producers. `pnpm run test:fast` runs `tests/statement-builders.test.ts`, which builds every statement shape with a mock config and never opens a socket. When a statement misbehaves, reduce it to the builder call alone and inspect the expected `buildQuery()` / `buildParameters()` output asserted in that suite — the generated SQL for each shape is spelled out there (`INSERT INTO users (name) VALUES (:name)`, `UPDATE users SET name = :v_name`, `DELETE FROM users WHERE id = :p1`, …).

### 2. Log every statement at the adapter boundary

Subclass `PostgreSQLDatabase` and override `executeQuery()`. Everything the builders produce funnels through this one method, so one override covers raw SQL, INSERT, UPDATE and DELETE.

```typescript
import { ExecuteQueryOptions } from 'blendsdk/dbcore';
import { PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

class LoggingDatabase extends PostgreSQLDatabase {
  override async executeQuery<R>(
    query: string,
    params?: Record<string, unknown>,
    options?: ExecuteQueryOptions
  ): Promise<PostgreSQLQueryResult<R>> {
    console.log('[sql]', query.trim().replace(/\s+/gu, ' '), params ?? {});
    return super.executeQuery<R>(query, params, options);
  }
}

const db = new LoggingDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const { rowCount } = await db.executeQuery('SELECT :value AS value', { value: 1 });
console.log(`rowCount=${rowCount}`);
await db.disconnect();
```

The logged text still contains `:named` placeholders — that is the form *before* `yesql` conversion. For the exact text the server received, use procedure 3.

### 3. Read the statement from the PostgreSQL server log

1. Turn on statement logging on the server.
2. Reproduce the failing operation once.
3. Read the log, then turn logging back off.

```sql
ALTER SYSTEM SET log_statement = 'all';
SELECT pg_reload_conf();
-- reproduce the failing operation here, then:
ALTER SYSTEM RESET log_statement;
SELECT pg_reload_conf();
```

Find the file first:

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const { records } = await db.executeQuery<{ name: string; setting: string }>(
  `SELECT name, setting FROM pg_settings
    WHERE name IN ('log_directory', 'log_filename', 'log_destination')`
);

for (const row of records) {
  console.log(`${row.name} = ${row.setting}`);
}

await db.disconnect();
```

The server log shows the final `$1…$n` text and, with `log_parameter_max_length_on_error` set, the bound values. This is the only way to see exactly what the driver sent after hook transformation and placeholder conversion.

### 4. Prove which connection a statement ran on

`AsyncLocalStorage` scopes transactions to an async call chain. When you suspect a statement escaped its transaction, print the backend PID — inside one transaction it must be stable, and two concurrent transactions must differ.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

const pids = await Promise.all([
  db.withTransaction(async (tx) => {
    const { records } = await tx.executeQuery<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await tx.executeQuery('SELECT pg_sleep(0.1)');
    const after = await tx.executeQuery<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    console.log(`stable inside transaction: ${records[0]?.pid === after.records[0]?.pid}`);
    return records[0]?.pid;
  }),
  db.withTransaction(async (tx) => {
    const { records } = await tx.executeQuery<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return records[0]?.pid;
  }),
]);

console.log(`pids: ${pids.join(', ')}`);
await db.disconnect();
```

Different PIDs for the two transactions confirm isolation; a PID that changes mid-transaction means a query left the context (see the detached-task entries).

### 5. Watch the pool, not the query

When latency rises, check pool counters before reading SQL. `waitingCount > 0` with `idleCount === 0` is a leak, not a slow query.

1. Subclass and expose `totalCount`, `idleCount`, `waitingCount` (see the exhaustion entry above).
2. Print the snapshot at the start and end of the suspicious code path.
3. If `total` grows and never shrinks, find the `db.connect()` that is missing a `release()`.
4. If `total` sits at `max` and `waiting` grows, find the transaction callback that awaits untrusted I/O.

### 6. Classify the error by SQLSTATE, then act

Never branch on `error.message` — it is server-localized. Branch on `code`, which is stable.

| `error.code` | Meaning | Action |
| --- | --- | --- |
| `23505` | `unique_violation` | Return a conflict response, or rewrite as `ON CONFLICT`. |
| `23502` | `not_null_violation` | Validate the payload before building. |
| `23503` | `foreign_key_violation` | Create the parent row first, or batch inserts in one transaction. |
| `42P01` | `undefined_table` | Check schema/search path, and whether a temp table was created on another pooled session. |
| `42703` | `undefined_column` | Check the column list — aliases from `select({ alias: 'column' })` rename the *output*, not the source. |
| `42803` | `grouping_error` | Add `GROUP BY` by hand or use `executeQuery()`. |
| `22P02` | `invalid_text_representation` | Coerce the value before binding. |
| `25P02` | `in_failed_sql_transaction` | Stop swallowing errors inside `withTransaction()`. |
| `40001` / `40P01` | `serialization_failure` / `deadlock_detected` | Retry the whole transaction with backoff. |
| `57014` | `query_canceled` | A `statement_timeout` fired; raise it or split the query. |
| `53300` | `too_many_connections` | Lower `poolConfig.max`, or add a pooler in front. |

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface PgErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
}

const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'appuser',
  pass: 'secret',
});

try {
  await db.executeQuery('INSERT INTO users (email) VALUES (:email)', {
    email: 'ada@example.com',
  });
} catch (error) {
  const pgError = error as PgErrorLike;
  console.error(`sqlstate=${pgError.code ?? 'none'} constraint=${pgError.constraint ?? 'none'}`);
  console.error(pgError.detail ?? (error instanceof Error ? error.message : String(error)));
  throw error;
} finally {
  await db.disconnect();
}
```

### 7. Bisect adapter vs. server

If a statement fails, run it once outside Node — `psql`, or any SQL client — with literal values substituted for the placeholders.

- **Fails there too:** the problem is the SQL, the schema or the data; the adapter is not involved.
- **Succeeds there, fails through the adapter:** the problem is in the parameter shape, a hook, the transaction context or the pool. Go to procedure 2 and log the exact parameters.

---

## Known Pitfalls

### Zero-row results short-circuit everything

`executeOnClient()` returns `{ records: [], rowCount: 0, fields: [] }` as soon as `res.rowCount === 0`. Two consequences that bite:

- **`afterQuery` never runs** for an empty result set — you cannot rely on it to add computed fields or to prove the mapping works.
- **`fields` is empty**, so `result.fields.length` says nothing about the query's column count. Infer columns from a run that returns at least one row.

### A missing filter is a full-table write

`filter({})`, `filter()` never being called, and a filter object whose keys were all stripped produce the identical SQL: `DELETE FROM users` / `UPDATE users SET …` with **no WHERE clause**. The test suite calls this "bulk delete" and asserts it removes every row. If a statement must be scoped, enforce it in your own wrapper and refuse an empty filter object.

### `null` and `undefined` filter values match nothing

A filter value of `null`/`undefined` is bound as SQL `NULL`, and `column = NULL` is never true. Use `filterByExpression((q) => q.where('col').isNull())` when you mean `IS NULL`.

### `undefined` insert values become NULL, not DEFAULT

The INSERT column list is `Object.keys(this._values)`, so a key present with an `undefined` value is still part of the statement — the driver serializes it as `NULL`, and the column default never applies. Omit the key.

```typescript fragment
// active receives NULL; the column's DEFAULT true is bypassed
await db.insert<User>('users').values({ name: 'Ada', email: 'ada@example.com', active: undefined }).execute();

// active is omitted from the column list, so DEFAULT true applies
await db.insert<User>('users').values({ name: 'Ada', email: 'ada@example.com' }).execute();
```

### `beforeQuery` must return every key the SQL references

The hook runs before `yesql` converts the object into positional values. Deleting a key the SQL still mentions leaves a placeholder without a value, which surfaces later as `there is no parameter $N`. Transform values in place; do not filter the object.

### `tx` is `db` — and the handle dies with the callback

`withTransaction(fn)` calls `fn(this)`, so `tx === db`. That means nested `withTransaction()` calls fail fast, and any handle you keep past the callback is a reference to a client that is already back in the pool. Return data from the callback, never the handle.

### Async-local state leaks into detached tasks

`setTimeout`, `queueMicrotask`, unawaited promises and event handlers registered inside the callback inherit the transaction's async-local store. They will see the *closed* context and reject with `Cannot execute a query after the transaction has completed.` Await everything inside the callback; schedule follow-up work after `withTransaction()` resolves.

### Queries inside a transaction are serialized, not parallel

Every statement in a callback runs on the same client, so `Promise.all` of five queries inside one transaction still executes them one after another. Parallelism requires either concurrent `withTransaction()` calls (different clients) or plain `executeQuery()` calls outside the transaction.

### `connect()` bypasses everything

A raw `PoolClient` gives you the driver as-is: no `yesql` (`:name` becomes a syntax error), no `beforeQuery`/`afterQuery`, no `PostgreSQLQueryResult` normalization, no automatic release. Use it only for driver-level features, and always release it in a `finally`.

### `disconnect()` is terminal and its timeout is destructive

`disconnect(timeoutMs = 10000)` sets the shutdown flag immediately, then races `pool.end()` against a timer. When the timer wins, `forceDisconnect()` iterates the pool's client list, calls `release(true)` on every client — **destroying in-flight transactions** — and clears the list. Size the timeout above your slowest transaction, and never call `disconnect()` from inside a `withTransaction()` callback.

The forced path also relies on a private `pg-pool` field (`_clients`); if a future `pg` release renames it, forced shutdown silently becomes a no-op. Keep the normal drain path healthy rather than depending on the fallback.

### `enableGracefulShutdown` does two dangerous things

It installs SIGINT/SIGTERM handlers that call `process.exit(0)` after `disconnect()`, and it installs them **per instance** with no removal API. Do not enable it:

- alongside a `WebApplication` from `blendsdk/webafx`, which owns the signal lifecycle — the doc comment on the option warns about exactly this conflict;
- in a process with several database instances, or you will accumulate listeners;
- when in-flight requests must finish, because `process.exit()` truncates them.

### `rowCount` is `0` for DDL, and `execute()` is nullable

`pg` reports `rowCount: null` for statements like `CREATE TABLE`; the adapter normalizes that to `0`. A successful DDL statement and a no-op DML statement are indistinguishable by `rowCount` — check for a thrown error instead. And because the terminator types are nullable (`execute()` → `… | null`, `executeReturnSingle()` → `T | null`), strict mode forces a narrowing that reflects reality: "no row" is a normal outcome.

### Strings where you expected numbers

`numeric`/`decimal`, `bigint`/`int8` and `COUNT()` arrive as strings; `date`/`timestamp` arrive as `Date`. `PostgreSQLQueryResult<R>` casts, it does not convert. Declare the generic to match what the driver returns (`string`), or cast in SQL (`::int`, `::float8`) so the generic is truthful.

### `timestamp` without time zone uses the client's zone

A `timestamp` (without time zone) column is interpreted in the Node process's local time zone when converted to a `Date`; a `date` column comes back as a `Date` at local midnight. Store instants in `timestamptz` if you compare them across time zones, and compare dates as dates.

### Temporary objects are per session

`CREATE TEMP TABLE` (and any `SET`, prepared statement, or advisory lock) applies to one pooled connection. Outside a transaction, consecutive `executeQuery()` calls may use different connections. Do anything session-scoped inside a single `withTransaction()` or on a single raw client.

### Placeholders are parsed textually — avoid stray colons

If you get an unexpected parameter error, look for colons that are not parameters: a time literal such as `'12:30:00'`, a `-- note: something` comment, or a JSON fragment embedded in SQL text. Pass such values as bound parameters instead of embedding them.

### Report only what you can prove

The package ships no runtime version marker and no debug switch. When filing an issue, include the exact message, the SQLSTATE, the statement shape (builder call plus parameters, with secrets redacted), the isolation level, and whether a transaction was involved — those five facts separate an adapter bug from a schema, data or configuration problem.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
