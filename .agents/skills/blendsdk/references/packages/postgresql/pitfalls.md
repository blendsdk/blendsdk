> **Package**: `blendsdk/postgresql`

# postgresql Best Practices

These best practices are distilled from the package's implementation details, its shutdown and transaction guards, and the behaviors verified by its test suite. Every **Do / Don't** pair shows the problematic pattern first (❌) and the recommended pattern immediately after (✅), with an explanation of the failure mode so you can recognize the same trap in your own code. The sections that follow cover broader anti-patterns, pool and query performance, and the security boundary of the package.

---

## Do / Don't Pairs

### 1. Drain the pool with `disconnect()` in a `finally` block

Every `PostgreSQLDatabase` instance owns its own `pg.Pool`. If `disconnect()` is never called, the pool's clients keep sockets and timers alive, so the process may linger instead of exiting cleanly — and a query error skips cleanup entirely if the call is not in a `finally` path. `disconnect()` also flips the internal `isShuttingDown` guard, so teardown is deterministic.

**❌ Wrong**

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function loadUserNames(): Promise<string[]> {
  const db = new PostgreSQLDatabase(config);
  const { records } = await db.executeQuery<{ name: string }>('SELECT name FROM users');
  // ❌ No disconnect(): the pool is never drained, idle clients keep the
  // process alive, and a thrown query error would skip cleanup anyway.
  return records.map(record => record.name);
}
```

**✅ Correct**

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function loadUserNames(): Promise<string[]> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records } = await db.executeQuery<{ name: string }>('SELECT name FROM users');
    return records.map(record => record.name);
  } finally {
    // ✅ Runs on success and on failure. Default timeout is 10000 ms,
    // after which stuck clients are force-released instead of hanging.
    await db.disconnect();
  }
}
```

**Note:** In a long-lived service, call `disconnect()` exactly once during application shutdown — not after every query. Reuse the instance (and its pool) for the whole process lifetime.

---

### 2. Bind every value as a named parameter — never concatenate SQL

`executeQuery()` translates `:name` placeholders through `yesql` into positional parameters (`$1`, `$2`, …) that the `pg` driver binds out-of-band. The value can therefore never change the statement's structure. String concatenation re-opens SQL injection and also breaks quoting for apostrophes, dates, and multi-byte text.

**❌ Wrong**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function findUserByEmail(db: PostgreSQLDatabase, email: string): Promise<void> {
  // ❌ The value is spliced into the SQL text. A value like
  // "'; DROP TABLE users; --" is executed as SQL, and legitimate values
  // containing apostrophes corrupt the statement.
  const { records } = await db.executeQuery<{ id: number; name: string }>(
    `SELECT id, name FROM users WHERE email = '${email}'`
  );
  console.log(records);
}
```

**✅ Correct**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function findUserByEmail(db: PostgreSQLDatabase, email: string): Promise<void> {
  // ✅ yesql converts :email into a positional parameter that PostgreSQL
  // treats strictly as a data value — never as SQL.
  const { records } = await db.executeQuery<{ id: number; name: string }>(
    'SELECT id, name FROM users WHERE email = :email',
    { email }
  );
  console.log(records);
}
```

**Note:** The statement builders (`insert()`, `update()`, `delete()`) generate named parameters automatically — you get the same guarantee as long as you never build the SQL string yourself.

---

### 3. Scope every `UPDATE` and `DELETE` with a filter

A `PostgreSQLUpdateStatement` without a filter renders `UPDATE table SET …` with **no `WHERE` clause**, and a `PostgreSQLDeleteStatement` with no filter (or an empty `{}` filter, which is treated as "no filter") renders `DELETE FROM table`. Both silently touch every row in the table. The builders do not stop you because bulk operations are legitimate — you must be explicit about which one you intend.

**❌ Wrong**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email: string;
  active?: boolean;
}

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}

async function deactivateAndPurge(db: PostgreSQLDatabase, email: string): Promise<void> {
  // ❌ Intention: deactivate one user. Reality: no .filter() means
  // `UPDATE users SET active = :v_active` — every row is deactivated.
  const deactivated = await db
    .update<User, UserFilter>('users')
    .values({ active: false })
    .executeReturnCount();

  // ❌ `.filter({})` is an empty filter, so this renders `DELETE FROM users`
  // with no WHERE clause and removes every row.
  const purged = await db.delete<UserFilter>('users').filter({}).executeReturnCount();

  console.log(`${email}: deactivated ${deactivated}, purged ${purged}`);
}
```

**✅ Correct**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email: string;
  active?: boolean;
}

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}

async function deactivateAndPurge(db: PostgreSQLDatabase, email: string): Promise<void> {
  // ✅ Scope the UPDATE to the user you actually mean…
  const deactivated = await db
    .update<User, UserFilter>('users')
    .values({ active: false })
    .filter({ email })
    .executeReturnCount();

  // ✅ …and only delete rows that explicitly match the purge criteria.
  const purged = await db
    .delete<UserFilter>('users')
    .filter({ active: false })
    .executeReturnCount();

  // The affected-row counts let you verify the intent was fulfilled.
  console.log(`${email}: deactivated ${deactivated}, purged ${purged}`);
}
```

If a whole-table operation is genuinely intended, make it deliberate and visible in review (an explicit raw `TRUNCATE` via `executeQuery`, or a comment plus a pre-count) instead of relying on a missing filter.

---

### 4. Group multi-statement writes in a single `withTransaction()`

`withTransaction()` pins one pooled client, issues `BEGIN`/`COMMIT`/`ROLLBACK` around your callback, and always releases the client. Two standalone `executeQuery()` calls run on two different pooled clients with no shared atomicity — a failure between them leaves partial writes behind.

**❌ Wrong**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function transfer(
  db: PostgreSQLDatabase,
  fromAccountId: number,
  toAccountId: number,
  amount: number
): Promise<void> {
  // ❌ Two independent atomic operations. If the second query fails (or the
  // process dies between them), money is debited but never credited —
  // there is no way to roll the first statement back.
  await db.executeQuery(
    'UPDATE accounts SET balance = balance - :amount WHERE id = :accountId',
    { amount, accountId: fromAccountId }
  );
  await db.executeQuery(
    'UPDATE accounts SET balance = balance + :amount WHERE id = :accountId',
    { amount, accountId: toAccountId }
  );
}
```

**✅ Correct**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface AccountRow {
  id: number;
  balance: string;
}

async function transfer(
  db: PostgreSQLDatabase,
  fromAccountId: number,
  toAccountId: number,
  amount: number
): Promise<void> {
  // ✅ One pinned client, one BEGIN … COMMIT around both statements.
  // A throw triggers ROLLBACK and the original error propagates to the caller.
  await db.withTransaction(async transactionDb => {
    const debit = await transactionDb.executeQuery<AccountRow>(
      `UPDATE accounts
          SET balance = balance - :amount
        WHERE id = :accountId AND balance >= :amount
        RETURNING id, balance`,
      { amount, accountId: fromAccountId }
    );

    if (debit.rowCount === 0) {
      throw new Error(`Insufficient funds on account ${fromAccountId}`);
    }

    await transactionDb.executeQuery(
      'UPDATE accounts SET balance = balance + :amount WHERE id = :accountId',
      { amount, accountId: toAccountId }
    );
  });
}
```

---

### 5. Let errors propagate inside transaction callbacks

`withTransaction()` only rolls back when the callback rejects. A `try/catch` that swallows an error inside the callback makes the transaction look successful, so `COMMIT` runs and later statements are written on top of failed work. If a step may legitimately fail, check its result (`rowCount`) and decide — but if the transaction should not proceed, throw.

**❌ Wrong**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function placeOrder(db: PostgreSQLDatabase, sku: string, quantity: number): Promise<void> {
  await db.withTransaction(async transactionDb => {
    try {
      await transactionDb.executeQuery(
        'UPDATE inventory SET quantity = quantity - :quantity WHERE sku = :sku',
        { quantity, sku }
      );
    } catch (error) {
      // ❌ The error is swallowed, so withTransaction sees a successful
      // callback and COMMITs: the order row below is written even though
      // stock was never decremented.
      console.error('Inventory update failed', error);
    }

    await transactionDb.insert('orders').values({ sku, quantity }).execute();
  });
}
```

**✅ Correct**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function placeOrder(db: PostgreSQLDatabase, sku: string, quantity: number): Promise<void> {
  await db.withTransaction(async transactionDb => {
    const decremented = await transactionDb.executeQuery(
      `UPDATE inventory
          SET quantity = quantity - :quantity
        WHERE sku = :sku AND quantity >= :quantity`,
      { quantity, sku }
    );

    if (decremented.rowCount === 0) {
      // ✅ Throwing is the rollback signal — withTransaction issues ROLLBACK
      // and rethrows this error to the caller.
      throw new Error(`Not enough stock for SKU ${sku}`);
    }

    await transactionDb.insert('orders').values({ sku, quantity }).execute();
  });
}
```

---

### 6. Use `RETURNING` instead of a follow-up `SELECT`

Without `.returning()`, the builders emit no `RETURNING` clause, so `executeReturnSingle()`/`executeReturnAll()` have no row data to yield. Running a second `SELECT` to fetch what you just wrote costs an extra round trip and opens a race window — another transaction can modify the row between the write and the read.

**❌ Wrong**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

async function createUser(db: PostgreSQLDatabase, name: string, email: string): Promise<void> {
  // ❌ Two round trips with a race window in between: between the INSERT and
  // the SELECT another transaction can rename, update or delete the row,
  // so you may not read back what you wrote.
  await db.insert<User>('users').values({ name, email }).execute();

  const { records } = await db.executeQuery<User>(
    'SELECT id, name, email FROM users WHERE email = :email',
    { email }
  );

  console.log(`Created user #${records[0].id}`);
}
```

**✅ Correct**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

async function createUser(db: PostgreSQLDatabase, name: string, email: string): Promise<void> {
  // ✅ RETURNING hands back exactly the row you wrote, inside the same
  // statement — one round trip, no race window.
  const created = await db
    .insert<User>('users')
    .values({ name, email })
    .returning(['id', 'name', 'email'])
    .executeReturnSingle();

  if (created !== null) {
    console.log(`Created user #${created.id}`);
  }
}
```

---

### 7. Handle `null` and empty results with control flow

Empty results are not errors. `executeReturnSingle()` resolves to `null` when no row matched, `executeReturnAll()` resolves to `[]`, and `executeQuery()` resolves to `{ records: [], rowCount: 0, fields: [] }` — including an explicitly empty `fields` array. Code that assumes at least one row crashes exactly where the business logic should branch.

**❌ Wrong**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email: string;
  active?: boolean;
}

interface UserFilter {
  email?: string;
}

async function deactivateUser(db: PostgreSQLDatabase, email: string): Promise<void> {
  const updated = await db
    .update<User, UserFilter>('users')
    .values({ active: false })
    .filter({ email })
    .returning('*')
    .executeReturnSingle();

  // ❌ The non-null assertion silences the compiler, but when the filter
  // matches nothing this throws "TypeError: Cannot read properties of null".
  console.log(`Deactivated user #${updated!.id}`);
}
```

**✅ Correct**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email: string;
  active?: boolean;
}

interface UserFilter {
  email?: string;
}

async function deactivateUser(db: PostgreSQLDatabase, email: string): Promise<void> {
  const updated = await db
    .update<User, UserFilter>('users')
    .values({ active: false })
    .filter({ email })
    .returning('*')
    .executeReturnSingle();

  // ✅ A missing match is an expected outcome, handled with control flow.
  if (updated === null) {
    console.log(`No user matched ${email}; nothing was updated.`);
    return;
  }

  console.log(`Deactivated user #${updated.id}`);
}
```

Pick the terminal method that matches what you expect back:

| Method | Resolves to | Use when |
| --- | --- | --- |
| `.execute()` | `QueryResult<T>` (`records`, `rowCount`, `fields`) | You need the raw result, counts or column metadata |
| `.executeReturnSingle()` | `T \| null` | At most one row is expected (unique key, single update target) |
| `.executeReturnAll()` | `T[]` | Multiple rows may come back (bulk operations with `RETURNING`) |
| `.executeReturnCount()` | `number` | You only need the affected-row count; no `RETURNING` required |

---

### 8. Type results to match PostgreSQL's actual wire format

The `R` in `executeQuery<R>()` is a promise you make to the compiler — it is not validated at runtime. PostgreSQL returns `NUMERIC`/`DECIMAL`, `BIGINT`, and `COUNT(*)` values as **strings** (the drivers avoid silent precision loss). An interface that claims `number` compiles fine and then fails at runtime.

**❌ Wrong**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Product {
  id: number;
  name: string;
  price: number;
  stock: number;
}

async function printPrice(db: PostgreSQLDatabase, productId: number): Promise<void> {
  const { records } = await db.executeQuery<Product>(
    'SELECT id, name, price, stock FROM products WHERE id = :productId',
    { productId }
  );

  // ❌ The interface lies: pg returns NUMERIC as a string, so `price` is
  // actually "49.99" at runtime and this throws
  // "TypeError: price.toFixed is not a function".
  console.log(records[0].price.toFixed(2));
}
```

**✅ Correct**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Product {
  id: number;
  name: string;
  price: number; // price::float8 makes the driver return a JS number
  stock: number;
}

async function printPrice(db: PostgreSQLDatabase, productId: number): Promise<void> {
  // ✅ Make the SQL produce the type your interface claims.
  const { records } = await db.executeQuery<Product>(
    'SELECT id, name, price::float8 AS price, stock FROM products WHERE id = :productId',
    { productId }
  );

  console.log(records[0].price.toFixed(2));
}
```

**Note:** The alternative fix is to keep `price: string` in the interface and convert with `Number(records[0].price)` at the boundary — both are correct; just never let the interface and the wire format disagree. The same rule applies to `COUNT(*)` results (string — use `parseInt`).

---

### 9. Know the parameter names your hooks receive

`beforeQuery` sees the final parameter object, and its keys are builder-specific: INSERT parameters are keyed by column name, UPDATE `SET` values are prefixed with `v_`, and `WHERE`-clause parameters are named `p1`, `p2`, …. A hook that checks the wrong key silently does nothing — the data is written unchanged and no error is raised.

**❌ Wrong**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email: string;
  name?: string;
}

interface UserFilter {
  id?: number;
}

async function normalizeEmail(db: PostgreSQLDatabase, user: User): Promise<void> {
  await db
    .update<User, UserFilter>('users')
    .values({ email: user.email.toUpperCase() })
    .filter({ id: user.id })
    .beforeQuery((params: Record<string, unknown>) => {
      // ❌ UPDATE SET values arrive as `v_<column>` — `params.email` is always
      // undefined here, so the hook silently does nothing and the uppercase
      // email is written to the database anyway.
      const email = params.email;
      if (typeof email === 'string') {
        params.email = email.toLowerCase();
      }
      return params;
    })
    .execute();
}
```

**✅ Correct**

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email: string;
  name?: string;
}

interface UserFilter {
  id?: number;
}

async function normalizeEmail(db: PostgreSQLDatabase, user: User): Promise<void> {
  await db
    .update<User, UserFilter>('users')
    .values({ email: user.email.toUpperCase() })
    .filter({ id: user.id })
    .beforeQuery((params: Record<string, unknown>) => {
      // ✅ SET values carry the v_ prefix: `params.v_email`.
      const email = params.v_email;
      if (typeof email === 'string') {
        params.v_email = email.toLowerCase();
      }
      return params;
    })
    .execute();
}
```

Reference for `beforeQuery` keys:

| Statement | Parameter names | Example |
| --- | --- | --- |
| INSERT | One key per column | `params.email`, `params.name` |
| UPDATE (`SET` clause) | One `v_`-prefixed key per column | `params.v_email`, `params.v_name` |
| UPDATE / DELETE (`WHERE` clause) | `p1`, `p2`, … in filter key order | `params.p1`, `params.p2` |

Because `WHERE` indices (`p1`, `p2`, …) depend on filter key order, keep such hooks defensive (`typeof` checks) or normalize values in application code before building the statement.

---

### 10. Enable `enableGracefulShutdown` only where nothing else owns the signals

When `enableGracefulShutdown` is `true`, the constructor registers `SIGINT`/`SIGTERM` handlers that call `disconnect()` and then `process.exit()`. If a `blendsdk/webafx` WebApplication manages the database, it provides its own shutdown handling for the same signals — enabling both creates competing signal handlers, racing shutdown sequences, and an `exit(0)` that can truncate the framework's cleanup.

**❌ Wrong**

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

// ❌ Inside a blendsdk/webafx WebApplication: the framework already owns
// SIGINT/SIGTERM. With this flag, two shutdown sequences race and the
// adapter's process.exit() may cut the framework's own cleanup short.
const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
  enableGracefulShutdown: true,
};

const db = new PostgreSQLDatabase(config);
console.log(`Pool ready for ${db.config.database}`);
```

**✅ Correct**

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

// ✅ When the WebApplication manages the database lifecycle, keep the flag
// at its default (false): there is exactly one shutdown owner, and the
// framework closes the pool as part of its shutdown sequence.
const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

const db = new PostgreSQLDatabase(config);
console.log(`Pool ready for ${db.config.database}`);
```

For **standalone** scripts and services that are not managed by the web framework, `enableGracefulShutdown: true` is the right choice — it guarantees the pool is drained when the process receives `SIGINT` or `SIGTERM`.

---

## Anti-Patterns

### 1. A new `PostgreSQLDatabase` per request

Each instance creates its own `pg.Pool` with up to `poolConfig.max` clients (default 10). Under load, per-request instances multiply potential connections far beyond what the server allows, and every new pool pays TCP + authentication handshake costs per client for nothing.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

interface UserRow {
  id: number;
  name: string;
}

// ❌ A brand-new pool per call: connection build-up cost on every request and
// up to 10 potential server connections per concurrent request.
async function handleListUsers(): Promise<UserRow[]> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records } = await db.executeQuery<UserRow>('SELECT id, name FROM users');
    return records;
  } finally {
    await db.disconnect();
  }
}

// ✅ One pool for the whole process; concurrent calls are multiplexed over
// its clients. Create it once, share it, disconnect once at shutdown.
const sharedDb = new PostgreSQLDatabase(config);

async function handleListUsersShared(): Promise<UserRow[]> {
  const { records } = await sharedDb.executeQuery<UserRow>('SELECT id, name FROM users');
  return records;
}
```

### 2. Nested `withTransaction()` calls

`withTransaction()` is not re-entrant. An inner call finds the pinned `transactionClient`, re-issues `BEGIN`/`COMMIT` on the same client and then releases it — destroying the outer transaction. Statements after the inner block run outside any transaction, and the outer rollback guarantee is silently gone.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function transfer(
  db: PostgreSQLDatabase,
  fromAccountId: number,
  toAccountId: number,
  amount: number
): Promise<void> {
  await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(
      'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
      { amount, id: fromAccountId }
    );

    // ❌ The inner withTransaction visits BEGIN/COMMIT on the same pinned
    // client and releases it — the outer transaction ends here.
    await transactionDb.withTransaction(async innerDb => {
      await innerDb.executeQuery(
        'UPDATE accounts SET balance = balance + :amount WHERE id = :id',
        { amount, id: toAccountId }
      );
    });
  });
}
```

**Instead:** one `withTransaction()` call, flat statements through the callback's instance:

```typescript
await db.withTransaction(async transactionDb => {
  await transactionDb.executeQuery(
    'UPDATE accounts SET balance = balance - :amount WHERE id = :id',
    { amount, id: fromAccountId }
  );
  // ✅ Same instance, same transaction — no nesting.
  await transactionDb.executeQuery(
    'UPDATE accounts SET balance = balance + :amount WHERE id = :id',
    { amount, id: toAccountId }
  );
});
```

### 3. Managing raw pool clients by hand

`db.connect()` hands you a bare `PoolClient`. If any code path throws before `release()`, that client is never returned to the pool — after enough leaks, every query stalls waiting for a connection that will never come back. The adapter's own force-disconnect fallback exists precisely because leaked clients are a known failure mode.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
}

async function listActiveUsers(db: PostgreSQLDatabase): Promise<void> {
  // ❌ A raw client checked out by hand: if the query above (or any code
  // before release) throws, this pool client is leaked permanently.
  const client = await db.connect();
  const result = await client.query('SELECT id, name FROM users WHERE active = $1', [true]);
  console.log(result.rows);
  client.release();
}
```

**Instead:** use `executeQuery()` (which releases in a `finally` block, translates named parameters and types the result):

```typescript
async function listActiveUsers(db: PostgreSQLDatabase): Promise<UserRow[]> {
  // ✅ Named parameters, typed result, guaranteed release.
  const { records } = await db.executeQuery<UserRow>(
    'SELECT id, name FROM users WHERE active = :active',
    { active: true }
  );
  return records;
}
```

If you truly need a raw client for driver-specific features, always wrap it: `try { /* ... */ } finally { client.release(); }`.

### 4. Using a `PostgreSQLDatabase` after `disconnect()`

`disconnect()` is terminal for the instance: it sets `isShuttingDown`, and every later call fails fast — queries with `Cannot execute query: database is shutting down` and transactions with `Cannot start transaction: database is shutting down`. Code that disconnects early (for example in a `beforeEach`-style cleanup) and then keeps using the instance fails at runtime.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function lifecycleMistake(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  await db.disconnect();

  // ❌ Rejects with "Cannot execute query: database is shutting down".
  await db.executeQuery('SELECT 1');
}
```

**Instead:** run all work before the single shutdown, or construct a fresh instance (which owns a fresh pool) if you genuinely need to reconnect:

```typescript
async function lifecycle(db: PostgreSQLDatabase): Promise<void> {
  // ✅ All work happens while the instance is live; disconnect() is the
  // last thing you ever do with it.
  await db.executeQuery('SELECT 1');
  await db.disconnect();
}
```

### 5. Using `try/catch` to detect "no rows matched"

Empty results are normal resolutions, not exceptions. Wrapping queries in `try/catch` to detect "not found" means the catch block only ever fires for real failures — and the "not found" case falls through as `undefined`/`null` handling you probably did not write.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id: number;
  name: string;
  email: string;
}

async function findUser(db: PostgreSQLDatabase, email: string): Promise<User | null> {
  try {
    const { records } = await db.executeQuery<User>(
      'SELECT id, name, email FROM users WHERE email = :email',
      { email }
    );
    // ❌ records[0] is undefined when nothing matched; the catch below is
    // dead code for the "not found" case and only fires on real errors.
    return records[0];
  } catch {
    return null;
  }
}
```

**Instead:** branch on `rowCount` — the explicit outcome signal:

```typescript
async function findUser(db: PostgreSQLDatabase, email: string): Promise<User | null> {
  // ✅ "No match" is handled with control flow, not exceptions.
  const { records, rowCount } = await db.executeQuery<User>(
    'SELECT id, name, email FROM users WHERE email = :email',
    { email }
  );

  if (rowCount === 0) {
    return null;
  }

  return records[0];
}
```

### 6. Fire-and-forget queries (missing `await`)

Dropping `await` turns the query into a floating promise: failures surface as unhandled rejections instead of reaching your error handling, ordering and backpressure are lost, and the caller cannot know when the work actually finished.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface AuditRow {
  action: string;
  entityId: number;
}

async function writeAuditLog(db: PostgreSQLDatabase, rows: AuditRow[]): Promise<void> {
  for (const row of rows) {
    // ❌ Floating promise: a failing insert becomes an unhandled rejection,
    // and this function resolves while the inserts are still in flight.
    db.insert<AuditRow>('audit_log')
      .values({ action: row.action, entityId: row.entityId })
      .execute();
  }
}
```

**Instead:** await every terminal call (and consider batching — see the performance tips):

```typescript
async function writeAuditLog(db: PostgreSQLDatabase, rows: AuditRow[]): Promise<void> {
  // ✅ Each insert completes (or throws) before the loop continues.
  for (const row of rows) {
    await db
      .insert<AuditRow>('audit_log')
      .values({ action: row.action, entityId: row.entityId })
      .execute();
  }
}
```

### 7. Assuming a successful call means the intended rows were affected

`execute()` resolves successfully whether the filter matched zero rows or every row. A typo in a filter silently turns a purge into a no-op (or vice versa) while the job logs unconditional success.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  status?: string;
}

async function purgeExpiredSessions(db: PostgreSQLDatabase): Promise<void> {
  // ❌ Resolves whether the filter matched 0 rows or 10 000 000 rows.
  await db.delete<SessionFilter>('sessions').filter({ status: 'expired' }).execute();
  console.log('Purge complete');
}
```

**Instead:** capture and verify the affected-row count — it is the only trustworthy success signal:

```typescript
async function purgeExpiredSessions(db: PostgreSQLDatabase): Promise<void> {
  // ✅ The returned count lets you detect both no-op and over-broad filters.
  const deleted = await db
    .delete<SessionFilter>('sessions')
    .filter({ status: 'expired' })
    .executeReturnCount();

  if (deleted === 0) {
    console.warn('Purge matched no sessions — is the filter correct?');
    return;
  }

  console.log(`Purged ${deleted} expired session(s)`);
}
```

### 8. Opening a transaction for a single statement

A single statement is already atomic. Wrapping it in `withTransaction()` adds two extra round trips (`BEGIN`, `COMMIT`) and pins a pool client for no benefit — under load, those pinned clients reduce the pool capacity available to everything else.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function incrementCounter(db: PostgreSQLDatabase, name: string): Promise<void> {
  // ❌ Three round trips and a pinned client for one atomic statement.
  await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(
      'UPDATE counters SET value = value + 1 WHERE name = :name',
      { name }
    );
  });

  // ✅ A single statement needs no transaction wrapper.
  await db.executeQuery('UPDATE counters SET value = value + 1 WHERE name = :name', { name });
}
```

**Rule of thumb:** use `withTransaction()` when **two or more** statements must succeed or fail together. Use `executeQuery()` (or a builder terminal method) for everything else.

---

## Performance Tips

### 1. Size the pool against the server's `max_connections`

The total potential connection demand is `application instances × poolConfig.max`. Keep that product below the server's `max_connections` minus headroom for administration, migrations, and other clients. With a server limit of 100 and 5 application instances, a `max` of 16 yields at most 80 connections — the default of 10 per instance would leave the last instances locked out under full load.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
  poolConfig: {
    max: 16,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },
};

const db = new PostgreSQLDatabase(config);
console.log(`Pool for ${db.config.database} configured`);
```

| Option | Default | What to watch | Suggested value |
| --- | --- | --- | --- |
| `max` | 10 | `instances × max` must stay under `max_connections` − headroom | Compute per deployment, e.g. 16 for 5 instances on a 100-connection server |
| `idleTimeoutMillis` | 30000 | Higher keeps sockets warm (no re-auth on spikes); lower returns memory to the server during quiet periods | 10000–60000 depending on traffic shape |
| `connectionTimeoutMillis` | 0 (wait indefinitely) | With the default, requests queue forever when the pool is exhausted | 2000–5000 so saturation surfaces as a fast, actionable error |

### 2. Batch related writes into one transaction

Every terminal `execute*` call is at least one round trip to the server. A per-row transaction multiplies that by three (`BEGIN`, statement, `COMMIT`) and churns a client per row. One transaction for the whole batch reduces two round trips per row to two round trips total and reuses a single client.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface AuditEvent {
  action: string;
  entityId: number;
}

async function recordEventsOneByOne(db: PostgreSQLDatabase, events: AuditEvent[]): Promise<void> {
  // ❌ N transactions = 3N round trips and N client checkouts.
  for (const event of events) {
    await db.withTransaction(async transactionDb => {
      await transactionDb.insert<AuditEvent>('audit_log').values(event).execute();
    });
  }
}

async function recordEventsBatched(db: PostgreSQLDatabase, events: AuditEvent[]): Promise<void> {
  // ✅ One transaction = two round trips total, one pinned client.
  await db.withTransaction(async transactionDb => {
    for (const event of events) {
      await transactionDb.insert<AuditEvent>('audit_log').values(event).execute();
    }
  });
}
```

Keep batches bounded (chunk very large arrays): a transaction that runs for seconds holds a pool slot and locks for its whole duration.

### 3. Keep transactions short — no slow external work inside

While a transaction runs, one pool client is pinned and row locks are held. Doing slow work inside it (HTTP calls, file I/O, sleeps) reduces the effective pool size for every other caller, holds locks against concurrent writers, and delays PostgreSQL's vacuum. Prepare inputs before `withTransaction()` and perform slow side effects after it commits.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

// ✅ The exchange rate was fetched (slow, external) before this function ran;
// the transaction below contains only the short, lock-holding write.
async function applyExchangeRate(
  db: PostgreSQLDatabase,
  accountId: number,
  rate: number
): Promise<void> {
  await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(
      'UPDATE accounts SET balance = ROUND(balance * :rate, 2) WHERE id = :id',
      { rate, id: accountId }
    );
  });
}
```

### 4. Ask only for what you need from writes

`returning('*')` ships the full row across the wire and builds JS objects for every column, even when you only need the generated key. And if you only need the affected-row count, `executeReturnCount()` achieves it with no `RETURNING` clause at all — zero row data transferred.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface AuditEvent {
  action: string;
  entityId: number;
}

async function recordEvent(db: PostgreSQLDatabase, event: AuditEvent): Promise<void> {
  // ❌ Full row transferred and decoded just to count one insert.
  await db
    .insert<AuditEvent>('audit_log')
    .values(event)
    .returning('*')
    .executeReturnAll();

  // ✅ No RETURNING clause — only the affected count crosses the wire.
  await db.insert<AuditEvent>('audit_log').values(event).executeReturnCount();

  // ✅ When you do need data back, request exactly the columns you consume.
  await db
    .insert<AuditEvent>('audit_log')
    .values(event)
    .returning(['entityId'])
    .executeReturnSingle();
}
```

### 5. Select only the columns you consume on reads

`SELECT *` decodes every column into JS objects and transfers all of them, even when the caller uses two fields. For hot read paths, name the columns — the savings are proportional to row count and column width.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id: number;
  name: string;
  email: string;
  bio: string;
}

async function loadUserSummaries(db: PostgreSQLDatabase): Promise<Array<{ id: number; name: string }>> {
  // ❌ Every column (including potentially large ones) is transferred
  // and decoded even though only id and name are used.
  const everything = await db.executeQuery<User>('SELECT * FROM users WHERE active = :active', {
    active: true,
  });
  console.log(`Discarded ${everything.records[0]?.bio.length ?? 0} characters of bio`);

  // ✅ Only the columns the caller consumes.
  const { records } = await db.executeQuery<{ id: number; name: string }>(
    'SELECT id, name FROM users WHERE active = :active',
    { active: true }
  );
  return records;
}
```

### 6. Don't micro-manage statement construction

The expensive part of building a statement — compiling the `filter`/`filterByExpression` condition — is cached per statement (`getCompiledExpression()`), so `buildQuery()` and `buildParameters()` do not compile the filter twice. Statement text generation itself is cheap. Construct a fresh builder per operation and let the base class handle caching; hand-caching SQL strings or pre-compiling expressions yourself adds complexity without measurable gain.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface SessionFilter {
  status?: string;
}

// ✅ Construct per operation — the expression is compiled once and reused
// internally for both the query text and its parameters.
async function deleteExpired(db: PostgreSQLDatabase): Promise<number> {
  return db
    .delete<SessionFilter>('sessions')
    .filterByExpression(q => q.where('status').equals('expired'))
    .executeReturnCount();
}
```

---

## Security Considerations

### 1. Values are bound — identifiers are not; allowlist dynamic identifiers

Named parameters protect **values** only. Table names, the column keys inside `.values()`, and `.returning()` entries are interpolated into the SQL text (`INSERT INTO ${tableName} …`) and cannot be parameterized by any driver. If any of them can be influenced by a request, that is injection.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

// ❌ The table name lands directly in the SQL text:
// `INSERT INTO ${tableName} (…) VALUES (…)`. A request-driven name is injectable.
async function insertRow<T>(db: PostgreSQLDatabase, tableName: string, payload: Partial<T>): Promise<number> {
  return db.insert<T>(tableName).values(payload).executeReturnCount();
}
```

**Instead:** fail closed on anything that is not an explicitly allowed identifier:

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const ALLOWED_TABLES = new Set<string>(['users', 'orders']);

function assertAllowedTable(tableName: string): string {
  if (!ALLOWED_TABLES.has(tableName)) {
    throw new Error(`Table "${tableName}" is not allowed`);
  }
  return tableName;
}

async function insertRow<T>(
  db: PostgreSQLDatabase,
  tableName: string,
  payload: Partial<T>
): Promise<number> {
  // ✅ Only allowlisted identifiers ever reach the SQL builder.
  return db.insert<T>(assertAllowedTable(tableName)).values(payload).executeReturnCount();
}
```

### 2. Rely on parameter binding — even in throwaway code

The binding guarantee holds unconditionally: a malicious value is compared as a literal string and can never be parsed as SQL. Keep it that way by never "optimizing" a query into string concatenation, even for values that look internal or validated.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

async function attemptInjection(db: PostgreSQLDatabase): Promise<void> {
  const maliciousInput = "'; DROP TABLE users; --";

  const { rowCount } = await db.executeQuery<{ id: number }>(
    'SELECT id FROM users WHERE name = :name',
    { name: maliciousInput }
  );

  // ✅ rowCount === 0: yesql sends the payload as a bound positional value;
  // PostgreSQL compares it as a literal string and never parses it as SQL.
  console.log(`Rows matched: ${rowCount}`);
}
```

### 3. Hash secrets before writes; redact secrets after reads

`beforeQuery`/`afterQuery` hooks are synchronous transforms that centralize value normalization and redaction at the data layer. Hash credentials **before** building the statement — hooks are synchronous, so async hashing cannot live inside `beforeQuery`. Redact sensitive columns in `afterQuery` so they never leave the adapter, even when the SQL uses `RETURNING *`.

```typescript
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const scryptAsync = promisify(scrypt);

async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(plain, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
}

async function createUser(
  db: PostgreSQLDatabase,
  name: string,
  email: string,
  plainPassword: string
): Promise<void> {
  // ✅ Async hashing happens before the statement.
  const passwordHash = await hashPassword(plainPassword);

  const created = await db
    .insert<User>('users')
    .values({ name, email, password_hash: passwordHash })
    .afterQuery((records: User[]) =>
      // ✅ The hash never leaves the data layer, even with RETURNING *.
      records.map(record => {
        const safe = { ...record };
        delete safe.password_hash;
        return safe;
      })
    )
    .returning('*')
    .executeReturnSingle();

  if (created !== null) {
    console.log(`Created user #${created.id}`);
  }
}
```

### 4. Least-privilege credentials from the environment — never logged

The config object contains `pass`, so never `console.log(config)` or serialize it into error reports. Provision a database role with only the DML privileges the service needs (`SELECT`/`INSERT`/`UPDATE`/`DELETE` on its tables) and keep DDL/migrations on a separate role — if a query path is ever compromised, the blast radius stays bounded.

```typescript
import { PostgreSQLConfig } from 'blendsdk/postgresql';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// ✅ Credentials come from the environment; log only non-sensitive parts.
const config: PostgreSQLConfig = {
  host: requireEnv('PGHOST'),
  port: Number(requireEnv('PGPORT')),
  database: requireEnv('PGDATABASE'),
  user: requireEnv('PGUSER'),
  pass: requireEnv('PGPASSWORD'),
};

console.log(`Connecting to ${config.database} at ${config.host}`);
```

### 5. Enforce authorization in SQL, not in hooks

Authorization based on `afterQuery` runs **after** the rows have been fetched from the database: every tenant's data crosses the wire, and any code path that forgets the hook silently drops the boundary. Row-level access rules belong in the `WHERE` clause (ideally backed by database row-level security), with hooks as defense in depth — never as the primary control.

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

interface TenantOrder {
  id: number;
  tenant_id: string;
  total: string;
}

async function loadTenantOrders(db: PostgreSQLDatabase, tenantId: string): Promise<TenantOrder[]> {
  // ❌ Every row from every tenant is fetched, then filtered in memory.
  // One forgotten hook or one executeQuery bypass leaks all tenants' data.
  const unscoped = await db.executeQuery<TenantOrder>('SELECT * FROM orders', {}, {
    afterQuery: rows => rows.filter(row => row.tenant_id === tenantId),
  });
  return unscoped.records;
}
```

**Instead:** scope the query itself — the database only returns authorized rows:

```typescript
async function loadTenantOrders(db: PostgreSQLDatabase, tenantId: string): Promise<TenantOrder[]> {
  // ✅ The tenant boundary is part of the SQL statement.
  const { records } = await db.executeQuery<TenantOrder>(
    'SELECT id, tenant_id, total FROM orders WHERE tenant_id = :tenantId',
    { tenantId }
  );
  return records;
}
```

---

## Best Practices at a Glance

| # | Practice | Key API |
| --- | --- | --- |
| 1 | Drain the pool in a `finally` block; disconnect once per process | `disconnect()` |
| 2 | Bind values as `:name` parameters — never concatenate SQL | `executeQuery()` |
| 3 | Scope every `UPDATE` / `DELETE` with a filter and verify counts | `.filter()`, `executeReturnCount()` |
| 4 | Wrap multi-statement writes in one transaction | `withTransaction()` |
| 5 | Let errors propagate inside transaction callbacks | `withTransaction()` |
| 6 | Use `RETURNING` instead of follow-up `SELECT`s | `.returning()`, `.executeReturnSingle()` |
| 7 | Handle `null` / empty results with control flow, not exceptions | `rowCount`, `executeReturnSingle()` |
| 8 | Type results to PostgreSQL's wire format (`DECIMAL` → string) | `executeQuery<R>()` |
| 9 | Respect hook parameter names (`v_` prefix, `p1`…`pN` for WHERE) | `beforeQuery`, `afterQuery` |
| 10 | Enable automatic shutdown handlers only where nothing else owns signals | `enableGracefulShutdown` |
| 11 | Share one database instance per process; size the pool vs `max_connections` | `poolConfig` |
| 12 | Allowlist dynamic identifiers; parameterize values; scope rows in SQL | `insert()`, `values()`, `returning()` |

---

# postgresql Testing Patterns

This document describes how to test code built on `blendsdk/postgresql`. The patterns are derived from the package's own test suite, which is split into two tiers:

- **Unit tier** — SQL generation from `PostgreSQLInsertStatement`, `PostgreSQLUpdateStatement`, and `PostgreSQLDeleteStatement`. Pure string/parameter assertions with **no database required**.
- **Integration tier** — real query execution, transactions, hooks, pooling, and shutdown behavior against a **Dockerized PostgreSQL** instance.

> The package's `tests/` directory is the source of truth for every pattern shown here. Inside the package, tests import internals through relative paths (`../src/database.js`); consumers should import the published entry point (`blendsdk/postgresql`) as the examples below do.

| Section | What it covers |
| --- | --- |
| [Test Setup](#test-setup) | Vitest configuration, the Docker test database, shared helpers |
| [Unit Testing](#unit-testing) | Testing SQL generation without a database |
| [Integration Testing](#integration-testing) | Patterns for tests that talk to PostgreSQL |
| [Mocking & Stubbing](#mocking--stubbing) | Test doubles for database-dependent code |
| [Test Patterns by Feature](#test-patterns-by-feature) | Per-feature recipes and assertions |

---

## Test Setup

### Requirements

| Requirement | Value / Note |
| --- | --- |
| Node.js | `>= 22.0.0` |
| Test framework | `vitest` `^4.1.10` (explicit imports, no globals) |
| Coverage | `@vitest/coverage-v8` (used by `yarn test:coverage`) |
| Language | TypeScript strict mode, ESM-only |
| PostgreSQL for integration tier | Docker (or any server matching the coordinates below) |

### Test tiers and scripts

| Command | Purpose | Database required |
| --- | --- | --- |
| `yarn test:fast` | Runs only `tests/statement-builders.test.ts` — the SQL-generation tier | No |
| `yarn test:watch` | Vitest watch mode (full suite) | Yes |
| `yarn test:coverage` | Full run with V8 coverage | Yes |
| `yarn test` | Full run with automatic container lifecycle | Yes (Docker) |
| `yarn db:up` / `yarn db:down` | Start / stop the Dockerized PostgreSQL used by tests | — |
| `yarn db:logs` | Follow the `postgres-test` container logs | — |

Notes:

- `db:up`, `db:down`, and `db:logs` operate on `docker/docker-compose${MODE}.yml` — set the `MODE` environment variable to switch between compose variants. `db:up` waits five seconds after starting the container so the server can accept connections.
- `yarn test` orchestrates the full lifecycle: it stops any leftover container, starts the database, runs `vitest run --reporter=verbose`, and tears the container down again.

### The test database

| Setting | Value |
| --- | --- |
| Host | `localhost` |
| Port | `5599` |
| Database | `testdb` |
| User | `testdb` |
| Password | `testdb` |

The suite only ever creates `TEMP` tables — nothing is written to the container's regular schema, so the database is disposable and can be replaced with any equivalent PostgreSQL server at these coordinates. A compose service equivalent to the one started by `yarn db:up`:

```yaml
services:
  postgres-test:
    image: postgres:16-alpine
    ports:
      - '5599:5432'
    environment:
      POSTGRES_DB: testdb
      POSTGRES_USER: testdb
      POSTGRES_PASSWORD: testdb
```

### Vitest configuration

The package runs Vitest with the verbose reporter and generous timeouts because integration tests create temp tables and drain connection pools during teardown. A minimal `vitest.config.ts` with the same behavior:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    reporter: 'verbose',
    testTimeout: 30000,
    hookTimeout: 30000,
    restoreMocks: true,
  },
});
```

| Option | Why it matters here |
| --- | --- |
| `testTimeout` | Integration tests run multi-statement transactions and fresh pool connections |
| `hookTimeout` | `disconnect()` in teardown may legitimately wait on the pool (the package's own `afterEach` allows 30 s) |
| `restoreMocks` | Automatically restores `vi.spyOn` stubs between tests |
| `reporter: 'verbose'` | Matches the `--reporter=verbose` flag used by the package scripts |

### Required imports

The complete import set used across this document:

```typescript
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLDeleteStatement,
  PostgreSQLInsertStatement,
  PostgreSQLQueryResult,
  PostgreSQLUpdateStatement,
} from 'blendsdk/postgresql';
```

### Shared connection parameters (`tests/params.ts`)

Mirroring the package's `tests/params.ts`, every integration test reads its connection settings from one shared config:

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

### Test database factory (`tests/helpers.ts`)

One helper that creates database handles for integration tests; the pool inside connects lazily on first use, so this is cheap:

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

/** Creates a database handle for integration tests; the pool connects lazily on first use. */
export function createTestDatabase(overrides: Partial<PostgreSQLConfig> = {}): PostgreSQLDatabase {
  return new PostgreSQLDatabase({ ...connectionConfig, ...overrides });
}
```

### Unit-test helpers for statement builders (`tests/statement-helpers.ts`)

The SQL text of `INSERT` / `UPDATE` / `DELETE` statements is produced by the protected `buildQuery()` and `buildParameters()` extension points. The helpers below expose them as public methods via subclassing — this keeps unit tests fully typed (no `any` casts) and needs no database, because a `PostgreSQLDatabase` constructed with a throwaway config never connects:

```typescript
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLDeleteStatement,
  PostgreSQLInsertStatement,
  PostgreSQLUpdateStatement,
} from 'blendsdk/postgresql';

/**
 * Connection settings used only to construct the database instance.
 * The pg.Pool connects lazily; statement builders never open a connection.
 */
export const statementOnlyConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'statement-tests',
  user: 'unused',
  pass: 'unused',
};

/** Exposes the protected buildQuery() / buildParameters() extension points for assertions. */
export class TestableInsertStatement<TableType> extends PostgreSQLInsertStatement<TableType> {
  query(): string {
    return this.buildQuery();
  }

  params() {
    return this.buildParameters();
  }
}

export class TestableUpdateStatement<TableType, FilterType> extends PostgreSQLUpdateStatement<
  TableType,
  FilterType
> {
  query(): string {
    return this.buildQuery();
  }

  params() {
    return this.buildParameters();
  }
}

export class TestableDeleteStatement<FilterType> extends PostgreSQLDeleteStatement<FilterType> {
  query(): string {
    return this.buildQuery();
  }

  params() {
    return this.buildParameters();
  }
}

function statementDatabase(): PostgreSQLDatabase {
  return new PostgreSQLDatabase(statementOnlyConfig);
}

export function createInsertStatement<TableType>(
  tableName: string
): TestableInsertStatement<TableType> {
  return new TestableInsertStatement<TableType>(tableName, statementDatabase());
}

export function createUpdateStatement<TableType, FilterType>(
  tableName: string
): TestableUpdateStatement<TableType, FilterType> {
  return new TestableUpdateStatement<TableType, FilterType>(tableName, statementDatabase());
}

export function createDeleteStatement<FilterType>(
  tableName: string
): TestableDeleteStatement<FilterType> {
  return new TestableDeleteStatement<FilterType>(tableName, statementDatabase());
}
```

### Teardown pattern

The package's pool-management suite handles every cleanup through an `afterEach` with an explicit hook timeout — a failed disconnect must never mask the original test failure:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

describe('integration suite skeleton', () => {
  let db: PostgreSQLDatabase;

  beforeEach(() => {
    db = new PostgreSQLDatabase(connectionConfig);
  });

  afterEach(async () => {
    try {
      await db.disconnect(15000);
    } catch {
      // Ignore disconnect errors during cleanup so teardown never masks a test failure
    }
  }, 30000);

  test('connects', async () => {
    const { rowCount } = await db.executeQuery('SELECT 1');
    expect(rowCount).toBe(1);
  });
});
```

The `30000` passed as the second argument to `afterEach` is the hook timeout. Standalone test examples in the rest of this document call `await db.disconnect()` at the end of the test instead — pick one convention per suite and stick with it.

### Reference test suite

The package's own files map to features like this; use them as living examples:

| Test file (package) | Tier | Covers |
| --- | --- | --- |
| `tests/statement-builders.test.ts` | Unit (no DB) | INSERT / UPDATE / DELETE SQL generation, expression caching |
| `tests/database.test.ts` | Integration | Connections, query execution, value types, factories |
| `tests/transaction.test.ts` | Integration | Commit, rollback, constraint violations |
| `tests/connection-pool.test.ts` | Integration | Pooling, disconnect, shutdown guards, concurrency |
| `tests/insert.test.ts` / `update.test.ts` / `delete.test.ts` | Integration | Builders with execution, RETURNING, `executeReturn*` |
| `tests/hooks.test.ts` | Integration | `beforeQuery` / `afterQuery` |
| `tests/from.test.ts` | Unit + Integration | SELECT via `from()` and compiled expressions |

---

## Unit Testing

Unit tests validate **SQL generation only**. Two facts make this possible without any mocking infrastructure:

1. The `PostgreSQLDatabase` constructor creates a `pg.Pool` object but **never opens a connection** — sockets are established lazily on the first query.
2. Statement builders do no I/O — they only assemble query text and a parameter object at execution time, through the protected `buildQuery()` and `buildParameters()` extension points.

The package's own unit tier lives in `tests/statement-builders.test.ts` and is what `yarn test:fast` runs. These tests are **synchronous** — no async setup, teardown, or connection management is needed.

### Pattern: asserting INSERT SQL

```typescript
import { describe, expect, test } from 'vitest';
import { createInsertStatement } from './statement-helpers.js';

interface TestUser {
  id?: number;
  name: string;
  email: string;
  age?: number;
  active?: boolean;
}

describe('PostgreSQLInsertStatement', () => {
  test('renders columns with named placeholders', () => {
    const statement = createInsertStatement<TestUser>('users');
    statement.values({ name: 'Alice', email: 'alice@example.com', age: 30 });

    expect(statement.query()).toBe(
      'INSERT INTO users (name, email, age) VALUES (:name, :email, :age)'
    );
  });

  test('returns the values object as named parameters', () => {
    const statement = createInsertStatement<TestUser>('users');
    statement.values({ name: 'Alice', email: 'alice@example.com' });

    expect(statement.params()).toEqual({ name: 'Alice', email: 'alice@example.com' });
  });

  test('appends a RETURNING clause on request', () => {
    const statement = createInsertStatement<TestUser>('users');
    statement.values({ name: 'Alice', email: 'alice@example.com' }).returning('*');

    expect(statement.query()).toBe(
      'INSERT INTO users (name, email) VALUES (:name, :email) RETURNING *'
    );
  });

  test('refuses to build an INSERT without values', () => {
    const statement = createInsertStatement<Record<string, never>>('users');
    statement.values({});

    expect(() => statement.query()).toThrow(
      'Cannot build INSERT statement for table "users": no values provided'
    );
  });
});
```

### Pattern: asserting UPDATE SQL and the `v_` parameter namespace

`UPDATE` statements prefix every SET value with `v_` and name WHERE-clause parameters `p1`, `p2`, …, so the two can never collide:

```typescript
import { describe, expect, test } from 'vitest';
import { createUpdateStatement } from './statement-helpers.js';

interface TestUser {
  name: string;
  email: string;
  active?: boolean;
}

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}

describe('PostgreSQLUpdateStatement', () => {
  test('renders SET with v_-prefixed parameters and a WHERE from the filter', () => {
    const statement = createUpdateStatement<TestUser, UserFilter>('users');
    statement.values({ name: 'Updated Name', active: true }).filter({ id: 1 });

    expect(statement.query()).toBe(
      'UPDATE users SET name = :v_name, active = :v_active WHERE id = :p1'
    );
    expect(statement.params()).toEqual({
      v_name: 'Updated Name',
      v_active: true,
      p1: 1,
    });
  });

  test('keeps SET values and filter parameters in separate namespaces', () => {
    const statement = createUpdateStatement<TestUser, UserFilter>('users');
    statement.values({ active: true }).filter({ active: false });

    const params = statement.params();
    expect(params.v_active).toBe(true);
    expect(Object.values(params)).toContain(false);
  });

  test('derives the WHERE clause from a filter expression', () => {
    const statement = createUpdateStatement<TestUser, UserFilter>('users');
    statement.values({ name: 'Updated' }).filterByExpression(q => q.where('active').equals(false));

    expect(statement.query()).toContain('UPDATE users SET name = :v_name');
    expect(statement.query()).toContain('WHERE');
    expect(Object.values(statement.params())).toContain(false);
  });

  test('refuses to build an UPDATE without values', () => {
    const statement = createUpdateStatement<Record<string, never>, UserFilter>('users');
    statement.values({}).filter({ id: 1 });

    expect(() => statement.query()).toThrow(
      'Cannot build UPDATE statement for table "users": no values provided'
    );
  });
});
```

### Pattern: asserting DELETE SQL

```typescript
import { describe, expect, test } from 'vitest';
import { createDeleteStatement } from './statement-helpers.js';

interface UserFilter {
  id?: number;
  email?: string;
}

describe('PostgreSQLDeleteStatement', () => {
  test('renders a parameterless bulk DELETE for an empty filter', () => {
    const statement = createDeleteStatement<UserFilter>('users');
    statement.filter({});

    expect(statement.query()).toBe('DELETE FROM users');
    expect(statement.params()).toEqual({});
  });

  test('renders WHERE and RETURNING clauses for a filtered delete', () => {
    const statement = createDeleteStatement<UserFilter>('users');
    statement.filter({ email: 'ada@example.com' }).returning('*');

    expect(statement.query()).toBe('DELETE FROM users WHERE email = :p1 RETURNING *');
    expect(statement.params()).toEqual({ p1: 'ada@example.com' });
  });
});
```

> Assert the missing `WHERE` explicitly. An empty filter is a **bulk delete**; a regression there should be caught by a test, not by production data.

### Pattern: verifying expression caching and construction

The compiled filter expression is cached per statement, so repeated build calls must produce identical output. Constructor tests verify configuration handling without ever touching a server:

```typescript
import { describe, expect, test } from 'vitest';
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLDeleteStatement,
  PostgreSQLInsertStatement,
  PostgreSQLUpdateStatement,
} from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';
import { createUpdateStatement } from './statement-helpers.js';

interface TestUser {
  name: string;
  email: string;
}

interface UserFilter {
  id?: number;
}

describe('compiled expression caching', () => {
  test('reuses the compiled filter across repeated build calls', () => {
    const statement = createUpdateStatement<TestUser, UserFilter>('users');
    statement.values({ name: 'Test' }).filter({ id: 1 });

    const firstQuery = statement.query();
    const firstParams = statement.params();

    expect(statement.query()).toBe(firstQuery);
    expect(statement.params()).toEqual(firstParams);
  });
});

describe('PostgreSQLDatabase construction', () => {
  test('does not connect during construction', () => {
    const db = new PostgreSQLDatabase({ ...connectionConfig, host: 'unreachable-host' });

    expect(db).toBeInstanceOf(PostgreSQLDatabase);
  });

  test('accepts a numeric string port', () => {
    expect(() => new PostgreSQLDatabase({ ...connectionConfig, port: '5400' })).not.toThrow();
  });

  test('accepts pool configuration overrides', () => {
    const config: PostgreSQLConfig = {
      ...connectionConfig,
      poolConfig: { max: 20, idleTimeoutMillis: 60000, connectionTimeoutMillis: 5000 },
    };

    expect(() => new PostgreSQLDatabase(config)).not.toThrow();
  });

  test('accepts the graceful shutdown toggle without registering handlers', () => {
    expect(
      () => new PostgreSQLDatabase({ ...connectionConfig, enableGracefulShutdown: false })
    ).not.toThrow();
  });

  test('factories return the PostgreSQL statement implementations', () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    expect(db.insert<TestUser>('users')).toBeInstanceOf(PostgreSQLInsertStatement);
    expect(db.update<TestUser, UserFilter>('users')).toBeInstanceOf(PostgreSQLUpdateStatement);
    expect(db.delete<UserFilter>('users')).toBeInstanceOf(PostgreSQLDeleteStatement);
  });
});
```

> Never construct a database with `enableGracefulShutdown: true` in a unit test — that installs real `SIGINT` / `SIGTERM` process handlers. Assert option acceptance with `false` (the [Graceful Shutdown](#graceful-shutdown) pattern shows how to spy on `process.on` for the enabled case).

---

## Integration Testing

Integration tests run against the Dockerized PostgreSQL described in [Test Setup](#test-setup). Start the container with `yarn db:up` (or let `yarn test` manage it), and never point these tests at a shared or production database.

### Value quirks to expect in assertions

PostgreSQL's wire types do not always map one-to-one to JavaScript types. The package's tests assert accordingly:

| PostgreSQL value | Comes back as | Assertion tip |
| --- | --- | --- |
| `integer`, `serial` | `number` | direct `toBe` / `toEqual` |
| `numeric`, `decimal` | `string` | `expect(price).toBe('29.99')` |
| `count(*)` | `string` | `parseInt(count)` or `Number(count)` |
| `timestamp`, `date` | `Date` | `expect(value).toBeInstanceOf(Date)` or `expect.any(Date)` |
| `boolean` | `boolean` | direct |
| `jsonb` | parsed JS value | `toEqual({ nested: 'object' })` |
| `text[]` | JS array | `toEqual(['a', 'b'])` |
| untyped `:param` in a `SELECT` | `string` | `expect(result.records[0].num).toBe(String(index))` |

### Pattern: fail fast when the database is missing

Check connectivity once in `beforeAll` so a missing container produces one clear error instead of dozens of timeout failures:

```typescript
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

describe('PostgreSQL integration', () => {
  let db: PostgreSQLDatabase;

  beforeAll(async () => {
    db = new PostgreSQLDatabase(connectionConfig);
    // Fail fast with a clear error when the Docker database is not reachable
    await db.executeQuery('SELECT 1');
  });

  afterAll(async () => {
    await db.disconnect();
  });

  test('reaches the server', async () => {
    const { records, rowCount } = await db.executeQuery<{ alive: boolean }>('SELECT true as alive');

    expect(rowCount).toBe(1);
    expect(records[0].alive).toBe(true);
  });
});
```

### Pattern: TEMP tables inside one transaction

This is the backbone of the integration tier: create a `TEMP` table inside a `withTransaction()` callback. The transaction pins a single client, so every statement in the callback sees the table, and the table disappears with the connection — no cleanup SQL, no interference with the shared schema:

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('writes and reads a row within one transaction', async () => {
  const db = createTestDatabase();

  const result = await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL
      )
    `);

    await transactionDb
      .insert<{ name: string; email: string }>('test_users')
      .values({ name: 'Ada Lovelace', email: 'ada@example.com' })
      .execute();

    return transactionDb.executeQuery<{ id: number; name: string; email: string }>(
      'SELECT id, name, email FROM test_users WHERE email = :email',
      { email: 'ada@example.com' }
    );
  });

  expect(result.rowCount).toBe(1);
  expect(result.records[0]).toMatchObject({
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  });

  await db.disconnect();
});
```

- Statements issued through the callback's `transactionDb` are all statements of the same transaction on the same pinned client.
- Everything non-temp — assertions, `Promise.all`, `expect` — happens after the callback returns. Return the query result out of the transaction and assert on it in the test body, exactly as shown.

### Pattern: concurrent queries through the pool

Standalone (non-transactional) queries each check out a pool client, so concurrent calls exercise real pooling:

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('handles concurrent queries through the pool', async () => {
  const db = createTestDatabase();

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      db.executeQuery<{ num: string }>('SELECT :num as num', { num: index })
    )
  );

  results.forEach((result, index) => {
    expect(result.records[0].num).toBe(String(index));
  });

  await db.disconnect();
});
```

### Pattern: unreachable host

The pool surfaces connection failures on the first query, and `disconnect()` must still settle cleanly:

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('rejects the query but disconnects cleanly when the host is unreachable', async () => {
  const db = createTestDatabase({ host: 'invalid-host', port: 9999 });

  await expect(db.executeQuery('SELECT 1')).rejects.toThrow();

  await expect(db.disconnect()).resolves.not.toThrow();
});
```

---

## Mocking & Stubbing

`blendsdk/postgresql` exposes clean seams for test doubles without any module-level mocking:

| Seam | How it works |
| --- | --- |
| Inert construction | `new PostgreSQLDatabase(config)` never connects — an untouched instance performs no I/O |
| Method spying | `vi.spyOn(db, 'executeQuery')` / `vi.spyOn(db, 'withTransaction')` replace individual behaviors on a real, fully typed instance |
| Hook callbacks | `beforeQuery` / `afterQuery` transform parameters and rows without touching the query itself |
| Console spying | `vi.spyOn(console, 'error')` silences (or asserts on) diagnostics the adapter emits for recoverable internal errors |

The adapter owns its `pg.Pool` and exposes no way to inject one, so mocking `pg` itself is neither necessary nor recommended — stub at the `PostgreSQLDatabase` surface instead.

### Pattern: stubbing `executeQuery` for a consumer service

Create a real instance with throwaway credentials, then replace `executeQuery` with a typed fake result:

```typescript
import { describe, expect, test, vi } from 'vitest';
import { PostgreSQLConfig, PostgreSQLDatabase, PostgreSQLQueryResult } from 'blendsdk/postgresql';

interface UserRow {
  id: number;
  name: string;
}

const stubConfig: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'stub',
  user: 'stub',
  pass: 'stub',
};

async function findActiveUserNames(db: PostgreSQLDatabase): Promise<string[]> {
  const { records } = await db.executeQuery<UserRow>(
    'SELECT id, name FROM users WHERE active = :active',
    { active: true }
  );
  return records.map(record => record.name);
}

describe('findActiveUserNames', () => {
  test('maps records to names without connecting to PostgreSQL', async () => {
    const db = new PostgreSQLDatabase(stubConfig);
    const fakeResult: PostgreSQLQueryResult<UserRow> = {
      records: [{ id: 1, name: 'Ada' }],
      rowCount: 1,
      fields: [],
    };
    const spy = vi.spyOn(db, 'executeQuery').mockResolvedValue(fakeResult);

    const names = await findActiveUserNames(db);

    expect(names).toEqual(['Ada']);
    expect(spy).toHaveBeenCalledWith('SELECT id, name FROM users WHERE active = :active', {
      active: true,
    });

    spy.mockRestore();
  });
});
```

With `restoreMocks: true` in the Vitest config, the explicit `mockRestore()` becomes optional — keep it when you want the restoration visible in the test.

### Pattern: silencing adapter diagnostics

The adapter writes to `console.error` when a rollback or a client release fails. In negative-path tests, silence that output (or assert on it) so expected diagnostics do not pollute the report:

```typescript
import { expect, test, vi } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { connectionConfig } from './params.js';

test('keeps negative-path output clean and restores console behavior', async () => {
  const db = new PostgreSQLDatabase(connectionConfig);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
    /* expected rollback diagnostics are swallowed here */
  });

  await expect(
    db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery('SELECT 1');
      throw new Error('Test error');
    })
  ).rejects.toThrow('Test error');

  consoleError.mockRestore();
  await db.disconnect();
});
```

### Rules of thumb

- Prefer the real thing. SQL execution, transactions, hooks, and pooling are tested against the Docker database; the unit tier already covers SQL generation with zero stubs.
- Use `new PostgreSQLDatabase(throwawayConfig)` as your double base — it is fully typed, inert until touched, and never leaks sockets.
- Stub only what the test does not exercise (`vi.spyOn`), and restore mocks when the test ends.
- Do not mock `pg` or pool internals; assert through the public API (`executeQuery`, `withTransaction`, statement builders).
- Never run tests against shared databases. Isolate every fixture with `CREATE TEMP TABLE`, ideally inside a single `withTransaction()` callback.

---

## Test Patterns by Feature

### Connection Pooling

What to verify: configuration acceptance (unit), sequential and concurrent usage, and clean interleaving of standalone queries and transactions on one instance.

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('interleaves standalone queries and transactions on one instance', async () => {
  const db = createTestDatabase();

  await db.executeQuery('SELECT 1 as test');

  await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery('SELECT 2 as test');
  });

  const result = await db.executeQuery<{ test: number }>('SELECT 3 as test');
  expect(result.records[0].test).toBe(3);

  await db.disconnect();
});
```

| Assertion | Pattern |
| --- | --- |
| `poolConfig` acceptance (`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`) | Synchronous construction test (see [Unit Testing](#unit-testing)) |
| Concurrent load | `Promise.all` over `executeQuery` (see [Integration Testing](#integration-testing)) |
| Mixed query / transaction traffic | Interleave calls on one instance, as above |

### Query Execution

What to verify: typed records, `rowCount`, column metadata via `fields`, the empty-result contract, and injection safety.

#### Column metadata

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('asserts the returned column metadata', async () => {
  const db = createTestDatabase();

  const result = await db.executeQuery<{ id: number; name: string; active: boolean }>(
    'SELECT 1 as id, :name as name, true as active',
    { name: 'test' }
  );

  expect(result.fields).toHaveLength(3);
  expect(result.fields.map(field => field.name)).toEqual(['id', 'name', 'active']);

  await db.disconnect();
});
```

#### The empty-result contract

When no rows are returned, `executeQuery` resolves to exactly `{ records: [], rowCount: 0, fields: [] }` — note that `fields` is empty even though the statement has columns:

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('returns an explicitly empty result set when no rows match', async () => {
  const db = createTestDatabase();

  await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_empty (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100)
      )
    `);

    const result = await transactionDb.executeQuery<{ id: number; name: string }>(
      'SELECT * FROM test_empty WHERE id = :id',
      { id: 999 }
    );

    expect(result.records).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.fields).toEqual([]);
  });

  await db.disconnect();
});
```

#### SQL injection prevention

Prove that hostile input is bound as a parameter — never concatenated into the statement:

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('binds hostile input as a parameter instead of executing it', async () => {
  const db = createTestDatabase();

  const result = await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE injection_test (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100)
      )
    `);

    await transactionDb.executeQuery('INSERT INTO injection_test (name) VALUES (:name)', {
      name: 'legitimate_user',
    });

    const maliciousInput = "'; DROP TABLE injection_test; --";

    const malicious = await transactionDb.executeQuery<{ name: string }>(
      'SELECT * FROM injection_test WHERE name = :name',
      { name: maliciousInput }
    );

    const legitimate = await transactionDb.executeQuery<{ name: string }>(
      'SELECT * FROM injection_test WHERE name = :name',
      { name: 'legitimate_user' }
    );

    return { malicious, legitimate };
  });

  expect(result.malicious.rowCount).toBe(0);
  expect(result.legitimate.rowCount).toBe(1);
  expect(result.legitimate.records[0].name).toBe('legitimate_user');

  await db.disconnect();
});
```

| Assertion | Expectation |
| --- | --- |
| `rowCount` | Rows returned (SELECT) or affected (INSERT / UPDATE / DELETE) |
| `records` | Typed rows; `[]` when nothing matched |
| `fields` | Column metadata; `[]` when `rowCount` is `0` |
| Injection attempt | Rejected as a value (0 matches), table still intact |

### Transactions

What to verify: committed data persists, failures roll back, database errors (like constraint violations) roll back, and the client is always released — even after failures.

#### Committed changes persist

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('persists committed changes', async () => {
  const db = createTestDatabase();

  await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_commit (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL
      )
    `);
    await transactionDb.executeQuery('INSERT INTO test_commit (name) VALUES (:name)', {
      name: 'Committed',
    });
  });

  // Sequential operations on one instance reuse the pooled connection,
  // so the committed TEMP table is visible here (mirrors the package's own test).
  const { rowCount, records } = await db.executeQuery<{ name: string }>(
    'SELECT name FROM test_commit'
  );

  expect(rowCount).toBe(1);
  expect(records[0]).toEqual({ name: 'Committed' });

  await db.disconnect();
});
```

#### Callback errors roll back

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('rolls a failed transaction back', async () => {
  const db = createTestDatabase();

  await db.executeQuery(`
    CREATE TEMP TABLE test_rollback (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL
    )
  `);

  await expect(
    db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(
        'INSERT INTO test_rollback (name) VALUES (:name)',
        { name: 'Should Be Rolled Back' }
      );
      throw new Error('Intentional error to test rollback');
    })
  ).rejects.toThrow('Intentional error to test rollback');

  const { rowCount } = await db.executeQuery('SELECT * FROM test_rollback');
  expect(rowCount).toBe(0);

  await db.disconnect();
});
```

#### Database errors roll back everything

A constraint violation aborts the whole transaction, including statements that had already succeeded:

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('rolls back everything after a constraint violation', async () => {
  const db = createTestDatabase();

  await db.executeQuery(`
    CREATE TEMP TABLE test_emails (
      id SERIAL PRIMARY KEY,
      email VARCHAR(100) UNIQUE NOT NULL
    )
  `);
  await db.executeQuery('INSERT INTO test_emails (email) VALUES (:email)', {
    email: 'unique@example.com',
  });

  await expect(
    db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery('INSERT INTO test_emails (email) VALUES (:email)', {
        email: 'another@example.com',
      });
      // Violates the UNIQUE constraint and aborts the transaction
      await transactionDb.executeQuery('INSERT INTO test_emails (email) VALUES (:email)', {
        email: 'unique@example.com',
      });
    })
  ).rejects.toThrow();

  const { records, rowCount } = await db.executeQuery<{ email: string }>(
    'SELECT email FROM test_emails ORDER BY id'
  );

  expect(rowCount).toBe(1);
  expect(records[0]).toEqual({ email: 'unique@example.com' });

  await db.disconnect();
});
```

#### The client is always released

After a failed transaction the instance must remain fully usable — this verifies the guaranteed client release:

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('releases the client after a failed transaction', async () => {
  const db = createTestDatabase();

  await expect(
    db.withTransaction(async () => {
      throw new Error('Test error');
    })
  ).rejects.toThrow('Test error');

  const result = await db.executeQuery<{ test: number }>('SELECT 1 as test');
  expect(result.records[0].test).toBe(1);

  await db.disconnect();
});
```

Also worth covering: an **empty transaction** (`withTransaction(async () => 'value')`) resolves with the callback's return value. Note that transactions are not re-entrant — never call `withTransaction()` from inside a running transaction callback; issue all work through the callback's `transactionDb` instead.

### INSERT Statements

Unit tests cover SQL text and parameters (see [Unit Testing](#unit-testing)). The integration patterns below verify the terminal methods against real data.

#### `executeReturnSingle` with `RETURNING`

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

interface InsertedUser {
  id?: number;
  name: string;
  email: string;
  created_at?: Date;
}

test('executeReturnSingle resolves to the inserted row', async () => {
  const db = createTestDatabase();

  const created = await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    return transactionDb
      .insert<InsertedUser>('test_users')
      .values({ name: 'Returning Test', email: 'returning@example.com' })
      .returning('*')
      .executeReturnSingle();
  });

  expect(created).toMatchObject({
    name: 'Returning Test',
    email: 'returning@example.com',
  });
  expect(created?.id).toBeDefined();
  expect(created?.created_at).toBeDefined();

  await db.disconnect();
});
```

#### `executeReturnCount` without `RETURNING`

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('executeReturnCount reports the affected rows without RETURNING', async () => {
  const db = createTestDatabase();

  const insertedCount = await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_count (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL
      )
    `);

    return transactionDb
      .insert<{ name: string }>('test_count')
      .values({ name: 'Count Test' })
      .executeReturnCount();
  });

  expect(insertedCount).toBe(1);

  await db.disconnect();
});
```

| Terminal method | Without `.returning(...)` | With `.returning(...)` |
| --- | --- | --- |
| `.execute()` | `QueryResult` with empty `records`, `rowCount` reflects affected rows | `QueryResult` including returned rows |
| `.executeReturnSingle()` | `null` | First row, or `null` when nothing matched |
| `.executeReturnAll()` | `[]` | All returned rows |
| `.executeReturnCount()` | Affected row count | Affected row count |

### UPDATE Statements

Beyond the unit-level SQL assertions, integration tests verify multi-row updates with `RETURNING`:

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('executeReturnAll returns every updated row', async () => {
  const db = createTestDatabase();

  const updated = await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        active BOOLEAN DEFAULT true
      )
    `);

    await transactionDb.executeQuery(`
      INSERT INTO test_products (name, category) VALUES
        ('Item 1', 'Electronics'),
        ('Item 2', 'Electronics'),
        ('Item 3', 'Books')
    `);

    return transactionDb
      .update<{ active: boolean }, { category: string }>('test_products')
      .values({ active: false })
      .filter({ category: 'Electronics' })
      .returning('*')
      .executeReturnAll();
  });

  expect(updated).toHaveLength(2);
  expect(updated[0]).toMatchObject({ name: 'Item 1', active: false });
  expect(updated[1]).toMatchObject({ name: 'Item 2', active: false });

  await db.disconnect();
});
```

Pointer checks worth covering:

- Without a filter, `.values(...)` updates **every row** — assert the affected count explicitly.
- No-match filters: `executeReturnSingle()` → `null`, `executeReturnAll()` → `[]`, `executeReturnCount()` → `0`.
- `filterByExpression()` replaces `filter()` for complex WHERE conditions (unit example above); WHERE parameters arrive as `p1`, `p2`, … alongside the `v_`-prefixed value parameters.

### DELETE Statements

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('deletes only matching rows and reports the count', async () => {
  const db = createTestDatabase();

  const deletedCount = await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_delete (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL
      )
    `);

    await transactionDb.executeQuery(`
      INSERT INTO test_delete (name, category) VALUES
        ('Count Test 1', 'Count Category'),
        ('Count Test 2', 'Count Category'),
        ('Count Test 3', 'Other Category')
    `);

    return transactionDb
      .delete<{ category: string }>('test_delete')
      .filter({ category: 'Count Category' })
      .executeReturnCount();
  });

  expect(deletedCount).toBe(2);

  await db.disconnect();
});
```

#### No-match semantics (`null` / `[]` / `0`)

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('returns empty results when nothing matches', async () => {
  const db = createTestDatabase();

  const result = await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_no_match (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL
      )
    `);

    const single = await transactionDb
      .delete<{ name: string }>('test_no_match')
      .filter({ name: 'NonExistent' })
      .returning('*')
      .executeReturnSingle();

    const all = await transactionDb
      .delete<{ name: string }>('test_no_match')
      .filter({ name: 'NonExistent' })
      .returning('*')
      .executeReturnAll();

    const count = await transactionDb
      .delete<{ name: string }>('test_no_match')
      .filter({ name: 'NonExistent' })
      .executeReturnCount();

    return { single, all, count };
  });

  expect(result.single).toBeNull();
  expect(result.all).toEqual([]);
  expect(result.count).toBe(0);

  await db.disconnect();
});
```

> An empty filter (`.filter({})`) is a bulk delete with no `WHERE` clause. Assert it deliberately — never by accident.

### Query Hooks

What to verify: parameters are transformed before translation, rows are transformed before leaving the adapter, and hook errors abort (and roll back) the statement.

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

interface HookTestUser {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
  role?: string;
  created_at?: Date;
}

test('normalizes parameters in beforeQuery and redacts fields in afterQuery', async () => {
  const db = createTestDatabase();

  const created = await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_hooks (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255),
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    return transactionDb
      .insert<HookTestUser>('test_hooks')
      .values({
        name: 'Combined Test',
        email: 'COMBINED@EXAMPLE.COM',
        password_hash: 'plaintext123',
        role: 'admin',
      })
      .beforeQuery(params => {
        const email = params.email;
        if (typeof email === 'string') {
          params.email = email.toLowerCase();
        }

        const passwordHash = params.password_hash;
        if (typeof passwordHash === 'string') {
          params.password_hash = `bcrypt_${passwordHash}`;
        }

        return params;
      })
      .afterQuery(records =>
        records.map(record => {
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
  expect(created?.id).toBeDefined();
  expect(created?.created_at).toBeDefined();
  expect(created).not.toHaveProperty('password_hash');

  await db.disconnect();
});
```

#### Hook errors propagate

```typescript
import { expect, test } from 'vitest';
import { createTestDatabase } from './helpers.js';

test('propagates hook errors and rolls the transaction back', async () => {
  const db = createTestDatabase();

  await expect(
    db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_hook_error (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        )
      `);

      await transactionDb
        .insert<{ name: string }>('test_hook_error')
        .values({ name: 'Error Test' })
        .beforeQuery(() => {
          throw new Error('BeforeQuery hook error');
        })
        .execute();
    })
  ).rejects.toThrow('BeforeQuery hook error');

  await db.disconnect();
});
```

Parameter naming inside hooks (from the package's `tests/hooks.test.ts`):

| Statement | `beforeQuery` parameter names |
| --- | --- |
| INSERT | Column names (`params.email`, `params.password_hash`) |
| UPDATE | SET values as `v_<column>` (`params.v_password_hash`), WHERE parameters as `p1`, `p2`, … |
| DELETE | WHERE parameters as `p1`, `p2`, … (indexes depend on filter key order — write defensively) |

`afterQuery` receives the raw driver rows and must return an array; it runs before `executeReturnSingle()` / `executeReturnAll()` assemble their results, so both see the transformed rows.

### SELECT Builders and Expression Filters

`PostgreSQLDatabase` inherits the `from()` / `select()` / `byExpression()` SELECT builders from `blendsdk/dbcore`, and they chain with compiled expressions from `blendsdk/expression`:

```typescript
import { expect, test } from 'vitest';
import { query } from 'blendsdk/expression';
import { createTestDatabase } from './helpers.js';

interface ExpressionUser {
  id?: number;
  name: string;
  age?: number;
}

test('filters a select with a compiled expression', async () => {
  const db = createTestDatabase();

  const result = await db.withTransaction(async transactionDb => {
    await transactionDb.executeQuery(`
      CREATE TEMP TABLE test_expression_users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        age INTEGER
      )
    `);

    await transactionDb.executeQuery(`
      INSERT INTO test_expression_users (name, age) VALUES
        ('Young Adult', 25),
        ('Senior', 70)
    `);

    const expression = query<ExpressionUser>().where('age').greaterThan(30).compile();

    return transactionDb
      .from<ExpressionUser>('test_expression_users')
      .select()
      .byExpression(expression)
      .execute();
  });

  expect(result.rowCount).toBe(1);
  expect(result.records[0]).toMatchObject({ name: 'Senior', age: 70 });

  await db.disconnect();
});
```

- `.execute()` is the simplest path. The package's `tests/from.test.ts` also retrieves the generated SQL via the protected `buildQuery()` / `buildParameters()` and runs it through `executeQuery(query, params)` — use that when a test needs to assert or modify the SQL text before execution.
- `update()` and `delete()` support `filterByExpression()` for the same expression compiler (see the unit examples above); expression parameters are always named `p1`, `p2`, ….

### Graceful Shutdown

What to verify: in-flight guards, configurable timeouts, and that signal handlers are only wired up when explicitly requested.

```typescript
import { expect, test, vi } from 'vitest';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { createTestDatabase } from './helpers.js';
import { connectionConfig } from './params.js';

test('rejects new work once shutdown has started', async () => {
  const db = createTestDatabase();
  const disconnectPromise = db.disconnect();

  await expect(db.executeQuery('SELECT 1')).rejects.toThrow(
    'Cannot execute query: database is shutting down'
  );
  await expect(db.withTransaction(async () => true)).rejects.toThrow(
    'Cannot start transaction: database is shutting down'
  );

  await disconnectPromise;
});

test('accepts a custom disconnect timeout', async () => {
  const db = createTestDatabase();
  await db.executeQuery('SELECT 1');
  await expect(db.disconnect(5000)).resolves.not.toThrow();
});

test('registers signal handlers only when graceful shutdown is enabled', () => {
  const processOnSpy = vi.spyOn(process, 'on').mockImplementation(() => process);

  new PostgreSQLDatabase({ ...connectionConfig, enableGracefulShutdown: true });

  expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

  processOnSpy.mockRestore();
});
```

- Always mock `process.on` before enabling `enableGracefulShutdown: true` in a test: the constructor installs real signal handlers that call `process.exit()`. The spy above intercepts the registration.
- `disconnect()` sets the shutdown flag synchronously, which is why the guard assertions work immediately after the `disconnect()` call.
- ⚠️ In non-test code, never enable `enableGracefulShutdown` when a `blendsdk/webafx` WebApplication owns the database — both install `SIGINT` / `SIGTERM` handling, which causes signal-handler conflicts.

---

For the concepts these patterns exercise in depth, see Core Concepts and the Overview.

---

# postgresql Troubleshooting

This document catalogs the errors you are most likely to hit when using `blendsdk/postgresql`, how to diagnose them, and the behaviors that silently mislead. Errors thrown by the adapter itself are quoted verbatim from the source; errors from the PostgreSQL server or the `pg` driver are shown with their typical runtime values (`host`, `user`, table names) in place. For the underlying mechanics referenced here — the pinned transaction client, the shutdown flag, and the statement hooks — see Core Concepts.

---

## Common Errors

The adapter itself throws only a small, fixed set of messages. If you see one of these, the error is coming from `blendsdk/postgresql` and not from the server or the driver:

| Exact message | Emitted by |
| --- | --- |
| `Cannot execute query: database is shutting down` | `executeQuery()` after `disconnect()` has started |
| `Cannot start transaction: database is shutting down` | `withTransaction()` after `disconnect()` has started |
| `No database connection available.` | `executeQuery()` internal guard (defensive; rarely seen) |
| `Cannot build INSERT statement for table "<name>": no values provided. Call .values() with at least one column before executing.` | `PostgreSQLInsertStatement.buildQuery()` |
| `Cannot build UPDATE statement for table "<name>": no values provided. Call .values() with at least one column before executing.` | `PostgreSQLUpdateStatement.buildQuery()` |
| `Error during transaction rollback:` | `withTransaction()` cleanup (logged with the underlying error) |
| `Error releasing transaction client:` | `withTransaction()` cleanup (logged with the underlying error) |
| `Error releasing query client:` | `executeQuery()` cleanup (logged with the underlying error) |
| `Received <signal>. Closing database connections...` / `Database connections closed successfully.` | shutdown handlers registered by `enableGracefulShutdown` |
| `Error during graceful shutdown:` | shutdown handlers registered by `enableGracefulShutdown` |

Everything else you encounter originates from the PostgreSQL server, the `pg` driver, the `yesql` parameter translator, or the TypeScript compiler.

---

### Connection and Authentication Errors

#### `connect ECONNREFUSED 127.0.0.1:5432`

**Symptom** — The first query rejects with a driver error containing the resolved host and port, for example `Error: connect ECONNREFUSED 127.0.0.1:5432`. A wrong hostname instead produces `Error: getaddrinfo ENOTFOUND db.internal`. Note that constructing `new PostgreSQLDatabase(config)` never throws — the pool connects lazily, so the failure surfaces on the first `executeQuery()` or `withTransaction()` call.

**Cause** — Nothing accepts TCP connections on the configured `host` / `port`: the server is not running, is bound to a different interface, the hostname does not resolve, or (in the repository test setup) the Docker container is not up.

**Fix**

1. Confirm that a server is listening at the configured address, using the same host and port your configuration uses.
2. Correct the `host` and `port` values in `PostgreSQLConfig` — remember `port` also accepts a numeric string, so `'5599'` and `5599` both work.
3. Re-run a minimal smoke test and keep the error text; `ECONNREFUSED` means "wrong address or server down", while authentication errors (next section) mean "server reached, credentials rejected".

```bash
pg_isready -h localhost -p 5432
```

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function smokeTest(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records } = await db.executeQuery<{ ok: number }>('SELECT 1 AS ok');
    console.log('Connection OK:', records[0].ok);
  } catch (error) {
    console.error('Connection failed:', error instanceof Error ? error.message : String(error));
  } finally {
    await db.disconnect();
  }
}

void smokeTest();
```

---

#### `password authentication failed for user "app_user"`

**Symptom** — One of the server's credential errors is propagated unchanged by the driver:

- `password authentication failed for user "app_user"`
- `role "app_user" does not exist`
- `database "appdb" does not exist`

**Cause** — The values in `PostgreSQLConfig` do not match the server. The most common trap: the configuration key is **`pass`**, not `password`. The adapter reads exactly `database`, `host`, `pass`, `port`, and `user` from the config and maps `pass` to the driver's `password` option. If you write `password:` in an object literal, strict mode rejects it with an excess-property error when the object is checked as `PostgreSQLConfig`. If the object escapes that check (for example it is stored in a wider variable type first), the password arrives as `undefined` and the server answers with `password authentication failed`.

**Fix**

1. Rename the key to `pass` and re-run the smoke test.
2. Verify the credentials independently with `psql` before blaming the adapter.
3. If the messages are `role ... does not exist` or `database ... does not exist`, the credentials are fine but the role or database must be created, or the names corrected.
4. If credentials are definitely correct, confirm the server's authentication configuration (`pg_hba.conf`) allows password authentication for your client host.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'db.internal',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret', // not `password`
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { rowCount } = await db.executeQuery('SELECT 1');
    console.log(`Authenticated, rowCount=${rowCount}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

#### `timeout exceeded when trying to connect` — and queries that never settle

**Symptom** — Two opposite behaviors depending on `poolConfig.connectionTimeoutMillis`:

- **Set** — the pool rejects with `timeout exceeded when trying to connect` after the configured number of milliseconds.
- **Unset (the default, `0`)** — the query promise **never settles** because the pool waits forever for a free client or a hanging connect attempt.

**Cause** — The pool is exhausted (all `max` clients are checked out) or the server is unreachable/slow. Leaked clients are the usual source of exhaustion:

- A raw client obtained via `db.connect()` that was never released with `client.release()`.
- A transaction that never resolves, so its pinned client is never returned.
- Instances that are never passed to `disconnect()`.

**Fix**

1. Always set `connectionTimeoutMillis` explicitly so failures surface fast instead of hanging.
2. Audit every `db.connect()` call — the adapter releases clients it checked out itself, but a client you obtain manually is yours to release.
3. Run the `pg_stat_activity` inspection from [Debugging Strategies](#5-inspect-live-sessions-with-pg_stat_activity) to see how many sessions the pool actually holds.
4. Only after fixing leaks, consider raising `max`.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'db.internal',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
  poolConfig: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000, // fail fast instead of waiting forever
  },
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records } = await db.executeQuery<{ ok: number }>('SELECT 1 AS ok');
    console.log(`Pool ready: ${records[0].ok}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### Shutdown and Lifecycle Errors

#### `Cannot execute query: database is shutting down` / `Cannot start transaction: database is shutting down`

**Symptom** — After `disconnect()` has been called, any further query rejects with `Cannot execute query: database is shutting down`, and any further transaction with `Cannot start transaction: database is shutting down`. Both guards fire immediately — even while `disconnect()` is still draining the pool — because the internal shutdown flag is set before `pool.end()` runs.

**Cause** — Work was scheduled or left running that outlives the shutdown decision: a background interval, an un-awaited statement, a signal-triggered handler racing application code, or a test that reuses an instance after tearing it down. A related defensive guard, `No database connection available.`, indicates the internal client slot was disturbed — in practice, recreate the instance if you ever see it.

**Fix**

1. Enforce a strict shutdown order: stop producing new work → await everything in flight → call `disconnect()` last.
2. Never reuse an instance after `disconnect()` — the flag and the closed pool are permanent; construct a new `PostgreSQLDatabase` if work must continue.
3. Inside transactions, always `await` every statement; a fire-and-forget promise can resolve after the transaction ends and then race shutdown.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);

  // 1. All in-flight work is awaited while the database still accepts queries.
  const inFlight: Promise<void>[] = [
    db.executeQuery('SELECT 1').then(() => undefined),
  ];
  await Promise.all(inFlight);

  // 2. Shutdown begins only after the drain.
  await db.disconnect();

  try {
    await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery('SELECT 2');
    });
  } catch (error) {
    // Cannot start transaction: database is shutting down
    console.error(error instanceof Error ? error.message : String(error));
  }
}

void main();
```

---

#### `Error during transaction rollback:` / `Error releasing transaction client:` / `Error releasing query client:`

**Symptom** — Your operation rejects with its original error, but stderr additionally shows one of these prefixed messages together with the underlying failure, for example:

```text
Error during transaction rollback: Error: Connection terminated unexpectedly
```

**Cause** — The cleanup step itself failed because the connection was already gone: the server restarted, the network dropped, or connections were force-closed during shutdown. The adapter deliberately logs these cleanup failures instead of throwing them, so they never mask the original error.

**Fix**

1. Treat the original thrown error as authoritative — the rollback/release message is diagnostic context, not the failure itself.
2. If these messages appear frequently, the problem is connection stability, not transaction logic: check server restarts, idle timeouts, and network paths.
3. Do not retry a transaction that failed with connection-level errors without first verifying the server is reachable.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery('SELECT :value AS value', { value: 1 });
      throw new Error('business rule violation');
    });
  } catch (error) {
    // The original error is always rethrown, even if the ROLLBACK itself
    // logged "Error during transaction rollback:" to the console.
    console.error('Transaction failed:', error instanceof Error ? error.message : String(error));
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

#### `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 SIGINT listeners added to [process].`

**Symptom** — Node prints this warning (and a `SIGTERM` equivalent) once the process has accumulated more than ten listeners. Combined with `enableGracefulShutdown: true`, shutdown behavior becomes unpredictable because multiple registered handlers all run `disconnect()` and `process.exit()`.

**Cause** — Every `PostgreSQLDatabase` constructed with `enableGracefulShutdown: true` registers a `SIGINT` **and** a `SIGTERM` listener, and these are never removed. Creating databases per request, per test, or per worker multiplies the listeners.

**Fix**

1. Enable `enableGracefulShutdown` only for a single, long-lived, standalone instance.
2. If your process already owns signal handling — including any `blendsdk/webafx` WebApplication — leave the flag off and call `disconnect()` from your own handler.
3. Use `process.once` (not `process.on`) so repeated signals cannot re-run the drain.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
  // Keep this off when the process (or blendsdk/webafx) owns signal handling.
  enableGracefulShutdown: false,
};

const db = new PostgreSQLDatabase(config);

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}. Draining database pool...`);
  await db.disconnect();
  console.log('Database pool drained.');
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  const { records } = await db.executeQuery<{ now: Date }>('SELECT now() AS now');
  console.log('Server time:', records[0].now.toISOString());
}

void main();
```

---

#### Graceful shutdown conflicts with `blendsdk/webafx`

**Symptom** — With a database managed by a `WebApplication` from `blendsdk/webafx`, shutdown becomes unpredictable: the process may exit before the web server drains, or two teardown sequences interleave.

**Cause** — This is documented behavior in the adapter itself: `blendsdk/webafx` installs its own `SIGINT` / `SIGTERM` handling, and the adapter's `enableGracefulShutdown` handler additionally calls `disconnect()` **and** `process.exit(0)` on success / `process.exit(1)` on failure. Enabling both creates signal-handler conflicts.

**Fix**

1. Keep `enableGracefulShutdown` at its default (`false`) whenever the database is owned by a WebApplication.
2. Let the framework's shutdown sequence drive `db.disconnect()` (or explicitly call it in the application's own teardown after requests have drained).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
  // A blendsdk/webafx WebApplication owns SIGINT/SIGTERM: leave this off so
  // exactly one shutdown path exists.
  enableGracefulShutdown: false,
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records } = await db.executeQuery<{ ok: number }>('SELECT 1 AS ok');
    console.log(records[0].ok);
  } finally {
    // Under blendsdk/webafx this step is driven by the application's
    // shutdown sequence instead.
    await db.disconnect();
  }
}

void main();
```

---

### Statement Builder Errors

#### `Cannot build INSERT statement for table "users": no values provided. Call .values() with at least one column before executing.`

**Symptom** — Executing an INSERT builder that never received values — or received an empty object — rejects with exactly this message (`"users"` is replaced with your table name).

**Cause** — `PostgreSQLInsertStatement.buildQuery()` validates at build time: `Object.keys(this._values).length === 0` throws, because a column-less `INSERT INTO users () VALUES ()` is invalid SQL. The check is on the **number of keys**; the message fires when you call `.execute()`, `.executeReturnSingle()`, `.executeReturnAll()`, or `.executeReturnCount()` on such a builder.

**Fix**

1. Always call `.values()` with at least one column before executing.
2. When values are assembled dynamically, build the object first and branch on `Object.keys(...)` — do not execute an empty builder and rely on the error as a control flow signal.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface AuditLog {
  id?: number;
  message: string;
  created_at?: Date;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function insertAudit(db: PostgreSQLDatabase, message: string | null): Promise<void> {
  if (message === null) {
    console.log('Nothing to log');
    return;
  }

  const created = await db
    .insert<AuditLog>('audit_log')
    .values({ message })
    .returning('*')
    .executeReturnSingle();

  if (created !== null) {
    console.log(`Logged entry #${created.id}`);
  }
}

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    await insertAudit(db, 'user signed in');
    await insertAudit(db, null);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

#### `Cannot build UPDATE statement for table "users": no values provided. Call .values() with at least one column before executing.`

**Symptom** — Same message pattern as INSERT, for `PostgreSQLUpdateStatement`. A filter does **not** satisfy the requirement: `.values({}).filter({ id: 1 }).executeReturnCount()` still throws.

**Cause** — `PostgreSQLUpdateStatement.buildQuery()` throws when the values object has zero keys, because `UPDATE users SET` with no assignments is invalid SQL.

**Fix**

1. Build the partial update object first and abort when it is empty.
2. Only attach it to the builder when at least one column will actually change — this also avoids pointless rows-affected counts.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
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
  user: 'app_user',
  pass: 'secret',
};

async function deactivate(db: PostgreSQLDatabase, email: string): Promise<number> {
  const changes: Partial<User> = { active: false };

  if (Object.keys(changes).length === 0) {
    console.log('Nothing to update');
    return 0;
  }

  return db
    .update<User, UserFilter>('users')
    .values(changes)
    .filter({ email })
    .executeReturnCount();
}

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const updated = await deactivate(db, 'ada@example.com');
    console.log(`Rows updated: ${updated}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### SQL and Parameter Errors

#### `error: syntax error at or near ":"`

**Symptom** — PostgreSQL rejects a statement containing `:name` placeholders: `error: syntax error at or near ":"`.

**Cause** — Named parameters are translated to positional parameters (`$1`, `$2`, …) by `yesql`, and that translation only happens inside `executeQuery()` (and therefore inside everything built on it, including the statement builders and transactions). A raw client obtained from `db.connect()` is a plain `pg` client: its `query()` method sends the text verbatim, so `:name` reaches the server untouched.

**Fix**

1. Route any SQL containing `:name` placeholders through `db.executeQuery()` — never through a raw client or an external tool.
2. If you intentionally use the raw client from `db.connect()`, switch to `$1`-style positional parameters and release the client yourself when done.
3. Keep parameter keys spelled exactly like the placeholders (the lookup is by name, case-sensitive).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  const client = await db.connect();
  try {
    // Named parameters only work through executeQuery().
    const { records } = await db.executeQuery<{ name: string }>(
      'SELECT :name AS name',
      { name: 'Ada' }
    );
    console.log(records[0].name);

    // A raw client from connect() needs positional parameters instead.
    const result = await client.query<{ name: string }>('SELECT $1::text AS name', ['Ada']);
    console.log(result.rows[0].name);
  } finally {
    client.release();
    await db.disconnect();
  }
}

void main();
```

---

#### `error: relation "users" does not exist`

**Symptom** — A server error such as `error: relation "users" does not exist` (SQLSTATE 42P01), or its sibling `error: column "nmae" does not exist` (42703).

**Cause** — One of three things:

1. The table/column genuinely does not exist in the connected database, or lives in a different schema than the one on the session's `search_path`.
2. **Identifier folding** — unquoted identifiers are folded to lowercase by PostgreSQL. A table created as `"Users"` (with quotes, preserving case) is invisible to `FROM Users`, and the statement builders interpolate `tableName` into the SQL verbatim and without quotes.
3. **Session-bound objects** — a `TEMP` table was created on one pooled connection but a later query landed on a different connection that has never seen it.

**Fix**

1. Verify existence against the same database and schema your configuration points at: `\dt` in `psql`, or `SELECT * FROM information_schema.tables WHERE table_name = 'users'`.
2. Prefer lowercase `snake_case` identifiers — the safest path with the statement builders, which do not quote identifiers for you.
3. Schema-qualify when needed: `db.insert('public.users')`.
4. If a temporary table "disappears" between statements, keep its lifetime inside a single `withTransaction` block so all statements share the pinned client — see [Known Pitfalls](#temp-tables-and-session-state-live-on-one-pooled-connection).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    await db.withTransaction(async transactionDb => {
      // CREATE TEMP TABLE and every dependent statement run on the same pinned
      // client because the whole block is one transaction.
      await transactionDb.executeQuery(
        `CREATE TEMP TABLE staging_users (
           id SERIAL PRIMARY KEY,
           name VARCHAR(100) NOT NULL
         )`
      );
      await transactionDb.executeQuery(
        'INSERT INTO staging_users (name) VALUES (:name)',
        { name: 'Ada Lovelace' }
      );
      const { records } = await transactionDb.executeQuery<{ name: string }>(
        'SELECT name FROM staging_users'
      );
      console.log(records[0].name);
    });
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

#### `error: duplicate key value violates unique constraint "users_email_key"`

**Symptom** — The insert or update rejects with the server's unique-violation message; SQLSTATE is `23505` and `error.constraint` holds the constraint name.

**Cause** — A unique constraint (or unique index) was violated. This is normal server-side validation; the adapter simply propagates the driver's error, and inside a transaction it triggers the automatic `ROLLBACK`.

**Fix**

1. Decide per use case: pre-check with a `SELECT`, treat the error as the signal (idempotent "create if absent" flows), or switch to `INSERT ... ON CONFLICT` — the fluent builders do not model `ON CONFLICT`, so use `executeQuery()` for upserts.
2. When catching, inspect `error.code` (SQLSTATE) rather than matching message text, which varies with server locale and version.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

interface PgErrorShape extends Error {
  code?: string;
  constraint?: string;
}

function isPgError(error: unknown): error is PgErrorShape {
  return error instanceof Error;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    await db
      .insert<User>('users')
      .values({ name: 'Ada', email: 'ada@example.com' })
      .execute();
    console.log('User created');
  } catch (error) {
    if (isPgError(error) && error.code === '23505') {
      console.log(`Duplicate value on constraint ${error.constraint ?? 'unknown'}`);
    } else {
      throw error;
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

#### Filters with `null` never match

**Symptom** — A `.filter({ email: null })` (or any equality on `null`) silently affects zero rows: `rowCount` is `0`, `executeReturnSingle()` resolves `null`, `executeReturnCount()` returns `0`. No error is raised.

**Cause** — `.filter()` compiles equality expressions like `email = :p1`, and SQL's three-valued logic makes `email = NULL` evaluate to `NULL` — never `TRUE` — no matter what the column contains. Matching `NULL` requires the dedicated `IS NULL` / `IS NOT NULL` predicates.

**Fix**

1. Use `filterByExpression()` with `.isNull()` / `.isNotNull()` for null checks instead of equality filters.
2. For inserts and updates, do not rely on implicit `undefined`-to-`NULL` conversion; normalize `undefined` to `null` in a `beforeQuery` hook so the intent is explicit (the hooks pattern is shown in [Core Concepts](usage.md#query-hooks)).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email: string | null;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const purged = await db
      .delete<User>('users')
      .filterByExpression(q => q.where('email').isNull())
      .executeReturnCount();

    console.log(`Purged ${purged} row(s) without an email`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### TypeScript Compiler Errors

#### `TS18046: 'record' is of type 'unknown'.` — missing type arguments

**Symptom** — Reading fields off a result fails to compile: `TS18046: 'record' is of type 'unknown'.` Building a column list dynamically for `.returning(...)` fails as well, because the expected element type collapses to `never`.

**Cause** — `insert<T>()`, `update<T, F>()`, and `delete<F>()` have no inference site for their type parameters. Calling them without explicit type arguments leaves `T` (and `F`) as `unknown`, so results are `unknown | null` and `keyof T` is `never`.

**Fix** — Always state the types at the factory call: `db.insert<User>(...)`, `db.update<User, UserFilter>(...)`, `db.delete<UserFilter>(...)`.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const created = await db
      .insert<User>('users')
      .values({ name: 'Ada Lovelace', email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (created !== null) {
      console.log(`Inserted user #${created.id} (${created.name})`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

#### `.returning([...])` — `string[]` is not assignable to `(keyof T)[]`

**Symptom** — Passing a dynamically built array of column names to `.returning()` is rejected: the compiler reports that `string[]` is not assignable to the `keyof T` array parameter.

**Cause** — `.returning()` accepts `'*'` or an array of **table keys** (`keyof T`). A plain `string[]` variable is wider than that, so TypeScript refuses the assignment even though every element is a valid column at runtime.

**Fix** — Type the array (or the constant) as `(keyof T)[]` and populate it with key literals. This keeps compile-time checking instead of casting.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
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
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const columns: (keyof User)[] = ['id', 'name', 'email'];

    const updated = await db
      .update<User, UserFilter>('users')
      .values({ active: false })
      .filter({ email: 'ada@example.com' })
      .returning(columns)
      .executeReturnSingle();

    if (updated !== null) {
      console.log(`Updated user #${updated.id} (${updated.name})`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

#### `TS18047: 'created' is possibly 'null'.`

**Symptom** — Accessing a field on the result of `executeReturnSingle()` fails to compile with `TS18047: 'created' is possibly 'null'.`

**Cause** — All `executeReturnSingle()` methods are typed to resolve to `T | null`, because a statement can legitimately match zero rows (no match on UPDATE/DELETE, empty `RETURNING` output, and so on). This is deliberate: the null result is the "no rows" signal.

**Fix** — Guard before use, or map the result to a default. Do not use non-null assertions (`!`) — they turn a normal "no match" outcome into a runtime crash.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const created = await db
      .insert<User>('users')
      .values({ name: 'Ada Lovelace', email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (created === null) {
      console.log('Nothing was inserted');
      return;
    }
    console.log(`Inserted user #${created.id} (${created.email})`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### Module and Runtime Setup Errors

#### `ERR_REQUIRE_ESM` / `Cannot use import statement outside a module` / `TS2307: Cannot find module 'blendsdk/postgresql'`

**Symptom** — The package fails to load or resolve:

- `Error [ERR_REQUIRE_ESM]: require() of ES Module .../dist/index.js from .../main.cjs not supported.`
- `SyntaxError: Cannot use import statement outside a module`
- `TS2307: Cannot find module 'blendsdk/postgresql' or its corresponding type declarations.`

**Cause** — `blendsdk/postgresql` is ESM-only: `"type": "module"` and an export map whose only condition is `import` (`types` + `import` pointing at `dist/`). A CommonJS consumer, a `require()` call, or a TypeScript `moduleResolution` mode that predates `exports` maps cannot resolve it. The package also targets Node.js >= 22.

**Fix**

1. Run on Node.js >= 22.
2. Mark the consuming project as ESM and compile with `NodeNext` resolution.
3. Use only ESM `import` statements — never `require()` — and reference the package by name, not by `dist` paths.

```json
{
  "name": "my-service",
  "type": "module",
  "private": true
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true
  }
}
```

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records } = await db.executeQuery<{ version: string }>('SELECT version() AS version');
    console.log(records[0].version);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## Debugging Strategies

The procedures below go from cheapest to most involved. Each one is actionable on its own; combine them when a failure is not obvious.

---

### 1. Classify the failure first

1. Run a minimal smoke test with the **real configuration** (the `SELECT 1` program shown under `connect ECONNREFUSED`).
2. If the smoke test fails with a driver error, you have a connection/credential problem — go straight to the matching entry in [Common Errors](#common-errors).
3. If the smoke test passes, network and credentials are fine; the fault is in the statement's SQL text, its parameters, or server-side schema/constraints.
4. Bisect by replacing the failing builder chain with an equivalent `executeQuery()` call (or run the SQL in `psql`): if raw SQL works but the builder fails, the problem is in the rendering; if both fail, it is the database.

---

### 2. Render statements without executing them

Statement builders are pure at build time: `buildQuery()` produces the SQL text and `buildParameters()` produces the parameter object. No example in this section needs a reachable database (which is exactly how the repository's `yarn test:fast` suite validates them). To inspect a builder outside the test suite, expose the protected methods through a subclass — no casts required.

```typescript
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLInsertStatement,
} from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
}

class InspectableInsert<TableType> extends PostgreSQLInsertStatement<TableType> {
  public renderQuery(): string {
    return this.buildQuery();
  }

  public renderParameters(): Record<string, unknown> {
    return this.buildParameters();
  }
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function inspect(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const statement = new InspectableInsert<User>('users', db);
    statement.values({ name: 'Ada', email: 'ada@example.com' }).returning('*');

    console.log(statement.renderQuery());
    // INSERT INTO users (name, email) VALUES (:name, :email) RETURNING *

    console.log(statement.renderParameters());
    // { name: 'Ada', email: 'ada@example.com' }
  } finally {
    await db.disconnect();
  }
}

void inspect();
```

The same pattern works for `PostgreSQLUpdateStatement` and `PostgreSQLDeleteStatement`.

---

### 3. Trace parameters and timing with a query wrapper

Wrap `executeQuery()` in a helper that logs the SQL, elapsed time, row count, and the error message. Because everything — including statement builders and transactions — funnels through `executeQuery()`, one wrapper traces all traffic. Keep secrets out of logs; log only what you need.

```typescript
import {
  PostgreSQLConfig,
  PostgreSQLDatabase,
  PostgreSQLQueryResult,
} from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function tracedQuery<Row>(
  db: PostgreSQLDatabase,
  sql: string,
  params: Record<string, unknown> = {}
): Promise<PostgreSQLQueryResult<Row>> {
  const startedAt = Date.now();
  try {
    const result = await db.executeQuery<Row>(sql, params);
    console.log(`OK    ${Date.now() - startedAt} ms  rows=${result.rowCount}  ${sql}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL  ${Date.now() - startedAt} ms  ${sql} -> ${message}`);
    throw error;
  }
}

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    await tracedQuery<{ name: string }>(db, 'SELECT :name AS name', { name: 'Ada' });
  } finally {
    await db.disconnect();
  }
}

void main();
```

For statements and hooks, the same idea applies with `beforeQuery` (log the parameter object right before execution) — remember the per-statement key naming described in [Known Pitfalls](#hook-parameter-names-differ-per-statement-type).

---

### 4. Decode PostgreSQL errors by SQLSTATE

1. Catch the error and read its `code` property:
   - PostgreSQL **server** errors use SQLSTATE strings (e.g. `'23505'`) and may carry `constraint`, `table`, `column`, and `detail`.
   - Node/`pg` **connection** errors reuse `code` for system errno values (e.g. `'ECONNREFUSED'`).
2. Branch on codes, never on message text — the wording changes with server locale and version.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface PgErrorShape extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
}

function isPgError(error: unknown): error is PgErrorShape {
  return error instanceof Error;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    await db.executeQuery('INSERT INTO users (email) VALUES (:email)', {
      email: 'ada@example.com',
    });
  } catch (error) {
    if (isPgError(error)) {
      console.error(`SQLSTATE ${error.code ?? 'unknown'}: ${error.message}`);
      if (error.constraint !== undefined) {
        console.error(`Violated constraint: ${error.constraint}`);
      }
    } else {
      console.error('Non-database failure:', error);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

The codes you will meet most often:

| SQLSTATE | Name | Typical message start |
| --- | --- | --- |
| `28P01` | `invalid_password` | `password authentication failed for user "..."` |
| `3D000` | `invalid_catalog_name` | `database "..." does not exist` |
| `42P01` | `undefined_table` | `relation "..." does not exist` |
| `42703` | `undefined_column` | `column "..." does not exist` |
| `23505` | `unique_violation` | `duplicate key value violates unique constraint "..."` |
| `23503` | `foreign_key_violation` | `insert or update on table "..." violates foreign key constraint "..."` |
| `23502` | `not_null_violation` | `null value in column "..." of relation "..." violates not-null constraint` |
| `22001` | `string_data_right_truncation` | `value too long for type character varying(n)` |
| `57014` | `query_canceled` | `canceling statement due to statement timeout` |
| `08006` | `connection_failure` | `Connection terminated unexpectedly` |

---

### 5. Inspect live sessions with `pg_stat_activity`

When queries hang, pools exhaust, or shutdown misbehaves, look at what the server thinks your connections are doing. Run this through the adapter itself:

1. Check for `state = 'idle in transaction'` — those sessions are holding a pinned client and a transaction open; frequent occurrences point at nested `withTransaction()` misuse or un-awaited statements.
2. Check whether the total session count approaches your pool `max` while the application is idle — that indicates leaked clients.
3. Check `wait_event_type = 'Lock'` — your query is blocked by another transaction, not by the adapter.
4. Check large `query_age` values on `state = 'active'` — a slow query is occupying a client.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface ActivityRow {
  pid: number;
  state: string | null;
  wait_event_type: string | null;
  query_age: string;
  query: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const { records } = await db.executeQuery<ActivityRow>(
      `SELECT pid,
              state,
              wait_event_type,
              (now() - query_start)::text AS query_age,
              query
         FROM pg_stat_activity
        WHERE datname = current_database()
        ORDER BY query_start`
    );

    for (const row of records) {
      console.log(
        `pid=${row.pid} state=${row.state ?? 'n/a'} ` +
          `wait=${row.wait_event_type ?? 'n/a'} age=${row.query_age}`
      );
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### 6. Reproduce in the repository sandbox

The package ships its own PostgreSQL sandbox and a database-free test suite; use them to decide whether a failure is environmental.

1. Start the containerized PostgreSQL (the tests connect to `localhost:5599` with `testdb`/`testdb`/`testdb`).
2. Run `yarn test:fast` — it exercises SQL generation only (`tests/statement-builders.test.ts`) and needs **no** database. If it passes, rendering is fine and your problem is runtime/database-side.
3. Open a `psql` session against the same instance to run the failing SQL by hand.
4. Follow the container logs when queries misbehave, and tear everything down (including the volume) when done.

```bash
# Run from packages/postgresql. Use only what each step needs.
yarn db:up            # start the PostgreSQL container (testdb on port 5599)
yarn test:fast        # SQL-generation tests; no database required
psql postgresql://testdb:testdb@localhost:5599/testdb
yarn db:logs          # follow container logs while reproducing
yarn db:down          # stop the container and remove the volume
```

---

## Known Pitfalls

These issues do not throw — they silently produce wrong results or flaky behavior, which makes them easy to miss in review and hard to trace in production.

---

### One instance equals one pinned-client slot

A `PostgreSQLDatabase` instance stores a single `transactionClient` field that is used both for transactions and for standalone queries:

- The `withTransaction()` callback receives **the same instance** (`transactionDb === db`), so any query issued through either name while the transaction is open joins the transaction.
- A **nested** `withTransaction()` call on the same instance issues a second `BEGIN`/`COMMIT` on the same client — the inner commit ends the outer transaction early, later statements run outside any transaction, and the outer commit becomes a no-op. The server typically logs warnings such as `there is already a transaction in progress`.
- **Concurrent** transactions on one instance share the pinned slot in the same way; use one instance per independent concurrent flow, or serialize.

Rule of thumb: within a transaction, only ever call statements on the provided `transactionDb`, always `await` them, and never start another `withTransaction()` until the outer one has resolved.

---

### Zero-row queries short-circuit: empty `fields`, skipped `afterQuery`

When a query returns or affects zero rows, `executeQuery()` stops early and resolves to exactly:

```text
{ records: [], rowCount: 0, fields: [] }
```

Two consequences are easy to miss:

- The optional `afterQuery` transformation is **not invoked** — do not place side effects (auditing, metrics) in `afterQuery` and expect them for empty result sets.
- `fields` is empty even though the statement has columns — never build column-dependent logic on `fields` without handling the zero-row case.

---

### `executeReturnSingle()` resolves `null` — and `RETURNING` gates record data

`executeReturnSingle()` does not throw on "no match"; it resolves `null` (`executeReturnAll()` resolves `[]`, `executeReturnCount()` resolves `0`). Additionally, the record-returning variants only yield actual row data when a `RETURNING` clause was attached with `.returning(...)`; without it there is nothing for PostgreSQL to send back. Treat `null` as a normal outcome and branch on it — see the [TS18047 fix](#ts18047-created-is-possibly-null).

---

### Hook parameter names differ per statement type

`beforeQuery` receives a plain parameter object whose keys depend on the statement kind — and on UPDATE/DELETE, filter parameters are named by the expression compiler (`p1`, `p2`, …), not by column name:

| Statement | Keys seen in `beforeQuery` | Example |
| --- | --- | --- |
| INSERT | column names | `params.email` |
| UPDATE | SET values prefixed with `v_`, plus `p1, p2, …` for the filter | `params.v_password_hash`, `params.p1` |
| DELETE | `p1, p2, …` for the filter only | `params.p1` |

A hook written for INSERT (`params.password_hash`) silently does nothing on UPDATE (which needs `params.v_password_hash`) — no error, unhashed secrets. The `p1`/`p2` indices also depend on filter key order, so hooks keyed on them are fragile; prefer transforming values where they originate, or use `filterByExpression` with explicit columns.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
  active?: boolean;
}

interface UserFilter {
  email?: string;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const updated = await db
      .update<User, UserFilter>('users')
      .values({ password_hash: 'new-secret' })
      .filter({ email: 'ada@example.com' })
      .beforeQuery((params: Record<string, unknown>) => {
        // UPDATE: SET values are `v_`-prefixed; filter values are p1, p2, ...
        const passwordHash = params.v_password_hash;
        if (typeof passwordHash === 'string') {
          params.v_password_hash = `hashed(${passwordHash})`;
        }
        return params;
      })
      .returning('*')
      .executeReturnSingle();

    if (updated !== null) {
      console.log(`Updated user #${updated.id}`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### `undefined` values and `NULL` filters

- A key with an `undefined` value still counts as a column: `Object.keys` includes it, so the generated INSERT/UPDATE contains the column and binds `undefined`. Normalize `undefined` to `null` in `beforeQuery` instead of relying on implicit driver conversion.
- Equality filters on `null` never match (SQL `= NULL` is not `TRUE`). Use `filterByExpression(q => q.where('col').isNull())` — see [Filters with `null` never match](#filters-with-null-never-match).

---

### Unfiltered `UPDATE` / `DELETE` touches every row

`db.delete('users').filter({})` produces `DELETE FROM users` — **with no `WHERE` clause** — and deletes every row. The same applies to an UPDATE without `.filter()`/`.filterByExpression()`. It is valid SQL and the builders do not guard it.

Guard destructive bulk operations in application code by refusing empty filters:

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserFilter {
  id?: number;
  active?: boolean;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function purge(db: PostgreSQLDatabase, filter: UserFilter): Promise<number> {
  if (Object.keys(filter).length === 0) {
    throw new Error('Refusing to execute DELETE without a filter');
  }
  return db.delete<UserFilter>('users').filter(filter).executeReturnCount();
}

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const purged = await purge(db, { active: false });
    console.log(`Purged ${purged} inactive row(s)`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

### Table names are interpolated — never accept them from user input

Column **values** are always bound as parameters, but the **table name** is concatenated verbatim into the SQL text (`INSERT INTO ${this.tableName} ...`). Passing a user-controlled table name is a SQL injection vector regardless of parameterization; keep table names as code constants or configuration values. When interpolating anything else into raw SQL, apply the same rule.

---

### `TEMP` tables and session state live on one pooled connection

`CREATE TEMP TABLE`, `SET` session variables, advisory locks, and prepared statements are bound to the specific pooled connection they ran on. Outside a transaction, consecutive `executeQuery()` calls may use different clients, so a temp table created in one call can be "missing" in the next (`relation does not exist`). Keep all dependent statements inside a single `withTransaction()` block so the pinned client services them all — the pattern is shown under [`error: relation "users" does not exist`](#error-relation-users-does-not-exist).

---

### Numeric values and `COUNT(*)` arrive as strings

The `pg` driver returns `NUMERIC` / `DECIMAL` / `BIGINT` — and therefore `COUNT(*)` — as **strings** (`'29.99'`, `'3'`), while `INTEGER` and `BOOLEAN` arrive as `number` / `boolean`. Type those interface fields as `string` and convert explicitly with `Number(...)` or `Number.parseInt(value, 10)`; comparisons like `record.count === 3` otherwise silently fail.

---

### `disconnect()` is permanent, and its timeout path is silent

- Once `disconnect()` is called, `isShuttingDown` stays set: the instance can never execute another query or transaction. If work must continue, create a new `PostgreSQLDatabase`.
- If the pool does not close within `timeoutMs` (default `10000`), the adapter force-releases the remaining clients and the call resolves **without an error**. A "successful" disconnect may therefore have interrupted active queries — only call it after draining in-flight work (see [the shutdown guard fix](#cannot-execute-query-database-is-shutting-down--cannot-start-transaction-database-is-shutting-down)).

---

### `enableGracefulShutdown` is easy to misuse

Three independent traps, all silent until shutdown day:

- Conflicts with `blendsdk/webafx`'s own signal handling (see [the webafx conflict entry](#graceful-shutdown-conflicts-with-blendsdkwebafx)).
- One pair of `SIGINT`/`SIGTERM` listeners per instance — creating many instances trips `MaxListenersExceededWarning` and makes multiple handlers race.
- The handler calls `process.exit(0)` / `process.exit(1)` immediately after `disconnect()`, skipping any other cleanup your process needs.

Enable it only for a single, long-lived standalone instance; otherwise own the signal handling yourself with `process.once`.

---

### INSERT hooks mutate the builder's stored values

For INSERT statements, `buildParameters()` returns the builder's internal values object itself. A `beforeQuery` hook that mutates its parameter object in place therefore changes the builder's stored state — re-executing the same builder applies the transformation to already-transformed values (for example, double-hashing a password). Prefer returning a copy: `return { ...params, email: String(params.email).toLowerCase() };`. UPDATE and DELETE rebuild their parameter objects on every call, so they do not have this trap.

---

### Unaliased expressions get the name `?column?`

PostgreSQL names anonymous expressions `?column?`, and `pg` faithfully surfaces that key. `SELECT 1` yields `{ '?column?': 1 }` in `records[0]`. Always alias computed columns (`SELECT 1 AS answer`, `SELECT COUNT(*) AS item_count`) so record keys are stable and typed interfaces actually match.

---

For the full behavioral reference behind these entries — lifecycle, hooks, and statement builders — see Core Concepts and the Overview.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
