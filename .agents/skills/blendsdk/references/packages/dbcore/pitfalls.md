> **Package**: `blendsdk/dbcore`

# dbcore Best Practices

`blendsdk/dbcore` gives you typed query construction, but it is deliberately thin: it renders whatever statement you describe — including an unscoped `DELETE` — and it trusts you with identifiers and transaction scope. This document collects the practices that keep that flexibility safe and fast. Examples that execute CRUD statements receive a `db: Database` parameter (or a data service instance), because the CRUD builders are abstract and supplied by a concrete adapter — see Core Concepts.

---

## Do / Don't Pairs

Each pair shows the problematic form first and the recommended form second, followed by the reason the wrong form fails. Some wrong examples are intentionally non-compliant — they either fail to compile or compile and misbehave at runtime, and the explanation calls out which.

### 1. Build queries with the statement builders — never concatenate SQL

**❌ Wrong — user input interpolated into SQL:**

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function findUserByEmail(
  db: Database,
  email: string
): Promise<Partial<User> | null> {
  const result = await db.executeQuery<User>(
    `SELECT * FROM users WHERE email = '${email}'`
  );
  return result?.records[0] ?? null;
}
```

**✅ Correct — the expression DSL compiles the predicate and binds the value:**

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function findUserByEmail(
  db: Database,
  email: string
): Promise<Partial<User> | null> {
  const filter = query<User>().where('email').equals(email).compile();
  return db
    .from<User>('users')
    .select(['id', 'name', 'email'])
    .byExpression(filter)
    .executeReturnSingle();
}
```

**Why:** String interpolation turns data into SQL text — a value containing a quote can terminate the literal and change the statement (SQL injection). With the builder path, values never enter the SQL string: `compile()` emits a placeholder and carries the value separately in `CompileResult.params`, which the adapter binds. You also keep type checking — `where('email')` is validated against `User`, and the projection compiles against the table type.

### 2. Scope every UPDATE and DELETE — reject empty dynamic filters

**❌ Wrong — dynamic criteria executed without a guard:**

```typescript
import { Database } from 'blendsdk/dbcore';

interface Session {
  id: number;
  user_id: number;
  expires_at: string;
}

export async function purgeSessions(
  db: Database,
  criteria: Partial<Pick<Session, 'id' | 'user_id'>>
): Promise<number> {
  // ❌ When criteria is `{}`, filter() adds no conditions to the statement
  return db.delete<Session>('sessions').filter(criteria).executeReturnCount();
}
```

**✅ Correct — validate before building the statement:**

```typescript
import { Database } from 'blendsdk/dbcore';

interface Session {
  id: number;
  user_id: number;
  expires_at: string;
}

export async function purgeSessions(
  db: Database,
  criteria: Partial<Pick<Session, 'id' | 'user_id'>>
): Promise<number> {
  if (Object.keys(criteria).length === 0) {
    throw new Error('purgeSessions requires at least one filter criterion');
  }
  return db.delete<Session>('sessions').filter(criteria).executeReturnCount();
}
```

**Why:** `filter()` only contributes conditions for the keys it receives — an empty object adds none, and dbcore has no built-in guard: a `DELETE` with no filter is valid and the adapter executes it as written. With dynamic criteria (search forms, batch tools), the empty case is exactly when a full-table delete happens. When the criteria are fully known in code, prefer `filterByExpression()` — an expression builder like `(q) => q.where('expires_at').lessThan(now)` always contributes a predicate.

### 3. Supply explicit generic types to statements

**❌ Wrong — no generics, so any object shape passes the type checker:**

```typescript
import { Database } from 'blendsdk/dbcore';

export async function deactivateUser(db: Database, userId: number): Promise<number> {
  // ❌ Compiles: without generics, values() and filter() accept `Partial<unknown>`
  return db
    .update('users')
    .values({ active: false })
    .filter({ idd: userId })
    .executeReturnCount();
}
```

**✅ Correct — table and filter shapes are checked at compile time:**

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  active: boolean;
}

export async function deactivateUser(db: Database, userId: number): Promise<number> {
  return db
    .update<User, Pick<User, 'id'>>('users')
    .values({ active: false })
    .filter({ id: userId })
    .executeReturnCount();
}
```

**Why:** When both type arguments fall back to `unknown`, `Partial<unknown>` is `{}` — every object literal is assignable, so `filter({ idd: userId })` compiles cleanly and fails only at runtime as an unknown-column error. With types supplied, the `idd` typo is a compile error, `values()` is constrained to real table columns, and the filter shape is narrowed by `Pick<User, 'id'>`.

### 4. Use the transaction handle inside withTransaction

**❌ Wrong — statements built from the outer `db`:**

```typescript
import { Database } from 'blendsdk/dbcore';

interface Project {
  id: number;
  name: string;
  archived: boolean;
}

interface AuditEntry {
  id: number;
  entity: string;
  entity_id: number;
  action: string;
}

export async function archiveProject(db: Database, projectId: number): Promise<void> {
  await db.withTransaction(async () => {
    // ❌ Built from `db`, not from the callback's transactional handle
    await db
      .update<Project, Pick<Project, 'id'>>('projects')
      .values({ archived: true })
      .filter({ id: projectId })
      .executeReturnCount();

    await db
      .insert<AuditEntry>('audit_entries')
      .values({ entity: 'project', entity_id: projectId, action: 'archived' })
      .executeReturnCount();
  });
}
```

**✅ Correct — every statement uses the `tx` handle:**

```typescript
import { Database } from 'blendsdk/dbcore';

interface Project {
  id: number;
  name: string;
  archived: boolean;
}

interface AuditEntry {
  id: number;
  entity: string;
  entity_id: number;
  action: string;
}

export async function archiveProject(db: Database, projectId: number): Promise<void> {
  await db.withTransaction(async (tx) => {
    await tx
      .update<Project, Pick<Project, 'id'>>('projects')
      .values({ archived: true })
      .filter({ id: projectId })
      .executeReturnCount();

    await tx
      .insert<AuditEntry>('audit_entries')
      .values({ entity: 'project', entity_id: projectId, action: 'archived' })
      .executeReturnCount();
  });
}
```

**Why:** The callback receives a transaction-scoped handle, and only statements built from that handle are guaranteed to run on the transaction's connection. Statements built from the outer `db` are outside that scope in adapters that bind transactions to a dedicated connection — a failure after the first write rolls back only part of the work while the rest commits.

### 5. Throw inside transaction callbacks to roll back

**❌ Wrong — swallowing the error resolves the callback:**

```typescript
import { Database } from 'blendsdk/dbcore';

interface Project {
  id: number;
  name: string;
  archived: boolean;
}

interface AuditEntry {
  id: number;
  entity: string;
  entity_id: number;
  action: string;
}

export async function archiveProject(db: Database, projectId: number): Promise<boolean> {
  return db.withTransaction(async (tx) => {
    await tx
      .update<Project, Pick<Project, 'id'>>('projects')
      .values({ archived: true })
      .filter({ id: projectId })
      .executeReturnCount();
    try {
      await tx
        .insert<AuditEntry>('audit_entries')
        .values({ entity: 'project', entity_id: projectId, action: 'archived' })
        .executeReturnCount();
    } catch {
      // ❌ Returning resolves the callback — the transaction commits anyway
      return false;
    }
    return true;
  });
}
```

**✅ Correct — wrap with context and re-throw:**

```typescript
import { Database } from 'blendsdk/dbcore';

interface Project {
  id: number;
  name: string;
  archived: boolean;
}

interface AuditEntry {
  id: number;
  entity: string;
  entity_id: number;
  action: string;
}

export async function archiveProject(db: Database, projectId: number): Promise<void> {
  await db.withTransaction(async (tx) => {
    await tx
      .update<Project, Pick<Project, 'id'>>('projects')
      .values({ archived: true })
      .filter({ id: projectId })
      .executeReturnCount();
    try {
      await tx
        .insert<AuditEntry>('audit_entries')
        .values({ entity: 'project', entity_id: projectId, action: 'archived' })
        .executeReturnCount();
    } catch (error) {
      // ✅ The re-thrown error rolls the transaction back and surfaces to the caller
      throw new Error(`Audit log failed for project ${projectId}`, { cause: error });
    }
  });
}
```

**Why:** `withTransaction` commits when the callback resolves and rolls back when it throws. Swallowing an error and returning a `false` sentinel is an ordinary resolve — the already-executed statements commit while the caller believes the operation failed, so the data is silently inconsistent. Rethrowing (optionally wrapped with context) forces the rollback and lets the caller handle the failure.

### 6. Allowlist dynamic identifiers

**❌ Wrong — a user-supplied table name rendered into SQL:**

```typescript
import { Database } from 'blendsdk/dbcore';

export async function exportTable(db: Database, tableName: string): Promise<unknown[]> {
  // ❌ tableName becomes part of the SQL text (FROM users; DROP TABLE ...--)
  return db.selectAll<Record<string, unknown>>(tableName).executeReturnAll();
}
```

**✅ Correct — validate the identifier against an allowlist first:**

```typescript
import { Database } from 'blendsdk/dbcore';

const EXPORTABLE_TABLES = new Set<string>(['users', 'orders', 'invoices']);

export async function exportTable(db: Database, tableName: string): Promise<unknown[]> {
  if (!EXPORTABLE_TABLES.has(tableName)) {
    throw new Error(`Refusing to export unknown table: ${tableName}`);
  }
  return db.selectAll<Record<string, unknown>>(tableName).executeReturnAll();
}
```

**Why:** SQL parameters can bind values, not names — every identifier (`tableName`, `filter()` keys, `select()` projections, `returning()` fields, `idColumn`) is rendered into the SQL text verbatim. Parameter binding does not protect identifiers, so user-influenced names must be constrained to a known set before they reach the builder.

### 7. Build a fresh statement per operation

**❌ Wrong — a cached builder reused across calls:**

```typescript
import { Database, DeleteStatement } from 'blendsdk/dbcore';

interface Session {
  id: number;
  user_id: number;
  expires_at: string;
}

export class SessionCleaner {
  private readonly statement: DeleteStatement<Session>;

  constructor(db: Database) {
    this.statement = db.delete<Session>('sessions');
  }

  async purgeForUser(userId: number): Promise<number> {
    // ❌ The first execution cached its compiled filter; conditions added
    //    on later calls are silently ignored and the first predicate is re-applied
    return this.statement.filter({ user_id: userId }).executeReturnCount();
  }
}
```

**✅ Correct — a new statement per operation:**

```typescript
import { Database } from 'blendsdk/dbcore';

interface Session {
  id: number;
  user_id: number;
  expires_at: string;
}

export class SessionCleaner {
  constructor(private readonly db: Database) {}

  async purgeForUser(userId: number): Promise<number> {
    // ✅ Cheap to build, no state from previous calls
    return this.db
      .delete<Session>('sessions')
      .filter({ user_id: userId })
      .executeReturnCount();
  }
}
```

**Why:** Builders are mutable by design. `filter()` and `filterByExpression()` compose with AND across calls (that is what makes `.filter(a).filterByExpression(b)` work within one chain), and `values()` replaces the payload. Reusing one builder across operations mixes state from previous calls — and because `FilterableStatement` caches its compiled expression (`_compiledExpression`) after the first execution, later filter additions are not even compiled. The second call above would re-execute the *first* user's predicate. Builders are cheap objects; create one per operation.

### Do / Don't at a glance

| ✅ Do | ❌ Don't |
| --- | --- |
| Build queries with the statement builders and the expression DSL. | Concatenate values into SQL strings. |
| Validate dynamic criteria and reject empty filters before an UPDATE/DELETE. | Execute writes whose filter could be empty. |
| Give statements explicit generic arguments — `update<User, Pick<User, 'id'>>`. | Let both generics fall back to `unknown`. |
| Use the `tx` handle passed to `withTransaction`. | Build statements from the outer `db` inside a transaction. |
| Throw (with context) inside transaction callbacks to force rollback. | Swallow errors or return failure sentinels from inside the callback. |
| Allowlist table names, columns, and projections from user input. | Interpolate user input as identifiers. |
| Create a new statement per operation. | Cache or reuse statement builders. |

---

## Anti-Patterns

These mistakes look reasonable, often compile, and surface later as wrong results or silent no-ops.

### Importing expression primitives from the wrong package

```typescript
// typescript fragment — ❌ not exported by dbcore; this does not compile
import { query } from 'blendsdk/dbcore';
import type { CompileResult } from 'blendsdk/dbcore';
```

```typescript
// typescript fragment — ✅ the expression API lives in its own package
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';
```

dbcore imports the DSL but deliberately does not re-export it (see the entry-point note in its `index.ts`). The expression package is the single source of truth for `query()`, `QueryBuilder`, and `CompileResult` — importing them from dbcore fails at compile time, and reaching into `dist/` or `src/` paths couples your code to internals.

### Calling `values()` twice and expecting a merge

```typescript
// typescript fragment — ❌ the second call replaces the first payload
db.insert<User>('users')
  .values({ name: 'Alice' })
  .values({ email: 'alice@example.com' });
// Only { email } is inserted; `name` is silently dropped.
```

```typescript
// typescript fragment — ✅ assemble the full payload, then call values() once
const payload: Partial<User> = { name: 'Alice', email: 'alice@example.com' };
db.insert<User>('users').values(payload);
```

`values()` assigns `_values = values` — it is a full replacement, not a merge. For dynamically assembled rows, build the object first (spread-merge is fine) and pass it to `values()` exactly once.

### Counting affected rows with `records.length`

```typescript
// typescript fragment — ❌ on a write without RETURNING, records is empty
const result = await db.delete<Session>('sessions').filter({ id: sessionId }).execute();
const deleted = result?.records.length ?? 0;
```

```typescript
// typescript fragment — ✅ rowCount reflects affected rows for INSERT/UPDATE/DELETE
const deleted = await db.delete<Session>('sessions').filter({ id: sessionId }).executeReturnCount();
```

`QueryResult.rowCount` means *rows returned* for SELECT and *rows affected* for writes. A write without a `RETURNING` clause reports its count only in `rowCount`, so `records.length` reports `0` for a successful delete. Use `executeReturnCount()`.

### Treating `findByExpression()` as a uniqueness guarantee

```typescript
// typescript fragment — ❌ which active user? The first row in database order.
const user = await service.findByExpression((q) => q.where('active').equals(true));
```

```typescript
// typescript fragment — ✅ anchor identity lookups on the primary key
const user = await service.findById(userId);
```

`findByExpression()` and `executeReturnSingle()` return `records[0]` — the first row the database produced, with no ordering guarantee. dbcore emits no `LIMIT`: the entire match set is fetched and all but the first row are discarded. Use `findById()` (or a predicate on a uniquely constrained column) when you expect one row, and `findAllByExpression()` when a set is possible.

### Passing an empty column list to `select()`

```typescript
// typescript fragment — ❌ builds "SELECT  FROM users"
const columns: string[] = [];
db.from<User>('users').select(columns);
```

```typescript
// typescript fragment — ✅ fall back to the all-columns default
db.from<User>('users').select(columns.length > 0 ? columns : undefined);
```

`select()` normalizes `undefined` to `['*']`, but an empty array (and the empty-object form `select({})`) is used verbatim — producing `SELECT  FROM users`, which fails at the database. When a projection is computed dynamically, guard against the empty case and pass `undefined` (or call `select()` with no argument) to request all columns explicitly.

---

## Performance Tips

Statements are cheap; the work around them is not. These tips target what dbcore and your adapter actually do per call.

### Push filtering into the database

```typescript
// typescript fragment — ❌ ships the entire table to the client, then filters in memory
const active = (await service.findAll()).filter((user) => user.active === true);
```

```typescript
// typescript fragment — ✅ the database applies the predicate and returns only matching rows
const active = await service.findAllByExpression((q) => q.where('active').equals(true));
```

`findAll()` issues an unfiltered `SELECT *` — every row crosses the wire, is parsed and materialized, and most of them are discarded in JavaScript. Memory and latency then scale with table size instead of result size. Expression filtering moves the work to where the indexes are.

### Compile static predicates once

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  active: boolean;
}

// Compiled once at module scope — reused by every query with the same predicate
const activeUserFilter = query<User>().where('active').equals(true).compile();

export async function listActiveUserNames(db: Database): Promise<Partial<User>[]> {
  return db
    .from<User>('users')
    .select(['id', 'name'])
    .byExpression(activeUserFilter)
    .executeReturnAll();
}

export async function hasActiveUsers(db: Database): Promise<boolean> {
  const first = await db
    .from<User>('users')
    .select(['id'])
    .byExpression(activeUserFilter)
    .executeReturnSingle();
  return first !== null;
}
```

`compile()` walks the expression tree and produces the SQL fragment plus its bound parameters; `byExpression()` accepts that ready-made `CompileResult`, so re-compiling the same static predicate on every call is wasted work. Two caveats: when the *values* vary per call (a user id, a date), you must recompile per call — parameters are captured in the `CompileResult`. And on `update()`/`delete()` you get this for free: `FilterableStatement` compiles the filter once and caches it in `_compiledExpression`.

### Project only the columns you consume

```typescript
// typescript fragment — ❌ every column of every row
const users = await db.from<User>('users').select().executeReturnAll();
```

```typescript
// typescript fragment — ✅ only the columns the caller uses
const users = await db.from<User>('users').select(['id', 'name', 'email']).executeReturnAll();
```

`select()` without arguments builds `SELECT *`. On wide tables, that makes the database read, serialize, and the client materialize columns your code never touches. Explicit projections also keep result shapes stable when the table gains columns.

### Resolve collections with one query — not one query per row

```typescript
// typescript fragment — ❌ N+1: one round-trip per employee just to resolve the role name
for (const employee of employees) {
  const role = await roleService.findById(employee.role_id);
  labels.push(role?.name ?? 'unknown');
}
```

```typescript
// typescript fragment — ✅ one query for the reference table, resolved in memory
const roleById = new Map<number, string>();
for (const role of await roleService.findAll()) {
  if (role.id !== undefined && role.name !== undefined) {
    roleById.set(role.id, role.name);
  }
}
const labels = employees.map((employee) => roleById.get(employee.role_id) ?? 'unknown');
```

Each `findById()` in a loop is a full database round-trip. For small reference tables (roles, statuses, locales), fetch once and resolve in memory; for larger sets, tighten the predicate and fetch the set in a single `findAllByExpression()` call instead of issuing one statement per element.

### Skip `returning()` when only the count matters

```typescript
// typescript fragment — ❌ RETURNING * just to count the changed rows
const rows = await db
  .update<User, Pick<User, 'active'>>('users')
  .values({ active: false })
  .filter({ active: true })
  .returning('*')
  .executeReturnAll();
const changed = rows.length;
```

```typescript
// typescript fragment — ✅ rowCount comes back with the write itself
const changed = await db
  .update<User, Pick<User, 'active'>>('users')
  .values({ active: false })
  .filter({ active: true })
  .executeReturnCount();
```

`rowCount` is reported for the write regardless of `RETURNING`. Adding `returning('*')` makes the database construct and ship full row images back — pure overhead for a bulk update whose result the caller ignores.

### Batch related writes into one transaction

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

const BATCH_SIZE = 200;

export async function importUsers(db: Database, users: Partial<User>[]): Promise<number> {
  let imported = 0;
  for (let offset = 0; offset < users.length; offset += BATCH_SIZE) {
    const batch = users.slice(offset, offset + BATCH_SIZE);
    await db.withTransaction(async (tx) => {
      for (const user of batch) {
        imported += await tx.insert<User>('users').values(user).executeReturnCount();
      }
    });
  }
  return imported;
}
```

Each `withTransaction` round-trips `BEGIN`/`COMMIT` and, in pooled adapters, pins one connection for the callback's duration — wrapping every single insert in its own transaction is the worst case. Chunking bounds the transaction's lifetime so locks and connection usage stay predictable while still amortizing the commit overhead.

### Share the Database instance and hoist service factories

```typescript
import { Database, createQueryService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

// ✅ Created once at module scope, not on every request
const UserService = createQueryService<User>('users', 'id');

export async function findUser(db: Database, id: number): Promise<Partial<User> | null> {
  return new UserService(db).findById(id);
}
```

Connections are expensive; statements are cheap. Construct the adapter once, `connect()` once at startup, share the instance across requests, and `disconnect(timeoutMs)` once during shutdown to give in-flight work a chance to finish. Likewise, `createQueryService()` allocates a class on every call — hoist it to module scope and instantiate the (cheap) service per use.

---

## Security Considerations

This package draws a precise security boundary: values are always bound, identifiers never are, and there is no implicit protection against unscoped statements. The items below cover where the boundary sits.

### Bind values — every identifier needs validation

Values passed to `.equals()`, `.lessThan()`, `.greaterThan()` and friends are compiled into `CompileResult.params` and bound by the adapter — that is the injection-safe path (pair 1). Identifiers cannot be parameterized: `tableName`, `filter()` keys, `select()` projections, `returning()` fields, and `idColumn` are rendered into SQL text verbatim. Validate anything user-influenced against an allowlist before it reaches a builder (pair 6).

### Never hand-build `CompileResult` objects

```typescript
// typescript fragment — ❌ equivalent to raw SQL concatenation
statement.byExpression({ sql: `email = '${email}'`, params: {} });

// ✅ compile from the DSL; the value is bound, not embedded
statement.byExpression(query<User>().where('email').equals(email).compile());
```

`byExpression()` accepts any object shaped like `{ sql, params }` — the type system does not track provenance. Constructing that object from user input re-creates the exact injection hole the DSL exists to close. Only pass results of `.compile()`.

### Reject unscoped writes before they execute

A `DELETE` or `UPDATE` without conditions is valid SQL, and dbcore will not stop you from building one (pair 2). When criteria are assembled dynamically, validate before execution:

```typescript
// typescript fragment — refuse executions with empty dynamic criteria
if (Object.keys(criteria).length === 0) {
  throw new Error('Refusing to execute an unscoped write');
}
```

In bulk tooling, also treat `executeReturnCount()` as a tripwire — a count far outside the expected range is worth alerting on before the same code runs again.

### Treat credentials and query parameters as sensitive

`DatabaseConfig` — including `pass` — is retained on the adapter instance for its lifetime. Source it from environment variables or a secret manager, and keep it out of diagnostics: a casual `JSON.stringify(db)` includes `config` and therefore the password. Custom `beforeQuery` handlers receive the raw parameter object before execution, so redact values before logging there. Call `disconnect()` at shutdown so pooled connections and their credentials are not left open.

### Keep adapter errors out of client responses

Errors thrown by `executeQuery()` and `withTransaction()` propagate unchanged through statement execution — they can contain SQL text, bound values, or connection details.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export async function loadUserProfile(db: Database, id: number): Promise<Partial<User> | null> {
  try {
    return await db
      .from<User>('users')
      .select(['id', 'name', 'email'])
      .byExpression(query<User>().where('id').equals(id).compile())
      .executeReturnSingle();
  } catch (error) {
    // ✅ Internal detail stays in the cause for server-side logs
    throw new Error('Could not load the user profile', { cause: error });
  }
}
```

Wrap adapter errors at the application boundary, keep the original as `cause` for logs, and surface only the safe message to end users.

### Don't return `*` over sensitive columns

`select()` defaults to `SELECT *` and `returning('*')` echoes the full written row — including `password_hash`, tokens, or columns your API never intends to expose. Those values then live in application memory, logs, and potentially responses. Request explicit columns on both reads (`select([...])`) and writes (`returning([...])`), and treat `'*'` as a deliberate, reviewed choice.

### Risk summary

| Risk | Mitigation |
| --- | --- |
| SQL injection through values | Predicates compiled by `query()` carry values in `params`; never interpolate (pair 1). |
| Injection through identifiers (table/column names, projections) | Validate against an allowlist before they reach the builder (pair 6). |
| Forged `CompileResult` containing raw user text | Only pass results of `.compile()` to `byExpression()`. |
| Mass UPDATE/DELETE from empty dynamic criteria | Reject empty criteria before execution (pair 2); verify with `executeReturnCount()`. |
| Credentials or parameters in logs | Keep `DatabaseConfig` out of logs; redact hook payloads. |
| Internal detail in client-facing errors | Wrap adapter errors; keep `cause` server-side. |
| Sensitive columns leaving the database | Explicit `select()`/`returning()` projections. |

For the signature-level details of every member referenced here, see the API Reference; for end-to-end usage patterns, see Basic Usage and the Overview.

---

# dbcore Testing Patterns

`blendsdk/dbcore` is built to be testable: every database interaction flows through the abstract `Database` class, so a single lightweight fake replaces the entire persistence layer in your tests. The package's own suite is fully hermetic — it runs on Vitest against an in-memory `Database` fake (`MockDatabase`) and requires no database server, driver, or Docker container. This document mirrors the patterns used by the package's own test files (`tests/statement.test.ts`, `tests/crud-statements.test.ts`, `tests/from-statement.test.ts`, `tests/query-dataservice.test.ts`, and `tests/sanity.test.ts`) and shows how to apply them to code that consumes the package.

---

## Test Setup

### Dependencies and Scripts

The package's test tooling is Vitest with the V8 coverage provider. In a consumer project, install the same tooling:

```bash
npm install --save-dev vitest @vitest/coverage-v8
```

The package exposes these scripts, which you can mirror in your own `package.json`:

| Script | Command | Purpose |
| --- | --- | --- |
| `test` | `vitest run --reporter=verbose` | Single verbose run (CI) |
| `test:fast` | `vitest run --reporter=verbose` | Fast run with the same configuration |
| `test:watch` | `vitest watch --reporter=verbose` | Watch mode during development |
| `test:coverage` | `vitest run --coverage` | Run with V8 coverage reporting |

### Vitest Configuration

A minimal configuration that matches how the package's suite behaves (Node environment, tests under `tests/`, V8 coverage):

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
```

### Suggested Test Layout

The package's own tests define the `MockDatabase` fake locally in each test file. In your project, define it once as a shared helper:

```text
your-project/
├── vitest.config.ts
├── src/
└── tests/
    ├── helpers/
    │   └── mock-database.ts      # reusable fake + concrete test statement builders
    ├── statement.test.ts
    ├── crud-statements.test.ts
    └── query-dataservice.test.ts
```

### Import Rules

| Import from | Symbols | Used for |
| --- | --- | --- |
| `vitest` | `describe`, `test`, `expect`, `beforeEach`, `afterAll`, `vi` | Test harness, assertions, spies |
| `blendsdk/dbcore` | `Database`, statement classes, `QueryDataService`, `createQueryService`, types | The code under test — always the package root entry |
| `blendsdk/expression` | `query`, `QueryBuilder`, `CompileResult` | Building and compiling WHERE-clause filters |
| `./helpers/mock-database.js` | `MockDatabase`, `Test*Statement` | Test fixtures |

Never import from `dist/` or `src/` paths in consumer projects — the package root (`blendsdk/dbcore`) is the public API. The package's own repository tests import from `../src/*.js` because they test the sources directly; your tests should not.

### The MockDatabase Test Helper

This single file powers every unit test in the package's suite and its consumer equivalents. It subclasses the real `Database` and records everything that is executed:

```typescript
// tests/helpers/mock-database.ts
import {
  Database,
  DeleteStatement,
  ExecuteQueryOptions,
  InsertStatement,
  QueryResult,
  UpdateStatement,
} from 'blendsdk/dbcore';

/**
 * Concrete INSERT builder with a simple `:name` placeholder dialect.
 * The builder methods are protected, so tests observe them through the
 * queries recorded by MockDatabase instead of poking at internal state.
 */
export class TestInsertStatement<TableType> extends InsertStatement<TableType> {
  protected buildQuery(): string {
    const columns = Object.keys(this._values);
    const placeholders = columns.map((column) => `:${column}`);
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${returning}`;
  }

  protected buildParameters(): Partial<TableType> {
    return this._values;
  }
}

/**
 * Concrete UPDATE builder. It renders SET assignments from values() and a
 * WHERE clause from the cached compiled filter, so tests can assert both.
 */
export class TestUpdateStatement<TableType, FilterType> extends UpdateStatement<TableType, FilterType> {
  protected buildQuery(): string {
    const assignments = Object.keys(this._values).map((column) => `${column} = :v_${column}`);
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `UPDATE ${this.tableName} SET ${assignments.join(', ')}${where}${returning}`;
  }

  protected buildParameters(): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (const column of Object.keys(this._values)) {
      params[`v_${column}`] = this._values[column as keyof TableType];
    }
    const filter = this.getCompiledExpression();
    if (filter) {
      Object.assign(params, filter.params);
    }
    return params;
  }

  /** Test-only accessor: exposes the protected compilation bridge for assertions. */
  public compiledFilter() {
    return this.getCompiledExpression();
  }
}

/**
 * Concrete DELETE builder, following the same approach as TestUpdateStatement.
 */
export class TestDeleteStatement<FilterType> extends DeleteStatement<FilterType> {
  protected buildQuery(): string {
    const filter = this.getCompiledExpression();
    const where = filter ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `DELETE FROM ${this.tableName}${where}${returning}`;
  }

  protected buildParameters(): Record<string, unknown> {
    const filter = this.getCompiledExpression();
    return filter ? { ...filter.params } : {};
  }

  /** Test-only accessor: exposes the protected compilation bridge for assertions. */
  public compiledFilter() {
    return this.getCompiledExpression();
  }
}

/** One recorded executeQuery() call. */
export interface ExecutedQuery {
  query: string;
  params?: Record<string, unknown>;
  options?: ExecuteQueryOptions;
}

/**
 * In-memory Database fake. Records every executed query and resolves with the
 * result currently stored in mockResult.
 */
export class MockDatabase extends Database {
  public readonly executedQueries: ExecutedQuery[] = [];
  public mockResult: QueryResult<unknown> = { records: [], rowCount: 0 };

  constructor() {
    super({ host: 'localhost', database: 'testdb' });
  }

  async connect(): Promise<void> {
    // Nothing to connect to — the mock is always "connected".
  }

  async disconnect(): Promise<void> {
    // Nothing to release.
  }

  async executeQuery<R>(
    query: string,
    params?: Record<string, unknown>,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null> {
    this.executedQueries.push({ query, params, options });
    return this.mockResult as QueryResult<R>;
  }

  async withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  insert<T>(tableName: string): InsertStatement<T> {
    return new TestInsertStatement<T>(tableName, this);
  }

  update<T, F>(tableName: string): UpdateStatement<T, F> {
    return new TestUpdateStatement<T, F>(tableName, this);
  }

  delete<F>(tableName: string): DeleteStatement<F> {
    return new TestDeleteStatement<F>(tableName, this);
  }
}
```

How the pieces fit together:

- `executedQueries` is the main assertion surface: every `executeQuery()` call is recorded with its SQL, parameters, and `ExecuteQueryOptions` (including any registered hooks).
- `mockResult` is the canned response; set it per test to control what statements resolve to.
- `insert()`, `update()`, and `delete()` return the concrete `Test*Statement` builders, whose SQL output is deterministic (`:name` placeholder dialect).
- `from()` and `selectAll()` are inherited from the real `Database` base class — SELECT SQL is generated by the production `FromStatement`, not by the fake.
- `withTransaction()` simply invokes the callback with the same handle; write a subclass if you need to assert commit/rollback wiring.

---

## Unit Testing

Unit tests replace only the `Database` adapter — every other component (statement builders, expression compilation, data services) is exercised as real code. The loop is always the same:

1. Create a fresh `MockDatabase` (use `beforeEach`).
2. Set `mockResult` to the rows the driver should "return".
3. Build and execute the statement or call the service.
4. Assert on `executedQueries` (SQL and parameters) and on the resolved value.

### Pattern: One Fresh Fake per Test

```typescript
import { beforeEach, describe, expect, test } from 'vitest';
import { MockDatabase } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

describe('registerUser', () => {
  let db: MockDatabase;

  beforeEach(() => {
    db = new MockDatabase();
  });

  test('inserts the user and returns the generated record', async () => {
    db.mockResult = {
      records: [{ id: 1, name: 'Alice', email: 'alice@test.com', active: true }],
      rowCount: 1,
    };

    const created = await db
      .insert<User>('users')
      .values({ name: 'Alice', email: 'alice@test.com', active: true })
      .returning(['id', 'name', 'email', 'active'])
      .executeReturnSingle();

    expect(db.executedQueries).toHaveLength(1);
    expect(db.executedQueries[0].query).toBe(
      'INSERT INTO users (name, email, active) VALUES (:name, :email, :active) RETURNING id, name, email, active'
    );
    expect(db.executedQueries[0].params).toEqual({
      name: 'Alice',
      email: 'alice@test.com',
      active: true,
    });
    expect(created).toEqual({ id: 1, name: 'Alice', email: 'alice@test.com', active: true });
  });
});
```

### Pattern: Assert on Recorded Queries, Not Protected State

The execution-level assertions above are the recommended style: they use only the public API and verify the SQL your adapter would actually receive. The package's own tests occasionally inspect protected builder fields with type assertions (for example `(statement as any)._values`); prefer `executedQueries` instead, or expose a typed accessor in a test-only subclass — the helper's `compiledFilter()` is exactly that technique for the protected `getCompiledExpression()` bridge.

### Pattern: Test Builder Behavior Synchronously

Construction, chaining, and defaults are synchronous — nothing is sent to the database until an `execute*()` helper is called. This is a real behavioral guarantee worth asserting:

```typescript
import { describe, expect, test } from 'vitest';
import { MockDatabase } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

describe('statement laziness', () => {
  test('building a statement does not execute it', () => {
    const db = new MockDatabase();

    db.insert<User>('users').values({ name: 'Alice' }).returning('*');
    db.update<User, { id: number }>('users').values({ active: false }).filter({ id: 1 });

    expect(db.executedQueries).toHaveLength(0);
  });
});
```

---

## Integration Testing

`blendsdk/dbcore` contains no driver and no real-database test infrastructure: there are **no Docker containers, database servers, or external services** required to run its suite. Everything in the package's own `tests/` directory runs hermetically against `MockDatabase`.

Real-instance testing therefore happens in consumer projects, in two common shapes:

- **Adapter authors** — repositories that implement a concrete `Database` (for example against PostgreSQL or MySQL) run integration suites that execute the adapter's statement builders against a real server.
- **Application teams** — projects that consume a published adapter point their integration suites at a shared test database to validate migrations, constraints, and dialect-specific SQL together with the services built on `blendsdk/dbcore`.

The example below follows the adapter-author shape: it imports a concrete adapter implemented in the same repository (`src/postgres-database.ts`). If you consume a published adapter instead, replace that import with your adapter package — everything else in the suite stays identical, because it only uses the public `blendsdk/dbcore` API.

```typescript
// tests/integration/postgres-database.integration.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Database, createQueryService } from 'blendsdk/dbcore';
import { PostgresDatabase } from '../../src/postgres-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class RollbackSignal extends Error {
  constructor() {
    super('rollback requested by test');
    this.name = 'RollbackSignal';
  }
}

describe.skipIf(process.env.DBCORE_INTEGRATION !== '1')('PostgresDatabase (integration)', () => {
  let db: Database;

  beforeAll(async () => {
    db = new PostgresDatabase({
      host: process.env.PGHOST ?? 'localhost',
      database: process.env.PGDATABASE ?? 'dbcore_test',
      port: process.env.PGPORT ?? 5432,
      user: process.env.PGUSER ?? 'postgres',
      pass: process.env.PGPASSWORD ?? 'postgres',
    });
    await db.connect();
  });

  afterAll(async () => {
    await db.disconnect(5000);
  });

  beforeEach(async () => {
    await db.executeQuery('DELETE FROM users');
  });

  test('INSERT ... RETURNING returns the created row', async () => {
    const created = await db
      .insert<User>('users')
      .values({ id: 1, name: 'Alice', email: 'alice@test.com', active: true })
      .returning('*')
      .executeReturnSingle();

    expect(created).toEqual({ id: 1, name: 'Alice', email: 'alice@test.com', active: true });
  });

  test('data services query the real server end to end', async () => {
    const UserService = createQueryService<User>('users', 'id');
    const service = new UserService(db);

    await db
      .insert<User>('users')
      .values({ id: 7, name: 'Grace', email: 'grace@test.com', active: true })
      .execute();

    const found = await service.findById(7);
    expect(found?.email).toBe('grace@test.com');

    const active = await service.findAllByExpression((q) => q.where('active').equals(true));
    expect(active).toHaveLength(1);
  });

  test('withTransaction rolls back when the callback throws', async () => {
    await expect(
      db.withTransaction(async (tx) => {
        await tx
          .insert<User>('users')
          .values({ id: 99, name: 'Temp', email: 'temp@test.com', active: false })
          .execute();
        throw new RollbackSignal();
      })
    ).rejects.toThrow(RollbackSignal);

    const rows = await db.selectAll<User>('users').executeReturnAll();
    expect(rows).toHaveLength(0);
  });
});
```

Run the gated suite explicitly, so the default `npm test` stays hermetic:

```bash
DBCORE_INTEGRATION=1 npm test
```

Isolation strategies for real databases — pick one per suite:

- **Cleanup** — truncate or `DELETE` the affected tables in `beforeEach` (shown above). Simple and predictable.
- **Rollback** — run each mutation inside `withTransaction()` and throw a sentinel error to force a rollback (shown above); fastest cleanup when the adapter maps transactions correctly.
- **Unique keys** — generate per-run identifiers with `crypto.randomUUID()` so parallel files never collide, and clean up in `afterEach`.

Because the suite touches only the public API, it doubles as a reusable **contract test**: run it against every adapter you support by swapping the import and connection config.

---

## Mocking & Stubbing

### Prefer the Fake over Mocking Frameworks

`Database` is an abstract class designed as a substitution seam, so subclassing it (as `MockDatabase` does) beats module-level mocking:

- Full type safety across the package — no `vi.mock('blendsdk/dbcore')` hoisting, no broken types.
- Recording and play-back in one fixture (`executedQueries` + `mockResult`).
- The real statement builders, expression compilation, and data services run as production code.

### Stubbing Results

Set `mockResult` per test to control what the driver returns:

```typescript
const db = new MockDatabase();
db.mockResult = { records: [{ id: 1, name: 'Alice' }], rowCount: 1 };
```

To simulate a driver that resolves `null` (no result at all), override `executeQuery()` to return `null` — the execution helpers normalize it, as shown in [Statement Execution Helpers](#statement-execution-helpers).

### Stubbing Behavior

Override `executeQuery()` in a subclass when you need to simulate failures. Adapter errors are documented to propagate unchanged through statement execution, so this is a contract worth testing:

```typescript
import { describe, expect, test } from 'vitest';
import { ExecuteQueryOptions, QueryResult } from 'blendsdk/dbcore';
import { MockDatabase } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class FailingDatabase extends MockDatabase {
  async executeQuery<R>(
    query: string,
    params?: Record<string, unknown>,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null> {
    throw new Error(`adapter failure while executing: ${query}`);
  }
}

describe('error propagation', () => {
  test('adapter errors surface unchanged from statement execution', async () => {
    const db = new FailingDatabase();

    await expect(db.selectAll<User>('users').execute()).rejects.toThrow('adapter failure');
  });
});
```

### Verifying Callbacks with `vi.fn()`

Handlers registered via `beforeQuery()` / `afterQuery()` are only *invoked* by adapters that apply the options they receive. `MockDatabase` records the options untouched (use identity assertions: `expect(db.executedQueries[0].options?.beforeQuery).toBe(handler)`); to assert that a handler actually ran, apply the hooks in a fake and wrap the handler in `vi.fn()` — see the lifecycle-hook pattern in [Query Lifecycle Hooks](#query-lifecycle-hooks).

### What Not to Mock

- **Do not mock `blendsdk/expression`.** `query()` and `.compile()` are pure and fast; real compilation keeps your filters honest and catches DSL changes on upgrades.
- **Do not mock the statement classes.** They are the behavior under test — combine real builders with `MockDatabase` instead.
- **Do not `vi.mock('blendsdk/dbcore')`.** Replacing the package module wholesale discards the type-safe seam the abstraction provides; subclass `Database` instead.

---

## Test Patterns by Feature

### Database Statement Factories

The factories (`insert()`, `update()`, `delete()`, `from()`, `selectAll()`) should return builders of the expected type, and `selectAll()` is defined as `from(table).select()`:

```typescript
import { describe, expect, test } from 'vitest';
import {
  DeleteStatement,
  FromStatement,
  InsertStatement,
  UpdateStatement,
} from 'blendsdk/dbcore';
import { MockDatabase } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

describe('database statement factories', () => {
  test('create the correct statement types', () => {
    const db = new MockDatabase();

    expect(db.insert<User>('users')).toBeInstanceOf(InsertStatement);
    expect(db.update<User, Partial<User>>('users')).toBeInstanceOf(UpdateStatement);
    expect(db.delete<User>('users')).toBeInstanceOf(DeleteStatement);
    expect(db.from<User>('users')).toBeInstanceOf(FromStatement);
    expect(db.selectAll<User>('users')).toBeInstanceOf(FromStatement);
  });

  test('selectAll() pre-configures a SELECT * statement', async () => {
    const db = new MockDatabase();

    await db.selectAll<User>('users').execute();

    expect(db.executedQueries[0].query).toBe('SELECT * FROM users');
  });
});
```

### Statement Execution Helpers

Each helper unwraps `QueryResult` differently and also normalizes an adapter that resolves `null`: `executeReturnSingle()` → first record or `null`, `executeReturnAll()` → records or `[]`, `executeReturnCount()` → `rowCount` or `0`.

```typescript
import { describe, expect, test } from 'vitest';
import { ExecuteQueryOptions, QueryResult } from 'blendsdk/dbcore';
import { MockDatabase } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

/** Simulates a driver adapter that resolves null when nothing is returned. */
class NullResultDatabase extends MockDatabase {
  async executeQuery<R>(
    query: string,
    params?: Record<string, unknown>,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null> {
    return null;
  }
}

describe('statement execution helpers', () => {
  test('executeReturnSingle() returns the first record', async () => {
    const db = new MockDatabase();
    db.mockResult = {
      records: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
      rowCount: 2,
    };

    const row = await db.selectAll<User>('users').executeReturnSingle();

    expect(row).toEqual({ id: 1, name: 'Alice' });
  });

  test('executeReturnSingle() resolves null when no rows match', async () => {
    const db = new MockDatabase();
    db.mockResult = { records: [], rowCount: 0 };

    const row = await db.selectAll<User>('users').executeReturnSingle();

    expect(row).toBeNull();
  });

  test('executeReturnAll() resolves an empty array for null results', async () => {
    const db = new NullResultDatabase();

    const rows = await db.selectAll<User>('users').executeReturnAll();

    expect(rows).toEqual([]);
  });

  test('executeReturnCount() resolves 0 for null results', async () => {
    const db = new NullResultDatabase();

    const count = await db.delete<User>('users').filter({ id: 1 }).executeReturnCount();

    expect(count).toBe(0);
  });

  test('execute() resolves the raw QueryResult', async () => {
    const db = new MockDatabase();
    db.mockResult = { records: [{ id: 1 }], rowCount: 1 };

    const result = await db.from<User>('users').select().execute();

    expect(result).toEqual({ records: [{ id: 1 }], rowCount: 1 });
  });
});
```

### Query Lifecycle Hooks

Hooks are verified in two ways: **pass-through** (the handler appears in `ExecuteQueryOptions` exactly as registered) and **effect** (a fake that applies the hooks produces transformed parameters and rows).

```typescript
import { describe, expect, test, vi } from 'vitest';
import { ExecuteQueryOptions, QueryResult } from 'blendsdk/dbcore';
import { MockDatabase } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

/** A fake that applies beforeQuery/afterQuery like a real adapter would. */
class HookApplyingDatabase extends MockDatabase {
  async executeQuery<R>(
    query: string,
    params?: Record<string, unknown>,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null> {
    const finalParams = params && options?.beforeQuery ? options.beforeQuery(params) : params;
    const rows: unknown[] = options?.afterQuery
      ? options.afterQuery(this.mockResult.records)
      : this.mockResult.records;
    this.executedQueries.push({ query, params: finalParams, options });
    return { records: rows as R[], rowCount: this.mockResult.rowCount };
  }
}

describe('query lifecycle hooks', () => {
  test('registered handlers are forwarded untouched in ExecuteQueryOptions', async () => {
    const db = new MockDatabase();
    const beforeQuery = (params: Record<string, unknown>) => params;
    const afterQuery = (rows: unknown[]) => rows;

    await db
      .selectAll<User>('users')
      .beforeQuery<Record<string, unknown>>(beforeQuery)
      .afterQuery<unknown[]>(afterQuery)
      .execute();

    expect(db.executedQueries[0].options?.beforeQuery).toBe(beforeQuery);
    expect(db.executedQueries[0].options?.afterQuery).toBe(afterQuery);
  });

  test('hooks transform parameters and result rows end to end', async () => {
    const db = new HookApplyingDatabase();
    db.mockResult = {
      records: [{ id: 1, name: 'alice', email: 'a@test.com', active: true }],
      rowCount: 1,
    };
    const beforeQuery = vi.fn((params: Record<string, unknown>) => ({
      ...params,
      tenantId: 'acme',
    }));

    const rows = await db
      .selectAll<User>('users')
      .beforeQuery<Record<string, unknown>>(beforeQuery)
      .afterQuery<Array<Record<string, unknown>>>((records) =>
        records.map((record) => ({ ...record, name: String(record.name).toUpperCase() }))
      )
      .executeReturnAll();

    expect(beforeQuery).toHaveBeenCalledTimes(1);
    expect(beforeQuery).toHaveBeenCalledWith({});
    expect(db.executedQueries[0].params).toEqual({ tenantId: 'acme' });
    expect(rows[0]?.name).toBe('ALICE');
  });
});
```

### FromStatement — SELECT Building

Cover all three `select()` forms and both `byExpression()` input styles: hand-built `CompileResult` literals for exact SQL assertions, and real `query()` compilations for DSL integration.

```typescript
import { describe, expect, test } from 'vitest';
import { query, type CompileResult } from 'blendsdk/expression';
import { MockDatabase } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

describe('FromStatement', () => {
  test('select() with no arguments selects all columns', async () => {
    const db = new MockDatabase();

    await db.from<User>('users').select().execute();

    expect(db.executedQueries[0].query).toBe('SELECT * FROM users');
  });

  test('select(array) renders an explicit column list', async () => {
    const db = new MockDatabase();

    await db.from<User>('users').select(['id', 'name', 'email']).execute();

    expect(db.executedQueries[0].query).toBe('SELECT id, name, email FROM users');
  });

  test('select(object) renders "expression AS alias" entries', async () => {
    const db = new MockDatabase();

    await db
      .from<User>('users')
      .select({ fullName: "first_name || ' ' || last_name" })
      .execute();

    expect(db.executedQueries[0].query).toContain("first_name || ' ' || last_name AS fullName");
  });

  test('byExpression() applies a compiled WHERE clause with its parameters', async () => {
    const db = new MockDatabase();
    const filter: CompileResult = { sql: 'active = :p1', params: { p1: true } };

    await db.from<User>('users').select(['id']).byExpression(filter).execute();

    expect(db.executedQueries[0].query).toBe('SELECT id FROM users WHERE active = :p1');
    expect(db.executedQueries[0].params).toEqual({ p1: true });
  });

  test('byExpression() accepts filters produced by the expression DSL', async () => {
    const db = new MockDatabase();
    const filter = query<User>().where('active').equals(true).compile();

    await db.from<User>('users').select().byExpression(filter).execute();

    expect(db.executedQueries[0].query).toContain('SELECT * FROM users WHERE');
    expect(Object.values(db.executedQueries[0].params ?? {})).toContain(true);
  });
});
```

Assert on the compiled SQL **loosely** (`toContain('WHERE')`, parameter values via `Object.values(...).toContain(...)`) when using the real DSL — the exact placeholder names are owned by `blendsdk/expression` and should not be hard-coded in your tests.

### CrudStatement — `returning()` and Value Payloads

`returning()` is shared by every CRUD builder: `'*'` becomes `['*']`, an array is used verbatim. `values()` is a full replacement, not a merge — a behavior worth locking in.

```typescript
import { describe, expect, test } from 'vitest';
import { MockDatabase } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

describe('CrudStatement', () => {
  test("returning('*') requests every column", async () => {
    const db = new MockDatabase();

    await db.insert<User>('users').values({ name: 'Alice' }).returning('*').execute();

    expect(db.executedQueries[0].query).toBe(
      'INSERT INTO users (name) VALUES (:name) RETURNING *'
    );
  });

  test('returning(fields) requests a specific projection', async () => {
    const db = new MockDatabase();

    await db
      .insert<User>('users')
      .values({ name: 'Alice' })
      .returning(['id', 'email'])
      .execute();

    expect(db.executedQueries[0].query).toBe(
      'INSERT INTO users (name) VALUES (:name) RETURNING id, email'
    );
  });

  test('values() replaces the payload on repeated calls', async () => {
    const db = new MockDatabase();

    await db
      .insert<User>('users')
      .values({ name: 'Alice', email: 'alice@test.com' })
      .values({ name: 'Bob' })
      .execute();

    expect(db.executedQueries[0].params).toEqual({ name: 'Bob' });
  });
});
```

### FilterableStatement — `filter()` and `filterByExpression()`

`filter()` converts key/value criteria into equality conditions combined with AND; `filterByExpression()` merges DSL predicates on top with AND. Both feed the cached compilation, which compiles the expression exactly once.

```typescript
import { describe, expect, test } from 'vitest';
import { MockDatabase, TestUpdateStatement } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

describe('FilterableStatement', () => {
  test('filter() renders a WHERE clause and binds the criteria', async () => {
    const db = new MockDatabase();

    await db
      .update<User, { id: number }>('users')
      .values({ active: false })
      .filter({ id: 42 })
      .execute();

    const [executed] = db.executedQueries;
    expect(executed.query).toContain('UPDATE users SET active = :v_active');
    expect(executed.query).toContain('WHERE');
    expect(Object.values(executed.params ?? {})).toContain(42);
  });

  test('filter() and filterByExpression() combine with AND', async () => {
    const db = new MockDatabase();

    await db
      .delete<User>('users')
      .filter({ active: false })
      .filterByExpression((q) => q.where('name').equals('obsolete'))
      .execute();

    const [executed] = db.executedQueries;
    const values = Object.values(executed.params ?? {});
    expect(executed.query).toContain('WHERE');
    expect(values).toContain(false);
    expect(values).toContain('obsolete');
  });

  test('the compiled filter is null before filtering and cached afterwards', () => {
    const db = new MockDatabase();
    const statement = new TestUpdateStatement<User, { id: number }>('users', db);

    expect(statement.compiledFilter()).toBeNull();

    statement.filter({ id: 99 });

    const first = statement.compiledFilter();
    const second = statement.compiledFilter();

    expect(first).not.toBeNull();
    expect(first?.sql).toContain('id');
    expect(second).toBe(first);
  });
});
```

### UpdateStatement and DeleteStatement

Both extend `FilterableStatement` (and therefore `CrudStatement`), so inheritance assertions plus one rendered statement per class give solid coverage. Concrete adapters are expected to consume the cached filter in **both** `buildQuery()` and `buildParameters()` — the helper's builders demonstrate the pattern.

```typescript
import { describe, expect, test } from 'vitest';
import { CrudStatement, FilterableStatement } from 'blendsdk/dbcore';
import { MockDatabase } from './helpers/mock-database.js';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

describe('UpdateStatement and DeleteStatement', () => {
  test('share the filterable CRUD foundation and chain fluently', () => {
    const db = new MockDatabase();
    const update = db.update<User, { id: number }>('users');
    const remove = db.delete<User>('users');

    expect(update).toBeInstanceOf(FilterableStatement);
    expect(remove).toBeInstanceOf(FilterableStatement);
    expect(update).toBeInstanceOf(CrudStatement);

    const chained = update.values({ active: false }).filter({ id: 1 }).returning('*');
    expect(chained).toBe(update);
  });

  test('update renders SET, WHERE and RETURNING', async () => {
    const db = new MockDatabase();

    await db
      .update<User, { id: number }>('users')
      .values({ active: false })
      .filter({ id: 42 })
      .returning(['id', 'active'])
      .execute();

    const [executed] = db.executedQueries;
    expect(executed.query).toContain('UPDATE users SET active = :v_active');
    expect(executed.query).toContain('WHERE');
    expect(executed.query).toContain('RETURNING id, active');
    expect(Object.values(executed.params ?? {})).toContain(42);
  });

  test('delete renders WHERE and RETURNING', async () => {
    const db = new MockDatabase();

    await db.delete<User>('users').filter({ id: 1 }).returning(['id', 'email']).execute();

    const [executed] = db.executedQueries;
    expect(executed.query).toContain('DELETE FROM users');
    expect(executed.query).toContain('WHERE');
    expect(executed.query).toContain('RETURNING id, email');
    expect(Object.values(executed.params ?? {})).toContain(1);
  });
});
```

### QueryDataService and createQueryService()

Data services take a `Database` in their constructor — the same fake works unchanged. Use a static `mockResult` per test for the records the relation should "contain".

```typescript
import { describe, expect, test } from 'vitest';
import { Database, QueryDataService, createQueryService } from 'blendsdk/dbcore';
import { MockDatabase } from './helpers/mock-database.js';

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

  async findActive(): Promise<Partial<User>[]> {
    return this.findAllByExpression((q) => q.where('active').equals(true));
  }
}

describe('QueryDataService', () => {
  test('findById() queries by the configured id column', async () => {
    const db = new MockDatabase();
    db.mockResult = {
      records: [{ id: 1, name: 'Alice', email: 'alice@test.com', active: true }],
      rowCount: 1,
    };

    const user = await new UserService(db).findById(1);

    expect(user).toEqual({ id: 1, name: 'Alice', email: 'alice@test.com', active: true });
    expect(db.executedQueries[0].query).toContain('SELECT * FROM users');
    expect(db.executedQueries[0].query).toContain('WHERE');
    expect(Object.values(db.executedQueries[0].params ?? {})).toContain(1);
  });

  test('findById() resolves null when nothing matches', async () => {
    const db = new MockDatabase();
    db.mockResult = { records: [], rowCount: 0 };

    const user = await new UserService(db).findById(999);

    expect(user).toBeNull();
  });

  test('findAll() resolves an empty array for an empty relation', async () => {
    const db = new MockDatabase();
    db.mockResult = { records: [], rowCount: 0 };

    const rows = await new UserService(db).findAll();

    expect(rows).toEqual([]);
    expect(db.executedQueries[0].query).toBe('SELECT * FROM users');
  });

  test('createQueryService() produces an equivalent relation-bound class', async () => {
    const db = new MockDatabase();
    db.mockResult = { records: [{ id: 5, name: 'Eve', email: 'eve@test.com', active: true }], rowCount: 1 };

    const UserQueryService = createQueryService<User>('users', 'id');
    const service = new UserQueryService(db);
    const user = await service.findById(5);

    expect(service.relation).toBe('users');
    expect(service.idColumn).toBe('id');
    expect(user?.name).toBe('Eve');
  });

  test('custom subclass methods reuse the inherited query helpers', async () => {
    const db = new MockDatabase();
    db.mockResult = { records: [{ id: 2, name: 'Bob', active: true }], rowCount: 1 };

    const rows = await new UserService(db).findActive();

    expect(rows).toHaveLength(1);
    expect(db.executedQueries[0].query).toContain('WHERE');
  });
});
```

### Public API Surface

A smoke test that every documented runtime export exists catches packaging regressions (missing exports map entries, broken re-exports) immediately after an upgrade:

```typescript
import { describe, expect, test } from 'vitest';
import * as dbcore from 'blendsdk/dbcore';

const runtimeExports = [
  'CrudStatement',
  'DataServiceBase',
  'Database',
  'DeleteStatement',
  'FilterableStatement',
  'FromStatement',
  'InsertStatement',
  'QueryDataService',
  'Statement',
  'UpdateStatement',
  'createQueryService',
] as const;

describe('public API surface', () => {
  test('every runtime export is defined', () => {
    for (const name of runtimeExports) {
      expect(dbcore[name]).toBeDefined();
    }
  });

  test('classes are constructible functions and the factory is callable', () => {
    expect(typeof dbcore.Database).toBe('function');
    expect(typeof dbcore.QueryDataService).toBe('function');
    expect(typeof dbcore.createQueryService).toBe('function');
  });
});
```

---

Every pattern above is adapted from the package's own suite, which remains the source of truth: see `tests/statement.test.ts` for the base statement and hook contracts, `tests/crud-statements.test.ts` for the CRUD and filterable builders, `tests/from-statement.test.ts` for SELECT building, `tests/query-dataservice.test.ts` for data services, and `tests/sanity.test.ts` for the export surface. Expression types (`CompileResult`, `QueryBuilder`) and the `query()` factory used throughout these tests are imported directly from `blendsdk/expression` — they are not re-exported by `blendsdk/dbcore`.

---

# dbcore Troubleshooting

This guide covers the failures you are most likely to hit with `blendsdk/dbcore`: TypeScript diagnostics produced by the strict typing of its builder hierarchy, runtime errors caused by its deliberate "no driver" design, and the contracts a concrete `Database` adapter must honor. Each issue is documented as **Symptom → Cause → Fix** with a working example. Snippets that intentionally fail to compile or are illustrative only are marked as `typescript fragment` and annotated with ❌/✅.

Most fixes in this document reference a `RecordingDatabase` adapter — a minimal, fully typed `Database` implementation that records every statement instead of talking to a real engine. It is defined in the first issue below and is the foundation for reproducing bugs and for writing tests against the package.

---

## Common Errors

Because the package ships only abstract contracts, most failures fall into two buckets: the TypeScript compiler telling you that a contract is incomplete or mismatched, and runtime failures caused by adapters (or test doubles) that do not honor the `Database` contract. The issues below are grouped accordingly.

### TypeScript Compiler Errors

#### TS2511: Cannot create an instance of an abstract class

**Symptom**

```text
error TS2511: Cannot create an instance of the abstract class 'Database'.
error TS2511: Cannot create an instance of the abstract class 'InsertStatement'.
error TS2511: Cannot create an instance of the abstract class 'QueryDataService'.
```

**Cause**

Every core type in the package is abstract by design: `Database`, `Statement`, `CrudStatement`, `FilterableStatement`, `InsertStatement`, `UpdateStatement`, `DeleteStatement`, `DataServiceBase`, and `QueryDataService`. The package ships no database driver, so nothing can execute queries until a concrete adapter supplies the database-specific logic. `FromStatement` is the only directly instantiable statement class — and even it should be created through `db.from()` / `db.selectAll()`, not with `new`.

The following lines do not compile:

```typescript fragment
// ❌ all of these fail with TS2511
// const db = new Database({ database: 'users' });
// const insert = new InsertStatement('users', db);
// const service = new QueryDataService('users', 'id', db);
```

**Fix**

1. Create a concrete `Database` subclass (a real adapter in production; the recording adapter below for tests and diagnostics).
2. Create statement builders exclusively through the instance factory methods: `db.insert()`, `db.update()`, `db.delete()`, `db.from()`, and `db.selectAll()`.
3. Create data services through `createQueryService()` or by subclassing `QueryDataService`.

The class below implements every abstract member of `Database` plus the three abstract CRUD builders. It records each statement into `executed`, which every other issue in this document uses for verification.

```typescript
import {
  Database,
  DeleteStatement,
  ExecuteQueryOptions,
  InsertStatement,
  QueryResult,
  UpdateStatement,
  createQueryService,
} from 'blendsdk/dbcore';

interface Note {
  id: number;
  title: string;
  done: boolean;
}

/** Concrete INSERT builder used by RecordingDatabase. */
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

/** Concrete UPDATE builder used by RecordingDatabase. */
class RecordingUpdateStatement<T, F> extends UpdateStatement<T, F> {
  protected buildQuery(): string {
    const assignments = Object.keys(this._values).map((column) => `${column} = :v_${column}`);
    const filter = this.getCompiledExpression();
    const where = filter && filter.sql.length > 0 ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `UPDATE ${this.tableName} SET ${assignments.join(', ')}${where}${returning}`;
  }

  protected buildParameters(): Record<string, unknown> {
    const params: Record<string, unknown> = {};
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

/** Concrete DELETE builder used by RecordingDatabase. */
class RecordingDeleteStatement<F> extends DeleteStatement<F> {
  protected buildQuery(): string {
    const filter = this.getCompiledExpression();
    const where = filter && filter.sql.length > 0 ? ` WHERE ${filter.sql}` : '';
    const returning = this._returning.length > 0 ? ` RETURNING ${this._returning.join(', ')}` : '';
    return `DELETE FROM ${this.tableName}${where}${returning}`;
  }

  protected buildParameters(): Record<string, unknown> {
    const filter = this.getCompiledExpression();
    return filter ? { ...filter.params } : {};
  }
}

/** Minimal concrete adapter: records every statement and replays a canned result. */
export class RecordingDatabase extends Database {
  readonly executed: Array<{ query: string; params?: Record<string, unknown> }> = [];
  result: QueryResult<unknown> = { records: [], rowCount: 0 };

  async connect(): Promise<void> {
    this.executed.length = 0;
  }

  async disconnect(): Promise<void> {
    this.executed.length = 0;
  }

  async executeQuery<R>(
    query: string,
    params?: Record<string, unknown>,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null> {
    const finalParams = options?.beforeQuery && params ? options.beforeQuery(params) : params;
    const rows = options?.afterQuery ? options.afterQuery(this.result.records) : this.result.records;
    this.executed.push({ query, params: finalParams });
    return { records: rows as R[], rowCount: this.result.rowCount };
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

const NoteQueryService = createQueryService<Note>('notes', 'id');

/** Exercises every factory path and returns the recorded SQL. */
export async function captureSql(): Promise<string[]> {
  const db = new RecordingDatabase({ database: 'demo' });
  db.result = { records: [{ id: 1, title: 'First' }], rowCount: 1 };
  await db.connect();

  await db.insert<Note>('notes').values({ title: 'First' }).returning('*').executeReturnSingle();
  await db
    .update<Note, Pick<Note, 'id'>>('notes')
    .values({ done: true })
    .filter({ id: 1 })
    .executeReturnCount();
  await db.delete<Pick<Note, 'id'>>('notes').filter({ id: 1 }).returning('*').executeReturnAll();
  await db.from<Note>('notes').select(['id', 'title']).executeReturnAll();

  const service = new NoteQueryService(db);
  await service.findById(1);

  const statements = db.executed.map((entry) => entry.query);
  await db.disconnect();
  return statements;
}
```

In production, replace the body of `executeQuery()` with a call to your driver and keep everything else — the factory methods, the typed builders, and the execution helpers — unchanged.

---

#### TS2515: Non-abstract class does not implement inherited abstract member

**Symptom**

```text
error TS2515: Non-abstract class 'HalfInsertStatement' does not implement inherited abstract member 'buildParameters' from class 'InsertStatement<T>'.
```

A concrete `Database` subclass in the same situation reports one error per missing member (`connect`, `disconnect`, `executeQuery`, `withTransaction`, `insert`, `update`, `delete`).

**Cause**

`Statement` declares two protected abstract methods — `buildQuery(): string` and `buildParameters(): any` — and `Database` declares seven abstract members. When writing an adapter, it is easy to implement one method and forget its counterpart; until every abstract member exists, TypeScript refuses to treat the class as concrete. The following class is missing `buildParameters()`:

```typescript fragment
// ❌ TS2515: buildParameters() is missing
class HalfInsertStatement<T> extends InsertStatement<T> {
  protected buildQuery(): string {
    const columns = Object.keys(this._values);
    return `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${columns
      .map((column) => `:${column}`)
      .join(', ')})`;
  }
}
```

**Fix**

Implement every abstract member. The completed statement shows the pairing:

```typescript
import { InsertStatement } from 'blendsdk/dbcore';

interface Article {
  id: number;
  title: string;
}

export class ArticleInsertStatement extends InsertStatement<Article> {
  protected buildQuery(): string {
    const columns = Object.keys(this._values);
    const placeholders = columns.map((column) => `:${column}`);
    return `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
  }

  protected buildParameters(): Partial<Article> {
    return this._values;
  }
}
```

For a `Database` subclass, use the member checklist: `connect()`, `disconnect()`, `executeQuery()` (one implementation covering all three call shapes), `withTransaction()`, `insert()`, `update()`, and `delete()`. The `RecordingDatabase` above shows all seven.

---

#### TS2305: Module has no exported member — expression types imported from the wrong package

**Symptom**

```text
error TS2305: Module '"blendsdk/dbcore"' has no exported member 'query'.
error TS2305: Module '"blendsdk/dbcore"' has no exported member 'QueryBuilder'.
error TS2305: Module '"blendsdk/dbcore"' has no exported member 'CompileResult'.
```

**Cause**

The expression DSL lives in `blendsdk/expression` and is deliberately not re-exported by `blendsdk/dbcore`. dbcore consumes compiled expressions at its boundaries (`byExpression()`, `filterByExpression()`) but does not own the DSL.

**Fix**

1. Import runtime values (`query`) and types (`QueryBuilder`, `CompileResult`) directly from `blendsdk/expression`.
2. Keep importing database types (`Database`, `QueryResult`, and so on) from `blendsdk/dbcore`.
3. Declare `blendsdk/expression` in your own `package.json` if you import it directly — do not rely on it being a transitive dependency of dbcore.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';
import type { CompileResult } from 'blendsdk/expression';

interface User {
  id: number;
  email: string;
}

export async function findByEmail(db: Database, email: string): Promise<Partial<User> | null> {
  const filter: CompileResult = query<User>().where('email').equals(email).compile();
  return db.from<User>('users').select(['id', 'email']).byExpression(filter).executeReturnSingle();
}
```

---

#### TS2558: Expected 2 type arguments, but got 1

**Symptom**

```text
error TS2558: Expected 2 type arguments, but got 1.
```

Raised by a call such as `db.update<User>('users')`.

**Cause**

`update<T, F>()` has two independent type parameters: `T` is the table shape used by `values()` and `returning()`, while `F` is the (typically narrower) filter shape used by `filter()`. TypeScript does not allow providing only the first of two type arguments — it is all or nothing.

**Fix**

Supply both type arguments, using `Pick` to narrow the filter shape. Naming the two concepts separately is the intended design:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  role: string;
}

export async function demote(db: Database, id: number): Promise<number> {
  // ❌ db.update<User>('users') → TS2558: Expected 2 type arguments, but got 1.
  return db
    .update<User, Pick<User, 'id'>>('users')
    .values({ role: 'member' })
    .filter({ id })
    .executeReturnCount();
}
```

`insert<T>()`, `from<T>()`, and `selectAll<T>()` take a single type argument; only `update<T, F>()` requires two. `delete<F>()` also takes one — its filter type doubles as the statement's table type.

---

#### TS2345: returning() rejects a pre-declared string array

**Symptom**

```text
error TS2345: Argument of type 'string[]' is not assignable to parameter of type '(keyof User)[] | "*"'.
```

**Cause**

`returning()` is typed `returning(fields: (keyof TableType)[] | '*'): this`. Inline array literals are contextually typed and accepted, but a variable inferred as `string[]` (built from config, `.map()`, or `.filter()`) is wider than `(keyof TableType)[]` and rejected.

**Fix**

Type the array at its declaration site so the keys stay constrained:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
}

const defaultReturnColumns: (keyof User)[] = ['id', 'name'];

export async function createUser(
  db: Database,
  name: string,
  email: string
): Promise<Partial<User> | null> {
  return db
    .insert<User>('users')
    .values({ name, email })
    .returning(defaultReturnColumns)
    .executeReturnSingle();
}
```

`returning(['id', 'name'])` inline also compiles (contextual typing), and `returning('*')` returns all columns. For genuinely dynamic column lists, keep the cast at the declaration with the narrowest target type:

```typescript fragment
const columns: (keyof User)[] = configuredColumns as (keyof User)[];
```

---

#### TS2345: filterByExpression builder must return the QueryBuilder

**Symptom**

```text
error TS2345: Argument of type '(q: QueryBuilder<{ id: number }>) => void' is not assignable to parameter of type '(q: QueryBuilder<{ id: number }>) => QueryBuilder<{ id: number }>'.
  Type 'void' is not assignable to type 'QueryBuilder<{ id: number }>'.
```

**Cause**

`filterByExpression()` requires the callback to return the (possibly extended) builder: `(q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>`. An arrow function with a block body and no `return` statement yields `void`, which fails the return-type check. Confusingly, `QueryDataService.findByExpression()` and `findAllByExpression()` accept `ExpressionBuilder<T> = (q: QueryBuilder<T>) => void` — in those methods a block-bodied callback without a return is perfectly fine. The two contracts differ.

**Fix**

Return the builder from the callback — either with a concise arrow body or an explicit `return`:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  age: number;
}

export async function deleteMinors(db: Database): Promise<number> {
  return db
    .delete<User>('users')
    .filterByExpression((q) => q.where('age').lessThan(18))
    .executeReturnCount();
}

export async function deleteMinorsBlockBody(db: Database): Promise<number> {
  return db
    .delete<User>('users')
    .filterByExpression((q) => {
      const builder = q.where('age').lessThan(18);
      return builder;
    })
    .executeReturnCount();
}
```

The `void`-returning style remains correct for the data service layer:

```typescript fragment
// ✅ QueryDataService accepts void-returning builders
service.findByExpression((q) => {
  q.where('email').equals('alice@example.com');
});
```

---

#### TS2339: Property does not exist on this statement type

**Symptom**

```text
error TS2339: Property 'filter' does not exist on type 'FromStatement<User>'.
error TS2339: Property 'where' does not exist on type 'FromStatement<User>'.
error TS2339: Property 'values' does not exist on type 'DeleteStatement<User>'.
```

**Cause**

The statement builders split into two families with different APIs:

- **SELECT family** — `FromStatement<T>`: `select()` plus `byExpression(CompileResult)`. It consumes an already-compiled expression.
- **CRUD family** — `InsertStatement`, `UpdateStatement`, `DeleteStatement`: `values()`, `filter()`, `filterByExpression()`, and `returning()`. These compile filters internally.

No builder exposes a raw `where()` method — string-building lives in `blendsdk/expression`. If you start a chain with `db.from()`, you are in the SELECT family and must compile the filter yourself before calling `byExpression()`.

**Fix**

Use the family that matches the operation; compile expressions for SELECT chains:

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  active: boolean;
}

export async function listActiveUsers(db: Database): Promise<Partial<User>[]> {
  const filter = query<User>().where('active').equals(true).compile();
  return db.from<User>('users').select(['id', 'name']).byExpression(filter).executeReturnAll();
}

export async function deactivateUser(db: Database, id: number): Promise<number> {
  // The CRUD family compiles its own filters — no byExpression() here.
  return db
    .update<User, Pick<User, 'id'>>('users')
    .values({ active: false })
    .filter({ id })
    .executeReturnCount();
}
```

---

#### TS18047: 'result' is possibly 'null' after execute()

**Symptom**

```text
error TS18047: 'result' is possibly 'null'.
```

**Cause**

`Statement.execute()` resolves `Promise<R | null>` — adapters may resolve `null` when the driver returns no result set. The four helper methods absorb this (`executeReturnSingle()`, `executeReturnAll()`, `executeReturnCount()`), but direct consumers of `execute()` must narrow the result themselves.

**Fix**

Prefer the helpers; when you call `execute()` directly (for example, to read `rowCount` and `records` together), narrow the result:

```typescript
import { Database, QueryResult } from 'blendsdk/dbcore';

interface CountRow {
  total: number;
}

export async function countOrders(db: Database): Promise<number> {
  const result = await db
    .from<CountRow>('orders')
    .select({ total: 'COUNT(*)' })
    .execute<QueryResult<CountRow>>();

  // ❌ result.records → TS18047: 'result' is possibly 'null'.
  // ✅ narrow first, then unwrap defensively.
  if (!result) {
    return 0;
  }
  return result.records[0]?.total ?? 0;
}
```

Note that a non-null result does not guarantee a `records` array — see the `executeReturnSingle()` TypeError issue below.

---

#### TS2307: Cannot find module 'blendsdk/dbcore'

**Symptom**

```text
error TS2307: Cannot find module 'blendsdk/dbcore' or its corresponding type declarations.
```

In editors you may instead see: `Could not find a declaration file for module 'blendsdk/dbcore'`.

**Cause**

The package is ESM-only and exposes its entry point exclusively through the `exports` map (`./dist/index.d.ts` + `./dist/index.js`, `import` condition only). There is no top-level `main` or `types` field. TypeScript configurations using legacy resolution (`"moduleResolution": "node"` / `"node10"`) ignore `exports` maps entirely and cannot find the package, even though it is installed.

**Fix**

1. Switch to `NodeNext` (or `Bundler`) resolution so the `exports` map is honored.
2. Make the consuming file an ES module (`"type": "module"` in your `package.json` or a `.mts` file).
3. Re-run `npx tsc --noEmit` to confirm the resolution error disappears.

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true
  }
}
```

After the configuration change, the plain package-root import works:

```typescript fragment
import { Database, createQueryService } from 'blendsdk/dbcore';
```

### Runtime Errors

#### ERR_REQUIRE_ESM: require() of an ES Module is not supported

**Symptom**

```text
Error [ERR_REQUIRE_ESM]: require() of ES Module /app/node_modules/blendsdk/dbcore/dist/index.js not supported.
```

In CommonJS-transpiling test runners (classic Jest setups), the same root cause appears as:

```text
SyntaxError: Cannot use import statement outside a module
```

**Cause**

`blendsdk/dbcore` is pure ESM: `"type": "module"` and an `exports` map with only an `import` condition, no `require` condition. `require()`-based loaders and test runners that transpile ESM syntax to CommonJS cannot load it. (Recent Node.js versions gain `require(esm)` support, but CJS-transform test environments still trip on the syntax.)

**Fix**

1. Run the package on Node.js >= 22.0.0.
2. Convert your entry points and test configuration to ESM (`"type": "module"` in `package.json`). The Vitest setup used by this package is ESM-native and works without extra configuration.
3. If part of your application must stay CommonJS, load dbcore with a dynamic `import()` — the returned module namespace is fully typed:

```typescript
import type { Database, QueryDataService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
}

export async function createUserService(db: Database): Promise<QueryDataService<User>> {
  const { createQueryService } = await import('blendsdk/dbcore');
  const UserService = createQueryService<User>('users', 'id');
  return new UserService(db);
}
```

---

#### ERR_PACKAGE_PATH_NOT_EXPORTED: deep imports are blocked

**Symptom**

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/database.js' is not defined by "exports" in /app/node_modules/blendsdk/dbcore/package.json
```

**Cause**

The `exports` map exposes exactly one subpath: the package root (`"."`). Deep paths such as `blendsdk/dbcore/dist/database.js` are rejected by Node.js before any module code runs — this is deliberate encapsulation, not a missing build artifact.

**Fix**

Import everything from the package root; the root re-exports the entire public API:

```typescript
import { Database } from 'blendsdk/dbcore';

export function isDatabase(value: unknown): value is Database {
  return value instanceof Database;
}
```

```typescript fragment
// ❌ blocked by the exports map
// import { Database } from 'blendsdk/dbcore/dist/database.js';

// ✅ the package root re-exports the public API
import { Database } from 'blendsdk/dbcore';
```

---

#### SELECT queries return empty columns, or the database rejects them near 'FROM'

**Symptom**

`db.from('users').executeReturnAll()` executes, but the rows come back with no fields (PostgreSQL accepts `SELECT FROM users` and returns zero-column rows), or the driver rejects the statement:

```text
syntax error at or near "FROM"   -- e.g., MySQL, for "SELECT  FROM users"
```

**Cause**

`FromStatement` starts with an empty `_selectColumns` array. Only calling `select()` normalizes the column list — with no argument it becomes `['*']`. Skipping `select()` entirely, or passing an empty array/object (`select([])` / `select({})`), leaves the list empty, and `buildQuery()` renders `SELECT  FROM users`. The same applies to `QueryDataService` subclasses that bypass `select()` when extending the service.

**Fix**

Always call `select()` — bare `select()` means `*` — or use `db.selectAll()`, which is `from(table).select()` built in:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
}

export async function allUsers(db: Database): Promise<Partial<User>[]> {
  // ✅ select() with no argument selects *
  return db.from<User>('users').select().executeReturnAll();
}

export async function allUsersShorthand(db: Database): Promise<Partial<User>[]> {
  // ✅ selectAll() is from(table).select() built in
  return db.selectAll<User>('users').executeReturnAll();
}
```

---

#### SQL syntax error from an empty filter (dangling WHERE)

**Symptom**

Statements that "have no filter" fail to parse, and the SQL sent to the database looks truncated:

```text
UPDATE users SET name = :v_name WHERE
SELECT id FROM users WHERE
```

Drivers report this as a syntax error at the end of input (PostgreSQL) or a generic SQL syntax error (MySQL).

**Cause**

`filter({})` still registers an expression builder — it passes the builder through unchanged — and compiling it yields an empty predicate. `FromStatement.byExpression()` has the same behavior: it prefixes `WHERE` unconditionally, so applying an empty `CompileResult` produces a dangling `WHERE `. Adapters that render ` WHERE ${filter.sql}` without a guard then emit malformed SQL.

**Fix**

1. Only call `filter()`, `filterByExpression()`, or `byExpression()` when you actually have criteria.
2. Render the WHERE clause only when the compiled SQL is non-empty (guard shown below — the recording builders above already use it).

```typescript fragment
// typescript fragment — adapter-side guard against empty compiled predicates
const filter = this.getCompiledExpression();
const where = filter && filter.sql.length > 0 ? ` WHERE ${filter.sql}` : '';
```

A service method that refuses to run unfiltered, and only adds criteria when present:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  email: string;
  status: string;
}

export async function archiveMatching(
  db: Database,
  criteria: Partial<Pick<User, 'id' | 'email'>>
): Promise<number> {
  if (Object.keys(criteria).length === 0) {
    throw new Error('archiveMatching requires at least one criterion — refusing to update every row');
  }

  return db
    .update<User, Pick<User, 'id' | 'email'>>('users')
    .values({ status: 'archived' })
    .filter(criteria)
    .executeReturnCount();
}
```

Keep in mind that if you never call a filter method at all, the reference adapters build an unfiltered `UPDATE` / `DELETE` that affects every row — guard service methods accordingly.

---

#### TypeError: Cannot read properties of undefined (reading '0') from executeReturnSingle()

**Symptom**

```text
TypeError: Cannot read properties of undefined (reading '0')
```

Thrown by `executeReturnSingle()` after a query that otherwise succeeded.

**Cause**

`executeReturnSingle()` unwraps the result as `result?.records[0] || null`. The optional chaining guards `result` being `null` — but if the adapter resolves a `QueryResult` without a `records` array (for example `{ rowCount: 1 }` straight from a driver that names the field `rows`), then `records[0]` throws. Adapters must always resolve `records` as an array, empty when nothing matched.

**Fix**

1. Adapter side: normalize the driver result before resolving.

```typescript fragment
// typescript fragment — adapter must always resolve a records array
return {
  records: driverRows ?? [],
  rowCount: driverRowCount ?? 0,
};
```

2. Consumer side (until the adapter conforms): `executeReturnAll()` tolerates a missing array (`result?.records || []`), so unwrap through it.

```typescript
import { Database } from 'blendsdk/dbcore';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
}

export async function findUserSafe(db: Database, id: number): Promise<Partial<User> | null> {
  const filter = query<User>().where('id').equals(id).compile();
  // ✅ executeReturnAll() tolerates a missing `records` array; executeReturnSingle() does not
  const rows = await db.from<User>('users').select().byExpression(filter).executeReturnAll();
  return rows[0] ?? null;
}
```

---

#### beforeQuery / afterQuery hooks have no effect

**Symptom**

Handlers registered with `beforeQuery()` or `afterQuery()` chain without error, but the database receives untransformed parameters and the rows returned are unchanged. No exception is raised.

**Cause**

`Statement.execute()` only forwards the handlers — it does not invoke them:

```typescript fragment
// typescript fragment — from Statement.execute(): forwarding only
const options: ExecuteQueryOptions = {};
if (this._beforeQuery) {
  options.beforeQuery = this._beforeQuery;
}
if (this._afterQuery) {
  options.afterQuery = this._afterQuery;
}
return this.db.executeQuery(this.buildQuery(), this.buildParameters(), options);
```

Applying `options.beforeQuery` and `options.afterQuery` is the adapter's responsibility. Any adapter (or test double) whose `executeQuery()` ignores its third argument silently disables both hooks.

**Fix**

1. Consumer side: no changes needed — hooks are registered per statement and fire through conforming adapters.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
}

export async function withHooks(db: Database): Promise<Partial<User>[]> {
  return db
    .from<User>('users')
    .select(['id', 'name'])
    .beforeQuery<Record<string, unknown>>((params) => ({ ...params, tenant: 'acme' }))
    .afterQuery<Partial<User>[]>((rows) => rows.map((row) => ({ ...row, name: row.name ?? '' })))
    .executeReturnAll();
}
```

2. Adapter side: apply both hooks around the driver call.

```typescript fragment
// typescript fragment — the adapter's responsibility
const finalParams = options?.beforeQuery && params ? options.beforeQuery(params) : params;
const rows = options?.afterQuery ? options.afterQuery(result.records) : result.records;
```

3. If you cannot change the adapter, transform at the call site instead:

```typescript fragment
const rows = await db.from<User>('users').select().executeReturnAll();
const normalized = rows.map((row) => ({ ...row, createdAt: new Date(String(row.created_at)) }));
```

---

#### executeReturnCount() returns 0 after rows were changed

**Symptom**

After a successful INSERT, UPDATE, or DELETE, `executeReturnCount()` resolves `0` even though the operation definitely modified rows. Calling `execute()` directly and inspecting `QueryResult.rowCount` shows `undefined`.

**Cause**

`executeReturnCount()` returns `result?.rowCount || 0`. If the adapter does not map the driver's affected-row count into `rowCount` (drivers variously call it `affectedRows`, `changes`, or similar), the helper cannot distinguish "no rows changed" from "adapter did not report", and both collapse to `0`.

**Fix**

1. Adapter side: map the driver's count into `rowCount` for every execution.

```typescript fragment
// typescript fragment — map the driver's affected-row count
return {
  records: rows,
  rowCount: driverResult.affectedRows ?? driverResult.rowCount ?? 0,
};
```

2. Consumer side: use `execute()` once to distinguish an unreported count (`undefined`) from a genuine `0` while diagnosing.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  active: boolean;
}

export async function deactivateAndReport(db: Database, id: number): Promise<number | null> {
  const result = await db
    .update<User, Pick<User, 'id'>>('users')
    .values({ active: false })
    .filter({ id })
    .execute();

  // null = the adapter did not report a count; 0 = genuinely no rows affected
  return result?.rowCount ?? null;
}
```

Note that a `null` result from an adapter also yields `0` from `executeReturnCount()` — another reason to verify `rowCount` is populated during adapter development.

---

## Debugging Strategies

The procedures below are ordered from cheapest to most involved. Steps 1–3 isolate whether the problem is in the statement builder or in the adapter; steps 4–6 verify the environment and lock in a fix.

### 1. Capture the exact SQL and parameters with a recording adapter

The single most useful technique with this package: replace the real database with the `RecordingDatabase` from [Common Errors](#ts2511-cannot-create-an-instance-of-an-abstract-class) (or copy it into your project's test utilities) and execute the failing flow against it.

1. Instantiate `RecordingDatabase` instead of your real adapter.
2. Run the reproduction.
3. Inspect `executed` — every entry contains the exact `query` string and the final `params` object handed to the adapter.

```typescript fragment
// Reuses the RecordingDatabase class defined earlier in this document.
const db = new RecordingDatabase({ database: 'demo' });
await db.connect();

await db.from<User>('users').select(['id', 'name']).executeReturnAll();

console.log(db.executed);
// [ { query: 'SELECT id, name FROM users', params: {} } ]
```

If the recorded SQL and parameters are what you expected, the bug is in the real adapter or driver integration. If they are not, the bug is in how the statement was composed.

### 2. Compare the recorded statement against the symptom table

Match what you see in `db.executed` against the likely cause:

| Observable in the recording | Likely cause |
| --- | --- |
| `SELECT  FROM users` (missing column list) | `select()` was never called — see the select runtime issue above |
| SQL ends in a dangling `WHERE` | Empty filter or empty `CompileResult` — see the empty-filter issue above |
| WHERE clause matches an older filter than the one you just set | The compiled-filter cache — see Known Pitfalls |
| `params` look untransformed although hooks were registered | Adapter ignores `ExecuteQueryOptions` — see the hooks issue above |
| No statements recorded at all | You executed against a different `Database` instance, or never reached the call site |

### 3. Tap parameters and rows with hooks

For live debugging (when you cannot swap in a recording adapter), add temporary pass-through handlers:

```typescript fragment
// typescript fragment — requires an adapter that honors ExecuteQueryOptions
statement.beforeQuery<Record<string, unknown>>((params) => {
  console.log('[dbcore] params:', params);
  return params;
});

statement.afterQuery<Partial<User>[]>((rows) => {
  console.log('[dbcore] rows:', rows.length, rows[0]);
  return rows;
});
```

Remember: if the adapter ignores `ExecuteQueryOptions`, the taps never fire — which is itself the answer to "why is my transformation not applied?".

### 4. Verify the runtime environment

Module-level failures are almost always configuration. Run these checks before debugging any query logic:

1. Confirm Node.js meets the requirement: `node --version` must report `>= v22.0.0`.
2. Smoke-test the package import in isolation:

```bash
node --input-type=module -e "const m = await import('blendsdk/dbcore'); console.log(Object.keys(m).join(', '))"
```

The command must print the export names (`Database`, `Statement`, `InsertStatement`, …, `createQueryService`) without error. An `ERR_REQUIRE_ESM` or `ERR_PACKAGE_PATH_NOT_EXPORTED` here confirms an environment issue, not a query issue.

3. Run the strict type-checker against your project to surface resolution or typing regressions:

```bash
npx tsc --noEmit
```

### 5. Walk the adapter conformance checklist

If the recording adapter produces correct SQL but the real adapter fails, verify the adapter honors each clause of the `Database` contract:

1. **Parameters forwarded** — the implementation must accept and bind the second `executeQuery` argument; a single-parameter implementation compiles but silently drops bound values.
2. **Options applied** — `options.beforeQuery` runs before execution; `options.afterQuery` is applied to the rows before resolving.
3. **Records always an array** — resolve `records: []` for empty result sets; never omit the field.
4. **Row count populated** — map the driver's affected/returned row count into `rowCount` (returned for SELECT, affected for INSERT/UPDATE/DELETE).
5. **All three call shapes supported** — a single implementation must handle query-only, query-plus-params, and query-plus-params-plus-options calls.
6. **Transactions use the transactional handle** — statements created inside `withTransaction` must execute on the transactional connection, and rollback must undo them.
7. **WHERE only when non-empty** — render the compiled filter only when `filter.sql` has content.

### 6. Lock the repro into a test

Once identified, keep the failing case as a regression test using the recording adapter. Assert on the recorded statement instead of on database state:

```typescript fragment
// typescript fragment — assertion pattern used by the package's own test suite
await db
  .update<Note, Pick<Note, 'id'>>('notes')
  .values({ done: true })
  .filter({ id: 1 })
  .executeReturnCount();

expect(db.executed[0].query).toContain('WHERE');
expect(Object.values(db.executed[0].params ?? {})).toContain(1);
```

When working inside the BlendSDK monorepo itself, run the package's suite directly — it is Vitest-based: `npm test` (or `npm run test:watch` while iterating).

---

## Known Pitfalls

### 1. Filters added after the first execution are silently ignored

`FilterableStatement` compiles the expression builder on first use and caches the `CompileResult` in `_compiledExpression`. The cache is never invalidated: calling `filter()` or `filterByExpression()` after the statement has been executed once updates `_expressionBuilder` but not `_compiledExpression`, so the new criterion is silently dropped.

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  active: boolean;
}

export async function deactivateBoth(db: Database): Promise<number> {
  const statement = db.update<User, Pick<User, 'id'>>('users').values({ active: false }).filter({ id: 1 });

  await statement.executeReturnCount(); // compiles and caches the filter (id = 1)

  statement.filter({ id: 2 }); // ❌ ignored — the compiled expression is already cached

  // Still executes "WHERE id = 1".
  return statement.executeReturnCount();
}

export async function deactivateTheRightWay(db: Database, ids: number[]): Promise<number> {
  let affected = 0;
  for (const id of ids) {
    // ✅ new statement per operation: nothing is cached between executions
    affected += await db
      .update<User, Pick<User, 'id'>>('users')
      .values({ active: false })
      .filter({ id })
      .executeReturnCount();
  }
  return affected;
}
```

Treat statement instances as single-use builders: configure, execute, discard.

### 2. values() replaces the payload — it does not merge

`values()` assigns its argument to `_values` outright. Calling it twice keeps only the second payload, which is easy to miss when building payloads incrementally.

```typescript fragment
// typescript fragment — ❌ only the last payload survives
statement.values({ name: 'Ada' });
statement.values({ email: 'ada@example.com' }); // replaces { name: 'Ada' }

// ✅ merge locally, then call values() once
statement.values({ ...base, email: 'ada@example.com' });
```

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
  email: string;
}

export async function setContact(
  db: Database,
  id: number,
  base: Partial<User>,
  email: string
): Promise<number> {
  return db
    .update<User, Pick<User, 'id'>>('users')
    .values({ ...base, email })
    .filter({ id })
    .executeReturnCount();
}
```

### 3. Transactions: use the handle passed to the callback

`withTransaction(fn)` invokes `fn` with the transactional database handle. Statements built from the outer `db` reference may run on a different connection (depending on the adapter) and escape the transaction — they will survive a rollback.

```typescript
import { Database } from 'blendsdk/dbcore';

interface AuditEntry {
  id: number;
  message: string;
}

export async function transfer(db: Database, message: string): Promise<void> {
  await db.withTransaction(async (tx) => {
    // ✅ runs on the transaction handle and rolls back with the transaction
    await tx.insert<AuditEntry>('audit').values({ message }).executeReturnCount();

    // ❌ statements from the outer `db` may execute on a different connection
    // await db.insert<AuditEntry>('audit').values({ message }).executeReturnCount();
  });
}
```

### 4. Only values are parameterized — identifiers are interpolated

Values bound through filters become query parameters, but identifiers — table names, `select()` columns and aliases, and filter column keys — are interpolated into the SQL text verbatim by design. Never route untrusted input into an identifier position.

```typescript fragment
// typescript fragment — identifiers are interpolated; values are parameterized
const filter = query<User>().where('email').equals(emailInput).compile(); // ✅ emailInput is bound as a parameter

const unsafe = db.from(tableNameFromRequest); // ❌ table name goes into the SQL string verbatim — never do this
const alsoUnsafe = db.from<User>('users').select([columnNameFromRequest]); // ❌ same for column names
```

Keep identifiers in code (or validate them against a strict allow-list) and let user input flow only into `.equals()`, `.greaterThan()`, and other value-taking expression methods.

### 5. createQueryService() returns a new class on every call — hoist it

Each call to `createQueryService()` creates a fresh anonymous subclass. Calling it per request produces distinct constructors, which breaks `instanceof` comparisons between services and defeats per-class caching and profiling.

```typescript fragment
// typescript fragment — ❌ a fresh anonymous class on every call
const service = new (createQueryService<User>('users', 'id'))(db);
```

```typescript
import { Database, createQueryService } from 'blendsdk/dbcore';

interface User {
  id: number;
  name: string;
}

// ✅ one class per relation, many instances
export const UserQueryService = createQueryService<User>('users', 'id');

export function buildUserService(db: Database): InstanceType<typeof UserQueryService> {
  return new UserQueryService(db);
}
```

### 6. Single-record helpers do not add LIMIT — the full match set is fetched

`executeReturnSingle()` (and therefore `QueryDataService.findByExpression()`) returns `records[0]`, but the SQL it executes has no `LIMIT`. For a filter that matches many rows, the database still produces the entire result set and the client discards all but the first record.

`findById()` is safe by construction — it filters on the primary-key column — but expression-based lookups on non-unique columns are not. When only the first match is needed, execute a bounded query directly:

```typescript
import { Database } from 'blendsdk/dbcore';

interface User {
  id: number;
  email: string;
  created_at: string;
}

export async function findNewestUser(db: Database): Promise<Partial<User> | null> {
  const result = await db.executeQuery<Partial<User>>(
    'SELECT id, email, created_at FROM users ORDER BY created_at DESC LIMIT 1'
  );
  return result?.records[0] ?? null;
}
```

### 7. Test doubles that record options but never apply them give false confidence

The package's own mock databases record `ExecuteQueryOptions` without invoking the handlers, and it is tempting to copy that pattern. A double written this way makes `beforeQuery` / `afterQuery` behavior untestable — your transformations appear to work in nothing and fail in nothing, silently. Make your double apply the hooks exactly as a real adapter must:

```typescript fragment
// typescript fragment — a test double must apply the same hooks a real adapter does
async executeQuery<R>(
  query: string,
  params?: Record<string, unknown>,
  options?: ExecuteQueryOptions
): Promise<QueryResult<R> | null> {
  const finalParams = options?.beforeQuery && params ? options.beforeQuery(params) : params;
  this.executed.push({ query, params: finalParams });
  return { records: this.result.records as R[], rowCount: this.result.rowCount };
}
```

The `RecordingDatabase` defined at the top of this document is a ready-made conforming double — reuse it rather than writing a looser one.

---

Most of the behaviors referenced here are explained in depth, with their design rationale, in Core Concepts. For complete signatures of every export used in these fixes, see the API Reference.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
