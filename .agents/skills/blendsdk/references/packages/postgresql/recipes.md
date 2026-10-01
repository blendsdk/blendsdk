> **Package**: `blendsdk/postgresql`

# postgresql Advanced Patterns

The Core Concepts companion documents each building block of `blendsdk/postgresql` in isolation. This document goes one level up: it presents complete patterns that combine transactions, statement builders, query hooks, compiled expressions, and pool lifecycle management to solve problems that appear in production code.

Every pattern follows the same structure: when to use it, a complete strict-mode TypeScript example, why the pattern works, and the caveats and performance considerations to keep in mind. The package's own Vitest suite exercises the same primitives in reduced form.

| Pattern | Solves | Combines |
| --- | --- | --- |
| [Transactional Multi-Step Workflows](#transactional-multi-step-workflows) | A business operation must succeed or fail as one unit | `withTransaction()`, `insert()` / `update()` builders, `RETURNING`, guarded raw `UPDATE`, `rowCount` |
| [Repository Layer over the Statement Builders](#repository-layer-over-the-statement-builders) | The same SQL gets repeated and drifts across modules | Generics, statement factories, terminal `execute*` methods, typed row interfaces |
| [Composable Query Hook Pipelines](#composable-query-hook-pipelines) | Normalization and redaction must happen on every path | `beforeQuery` / `afterQuery` on builders and `executeQuery()` options, function composition |
| [Conditional Query Composition for Search & Cleanup](#conditional-query-composition-for-search--cleanup) | Optional filters must be combined dynamically and safely | `blendsdk/expression`, `from().byExpression()`, `filter()`, `filterByExpression()` |
| [Optimistic Concurrency Control with Version Columns](#optimistic-concurrency-control-with-version-columns) | Concurrent edits must not silently overwrite each other | `update()`, version filters, `v_` parameter prefix, `executeReturnSingle()` / `executeReturnCount()` |
| [Atomic Audit Trails](#atomic-audit-trails) | "Who changed what" must be recorded with the change itself | `withTransaction()`, `SELECT ... FOR UPDATE`, builders with `RETURNING` |
| [Chunked Multi-Row Batch Inserts](#chunked-multi-row-batch-inserts) | Thousands of rows must be imported without one round trip each | `executeQuery()` with generated placeholders, chunking, `ON CONFLICT` |
| [Integration Tests with Rollback Isolation](#integration-tests-with-rollback-isolation) | Tests must exercise real SQL without leaving state behind | `withTransaction()`, deliberate rollback via sentinel error, TEMP tables |
| [Service Lifecycle & Graceful Shutdown](#service-lifecycle--graceful-shutdown) | Start-up and shutdown must be predictable and hang-free | `poolConfig`, `disconnect(timeout)`, shutdown guards, `enableGracefulShutdown` |

---

## Transactional Multi-Step Workflows

**When to use it:** A single business operation changes several tables and must stay consistent — placing an order, transferring funds, provisioning an account. Every step validates the previous one, and if any step fails the entire operation must roll back. This pattern also demonstrates the key decision rule: use the statement builders where they fit, and drop to raw `executeQuery` inside the same transaction where they cannot express the operation.

**Combines:** `withTransaction()`, `insert()` / `update()` builders with `RETURNING`, `executeReturnSingle()`, and a guarded raw `UPDATE` with `rowCount` checking.

### Complete example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Order {
  id: number;
  customer_id: number;
  status: string;
  total: number;
}

interface OrderItem {
  id?: number;
  order_id: number;
  product_id: number;
  quantity: number;
  unit_price: string;
}

interface ProductRow {
  id: number;
  name: string;
  price: string;
  stock: number;
}

interface CartLine {
  productId: number;
  quantity: number;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'shop',
  user: 'shop_service',
  pass: 'secret',
};

async function checkout(
  db: PostgreSQLDatabase,
  customerId: number,
  lines: CartLine[]
): Promise<Order> {
  return db.withTransaction(async tx => {
    const order = await tx
      .insert<Order>('orders')
      .values({ customer_id: customerId, status: 'pending', total: 0 })
      .returning('*')
      .executeReturnSingle();

    if (order === null) {
      throw new Error('Failed to create the order row');
    }

    let totalCents = 0;

    for (const line of lines) {
      // The UPDATE builder only assigns literal values, so the relative
      // assignment (stock = stock - :quantity) requires raw SQL. Keeping the
      // guard in the same statement makes the stock check part of the write.
      const reserved = await tx.executeQuery<ProductRow>(
        `UPDATE products
            SET stock = stock - :quantity
          WHERE id = :productId AND stock >= :quantity
          RETURNING id, name, price, stock`,
        { quantity: line.quantity, productId: line.productId }
      );

      if (reserved.rowCount === 0) {
        const lookup = await tx.executeQuery<{ name: string }>(
          'SELECT name FROM products WHERE id = :productId',
          { productId: line.productId }
        );
        const name = lookup.records.length > 0 ? lookup.records[0].name : `#${line.productId}`;
        throw new Error(`Insufficient stock for product ${name}`);
      }

      const product = reserved.records[0];
      totalCents += Math.round(Number(product.price) * 100) * line.quantity;

      await tx
        .insert<OrderItem>('order_items')
        .values({
          order_id: order.id,
          product_id: product.id,
          quantity: line.quantity,
          unit_price: product.price,
        })
        .execute();
    }

    const confirmed = await tx
      .update<Order, { id: number }>('orders')
      .values({ status: 'confirmed', total: totalCents / 100 })
      .filter({ id: order.id })
      .returning('*')
      .executeReturnSingle();

    if (confirmed === null) {
      throw new Error(`Failed to confirm order #${order.id}`);
    }

    return confirmed;
  });
}

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const order = await checkout(db, 42, [
      { productId: 7, quantity: 2 },
      { productId: 11, quantity: 1 },
    ]);
    console.log(`Order #${order.id} confirmed for a total of ${order.total}`);
  } catch (error) {
    console.error('Checkout rolled back:', error);
  } finally {
    await db.disconnect();
  }
}

void main();
```

### What the builders render

```typescript
// The builders render named-parameter SQL (yesql converts :name to $n at execution):
//
// INSERT INTO orders (customer_id, status, total) VALUES (:customer_id, :status, :total) RETURNING *
// parameters → { customer_id: 42, status: 'pending', total: 0 }
//
// UPDATE orders SET status = :v_status, total = :v_total WHERE id = :p1 RETURNING *
// parameters → { v_status: 'confirmed', v_total: 118.97, p1: 12 }
```

### Why this pattern works

- `withTransaction()` pins a single pooled client and issues `BEGIN`, the callback, and `COMMIT`. Every statement issued through the callback's instance joins the transaction, and a thrown error triggers `ROLLBACK` before the original error is rethrown — the reserved stock from earlier lines is released again automatically.
- Validation lives where the data is: the conditional `UPDATE ... WHERE stock >= :quantity` turns the stock check into part of the write, so two concurrent checkouts cannot both succeed on the last unit.
- `RETURNING` eliminates the "write then re-read" round trip, and `executeReturnSingle()` returning `null` makes the failure branch explicit instead of throwing on an undefined record later.

### Caveats and performance notes

- The transaction pins a pool client for its whole duration. With the default `poolConfig.max` of 10, ten concurrent checkouts occupy the entire pool — keep the callback free of slow external calls and size the pool for peak concurrent work.
- Do not nest `withTransaction()` calls; one logical unit of work equals one transaction. Statements issued through the callback instance participate automatically.
- `numeric` / `decimal` columns arrive as **strings** from the driver. Convert deliberately (`Number(product.price)` here) and consider storing money as integer cents to avoid floating-point drift.
- The guarded `UPDATE` locks the product row until commit; keep the rest of the transaction short.
- `executeReturnSingle()` resolves to `null` when no row was returned — always branch on it rather than assuming a record.

---

## Repository Layer over the Statement Builders

**When to use it:** As soon as more than one module touches a table, raw statement chains get duplicated and drift apart. Wrap each table in a small repository class that owns its SQL and exposes intention-revealing, typed methods. Repositories are also the right home for hook pipelines and optimistic version checks, so callers cannot forget them.

**Combines:** generic statement factories (`insert<T>()`, `update<T, F>()`, `delete<F>()`), terminal `execute*` methods, typed row interfaces, and plain `executeQuery()` for lookups the builders do not cover.

### Complete example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

export interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
  created_at: Date;
}

export interface UserDraft {
  name: string;
  email: string;
}

export interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}

export class UserRepository {
  constructor(private readonly db: PostgreSQLDatabase) {}

  async create(draft: UserDraft): Promise<User> {
    const created = await this.db
      .insert<User>('users')
      .values({ name: draft.name, email: draft.email, active: true })
      .returning('*')
      .executeReturnSingle();

    if (created === null) {
      throw new Error(`Insert into "users" returned no row for ${draft.email}`);
    }

    return created;
  }

  async findById(id: number): Promise<User | null> {
    const { records } = await this.db.executeQuery<User>(
      'SELECT * FROM users WHERE id = :id',
      { id }
    );
    return records[0] ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const { records } = await this.db.executeQuery<User>(
      'SELECT * FROM users WHERE lower(email) = lower(:email)',
      { email }
    );
    return records[0] ?? null;
  }

  async deactivate(id: number): Promise<boolean> {
    const affected = await this.db
      .update<User, UserFilter>('users')
      .values({ active: false })
      .filter({ id, active: true })
      .executeReturnCount();

    return affected === 1;
  }

  async remove(id: number): Promise<User | null> {
    return this.db
      .delete<UserFilter>('users')
      .filter({ id })
      .returning('*')
      .executeReturnSingle();
  }
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
  const users = new UserRepository(db);

  try {
    const ada = await users.create({ name: 'Ada Lovelace', email: 'ada@example.com' });
    console.log(`Created user #${ada.id}`);

    const found = await users.findByEmail('ADA@EXAMPLE.COM');
    console.log(`Lookup result: ${found?.id ?? 'not found'}`);

    const deactivated = await users.deactivate(ada.id);
    console.log(`Deactivated: ${deactivated}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Why this pattern works

- The table's SQL lives in exactly one place; renaming a column or adding a `WHERE` guard touches a single file instead of every caller.
- Callers receive fully typed promises (`Promise<User>`, `Promise<User | null>`), so `strict` mode catches shape mistakes at the call site rather than at runtime.
- Repositories compose naturally with transactions: pass the transaction's instance into repository methods so all work joins the transaction. The repository from Pattern 3 (hooks) and Pattern 5 (versioning) can be embedded here transparently.
- `executeReturnCount()` is the cheapest "did it happen" terminal — `deactivate()` does not need the row payload back.

### Caveats and performance notes

- A repository fences one aggregate. Cross-repository invariants belong in a transaction ([Transactional Multi-Step Workflows](#transactional-multi-step-workflows)), not inside either repository.
- Every method is at least one round trip. Calling `findById()` in a loop is an N+1 — batch with `WHERE id IN (...)` via the expression builder or a raw query when you need sets.
- Never construct a second `PostgreSQLDatabase` instance for a unit of work: each instance owns its own pool, and statements on the second instance are outside your transaction and hold a different client.
- Keep orchestrating business logic out of repositories; they translate between typed objects and SQL.

---

## Composable Query Hook Pipelines

**When to use it:** Some transformations must happen on *every* path that touches a table — lowercasing emails, converting `undefined` to `null`, or stripping sensitive columns from results. Scattering these at call sites guarantees one path will eventually miss one. Compose small hook functions once and attach them to every statement for the table.

**Combines:** `beforeQuery` / `afterQuery` on statement builders, the identical options on `executeQuery()`, and plain function composition.

### Complete example

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

type ParameterHook = (params: Record<string, unknown>) => Record<string, unknown>;
type RowHook = (records: Record<string, unknown>[]) => Record<string, unknown>[];

export interface User {
  id: number;
  name: string;
  email: string;
  password_hash?: string;
}

export function compose(...hooks: ParameterHook[]): ParameterHook {
  return params => hooks.reduce((current, hook) => hook(current), params);
}

export function normalizeEmail(): ParameterHook {
  return params => {
    const result: Record<string, unknown> = { ...params };
    // INSERT supplies `email`; UPDATE supplies `v_email` (values are v_-prefixed).
    // Handling both spellings lets one hook serve every statement on the column.
    for (const key of ['email', 'v_email']) {
      const value = result[key];
      if (typeof value === 'string') {
        result[key] = value.trim().toLowerCase();
      }
    }
    return result;
  };
}

export function nullForUndefined(): ParameterHook {
  return params => {
    const result: Record<string, unknown> = { ...params };
    for (const key of Object.keys(result)) {
      if (result[key] === undefined) {
        result[key] = null;
      }
    }
    return result;
  };
}

export function redact(fields: readonly string[]): RowHook {
  return records =>
    records.map(record => {
      const safe: Record<string, unknown> = { ...record };
      for (const field of fields) {
        delete safe[field];
      }
      return safe;
    });
}

const userWriteHooks = compose(normalizeEmail(), nullForUndefined());
const userResultHooks = redact(['password_hash']);

export async function registerUser(
  db: PostgreSQLDatabase,
  name: string,
  email: string,
  passwordHash: string
): Promise<User> {
  const created = await db
    .insert<User>('users')
    .values({ name, email, password_hash: passwordHash })
    .beforeQuery(userWriteHooks)
    .afterQuery(userResultHooks)
    .returning('*')
    .executeReturnSingle();

  if (created === null) {
    throw new Error('Registration insert returned no row');
  }
  return created;
}

export async function updateUserEmail(
  db: PostgreSQLDatabase,
  userId: number,
  email: string
): Promise<User | null> {
  return db
    .update<User, { id?: number }>('users')
    .values({ email })
    .filter({ id: userId })
    .beforeQuery(userWriteHooks)
    .afterQuery(userResultHooks)
    .returning('*')
    .executeReturnSingle();
}

export async function findUserByEmail(
  db: PostgreSQLDatabase,
  email: string
): Promise<User | null> {
  const { records } = await db.executeQuery<User>(
    'SELECT * FROM users WHERE email = :email',
    { email },
    { beforeQuery: userWriteHooks, afterQuery: userResultHooks }
  );
  return records[0] ?? null;
}
```

### Why this pattern works

- A hook is just a function; `compose(...)` turns several small transformations into one reusable unit that is attached to every statement touching the table.
- The `email` / `v_email` handling shows the parameter-key duality of the builders: INSERT parameters are keyed by column name, UPDATE parameters are `v_`-prefixed. A shared hook handles both spellings, so the same pipeline works for `insert()`, `update()`, and ad-hoc `executeQuery()` calls.
- `afterQuery` is the last line of defense against leaking columns — even a `SELECT *` cannot push `password_hash` past a redaction hook.
- Because `executeQuery()` accepts the same hook types in its options, ad-hoc queries reuse the exact pipeline the builders use instead of duplicating transformations.

### Caveats and performance notes

- Hooks are **synchronous** — `beforeQuery` and `afterQuery` run inline and are not awaited by the adapter. Do asynchronous work (bcrypt, argon2, remote lookups) *before* building the statement and pass the result as a value: compute the password digest with your hash function, then pass `password_hash` into `values()`. Hooks are for cheap, deterministic transformations.
- `compose` runs hooks left to right. Put validation and normalization before value transformations that touch the same key.
- `afterQuery` must return an array; transform copies (`{ ...record }`) rather than mutate shared row objects to keep hooks predictable.
- On UPDATE and DELETE statements, WHERE-clause parameters are positional (`p1`, `p2`, …) and depend on filter key order. Write hooks against named value parameters (`email`, `v_email`) instead of index-based filter names.
- Redaction hides data on the way out but does not reduce what the server sends; also exclude sensitive columns from the `SELECT` list itself.

---

## Conditional Query Composition for Search & Cleanup

**When to use it:** An API receives a required scope (category, tenant, workspace) plus optional criteria, and must build the correct query without string concatenation. The same technique guards maintenance jobs that delete by composed criteria.

**Combines:** the `blendsdk/expression` query builder, `db.from().select().byExpression()`, and `.filter()` for equality-only criteria.

### Before — concatenated SQL (do not do this)

```typescript
// ❌ Before — concatenated SQL is injection-prone, untestable, and bypasses
// parameter binding entirely:
//
// let sql = `SELECT * FROM products WHERE category = '${category}'`;
// if (criteria.nameContains !== undefined) {
//   sql += ` AND name LIKE '%${criteria.nameContains}%'`;
// }
// const result = await db.executeQuery(sql);
```

### Complete example — conditional composition with the expression builder

```typescript
import { query } from 'blendsdk/expression';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

export interface Product {
  id: number;
  name: string;
  category: string;
  price: string;
  in_stock: boolean;
}

export interface ProductSearchCriteria {
  nameContains?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
}

export interface ProductFilter {
  category?: string;
  in_stock?: boolean;
}

export async function searchProducts(
  db: PostgreSQLDatabase,
  category: string,
  criteria: ProductSearchCriteria
): Promise<Product[]> {
  let expression = query<Product>().where('category').equals(category);

  if (criteria.nameContains !== undefined) {
    expression = expression.and('name').like(`%${criteria.nameContains}%`);
  }

  const { minPrice, maxPrice } = criteria;
  if (minPrice !== undefined && maxPrice !== undefined) {
    expression = expression.and('price').between(String(minPrice), String(maxPrice));
  } else if (minPrice !== undefined) {
    expression = expression.and('price').greaterThan(String(minPrice));
  } else if (maxPrice !== undefined) {
    expression = expression.and('price').lessThan(String(maxPrice));
  }

  if (criteria.inStockOnly === true) {
    expression = expression.and('in_stock').equals(true);
  }

  const result = await db
    .from<Product>('products')
    .select(['id', 'name', 'category', 'price', 'in_stock'])
    .byExpression(expression.compile())
    .execute();

  return result?.records ?? [];
}

export function buildProductFilter(
  category: string,
  criteria: ProductSearchCriteria
): ProductFilter {
  // `category` is required, so the filter object can never be empty — an empty
  // filter would produce a WHERE-less DELETE that removes every row.
  const filter: ProductFilter = { category };
  if (criteria.inStockOnly === true) {
    filter.in_stock = true;
  }
  return filter;
}

export async function purgeCategory(
  db: PostgreSQLDatabase,
  category: string,
  criteria: ProductSearchCriteria
): Promise<number> {
  return db
    .delete<ProductFilter>('products')
    .filter(buildProductFilter(category, criteria))
    .executeReturnCount();
}
```

### What the search renders

```typescript
// searchProducts(db, 'books', { nameContains: 'design', inStockOnly: true }) renders:
//   SELECT id, name, category, price, in_stock FROM products
//    WHERE category = :p1 AND name LIKE :p2 AND in_stock = :p3
// parameters → { p1: 'books', p2: '%design%', p3: true }
```

### Why this pattern works

- Conditions map one-to-one to optional criteria; the expression builder handles AND composition and parameter naming (`p1`, `p2`, …), so the query is parameterized by construction — user input can never alter the query structure.
- One compiled expression executes through `from().byExpression()`, and its parameters travel with the statement, so a condition cannot be added without its value being bound.
- `.filter()` covers equality-only criteria (the cleanup case); anything richer (`like`, `between`, comparisons) goes through the expression builder for reads or `filterByExpression()` for UPDATE / DELETE.
- Seeding the chain with the required `category` keeps the expression non-empty, and `buildProductFilter` mirrors that guarantee for the filter object — the DELETE can never run WHERE-less.

### Caveats and performance notes

- `.filter({})` produces **no WHERE clause**: a DELETE with an empty object removes every row. If you generalize `buildProductFilter`, add an explicit empty-filter guard before executing.
- `numeric` columns surface as strings (`price: string`). Passing range bounds as bound parameters (`String(minPrice)`) keeps types consistent and lets PostgreSQL coerce the comparison.
- `%term%` patterns cannot use a plain B-tree index; for large tables prefer prefix search (`term%`) or a trigram index.
- Keep the `select([...])` column list in sync with the row interface manually — column strings are not derived from the type.
- The compiled expression is produced once per statement execution; there is no need to cache it across requests since each request composes its own criteria.

---

## Optimistic Concurrency Control with Version Columns

**When to use it:** Several users or workers may edit the same row, but you don't want to hold locks while a user thinks. Compare a `version` column inside the `WHERE` clause of the write: if someone else already saved, the update matches zero rows and the caller receives a conflict error.

**Combines:** the `update()` builder, the collision-free `v_` value-parameter prefix, `.filter()` carrying the expected version, and `executeReturnSingle()` / `executeReturnCount()` as the conflict signal.

### Complete example

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

export interface Article {
  id: number;
  title: string;
  body: string;
  version: number;
  updated_at: Date;
}

export interface ArticleFilter {
  id?: number;
  version?: number;
}

export interface ArticleUpdate {
  title: string;
  body: string;
}

export class ConcurrentModificationError extends Error {
  constructor(articleId: number, expectedVersion: number) {
    super(`Article #${articleId} was modified concurrently (expected version ${expectedVersion})`);
    this.name = 'ConcurrentModificationError';
  }
}

export async function findArticle(
  db: PostgreSQLDatabase,
  articleId: number
): Promise<Article | null> {
  const { records } = await db.executeQuery<Article>(
    'SELECT * FROM articles WHERE id = :articleId',
    { articleId }
  );
  return records[0] ?? null;
}

export async function saveArticle(
  db: PostgreSQLDatabase,
  articleId: number,
  changes: ArticleUpdate,
  expectedVersion: number
): Promise<Article> {
  const updated = await db
    .update<Article, ArticleFilter>('articles')
    .values({ title: changes.title, body: changes.body, version: expectedVersion + 1 })
    .filter({ id: articleId, version: expectedVersion })
    .returning('*')
    .executeReturnSingle();

  if (updated === null) {
    throw new ConcurrentModificationError(articleId, expectedVersion);
  }

  return updated;
}

export async function saveArticleWithRetry(
  db: PostgreSQLDatabase,
  articleId: number,
  applyChange: (current: Article) => ArticleUpdate,
  maxAttempts = 3
): Promise<Article> {
  let lastConflict: ConcurrentModificationError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await findArticle(db, articleId);
    if (current === null) {
      throw new Error(`Article #${articleId} not found`);
    }

    try {
      return await saveArticle(db, articleId, applyChange(current), current.version);
    } catch (error) {
      if (!(error instanceof ConcurrentModificationError)) {
        throw error;
      }
      lastConflict = error;
    }
  }

  throw lastConflict ?? new Error(`Unable to save article #${articleId} after ${maxAttempts} attempts`);
}
```

### What the builder renders

```typescript
// saveArticle(db, 42, { title: 'Latest', body: '...' }, 7) renders:
//   UPDATE articles
//      SET title = :v_title, body = :v_body, version = :v_version
//    WHERE id = :p1 AND version = :p2
//    RETURNING *
// parameters → { v_title: 'Latest', v_body: '...', v_version: 8, p1: 42, p2: 7 }
//
// Note how `version` appears on both sides: the v_ prefix keeps the SET value
// (:v_version) and the WHERE value (:p2) apart even though they share a column name.
```

### Why this pattern works

- The check and the write are one atomic statement — there is no read-check-write window in which another writer can slip in.
- The `v_` prefix guarantees that `version` in the SET clause and `version` in the WHERE clause never collide, which is exactly the scenario this pattern depends on.
- A conflict is an ordinary application error: map `ConcurrentModificationError` to HTTP 409 / 412 at the API edge, or retry (as `saveArticleWithRetry` does) by re-reading the row and reapplying the change to the latest state.
- When you only need the conflict signal, replace `.returning('*').executeReturnSingle()` with `.executeReturnCount()`: `0` affected rows means the version moved.

### Caveats and performance notes

- Every writer must participate: increment the version in the same statement and filter on the version that was read. A legacy update path that skips the filter reintroduces lost updates — hide the statement behind the repository layer ([Repository Layer over the Statement Builders](#repository-layer-over-the-statement-builders)).
- The builder assigns literals, so it needs the *next* version (`expectedVersion + 1`). Server-side increments (`version = version + 1`) require raw SQL; pick one convention and keep it uniform.
- Retries must re-read the row each attempt (as shown) so the change applies to the latest state; cap the attempts and surface the conflict in the end.
- Version columns should be `NOT NULL` with a default of `1` and be updated by every write path, including soft deletes.

---

## Atomic Audit Trails

**When to use it:** Compliance or debugging asks "who changed this row, from what to what, when?" — and the answer must not drift from the data. Write the audit entry in the same transaction as the change: if either fails, both roll back.

**Combines:** `withTransaction()`, a raw `SELECT ... FOR UPDATE` for a stable before-image (row locks are not expressible with the builders), `update()` with `RETURNING` for the after-image, and `insert()` for the audit row.

### Complete example

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

export interface Profile {
  id: number;
  email: string;
  display_name: string;
}

export interface ProfileChanges {
  email?: string;
  display_name?: string;
}

export interface ProfileAudit {
  id?: number;
  profile_id: number;
  changed_by: string;
  before_state: Record<string, unknown>;
  after_state: Record<string, unknown>;
}

export async function updateProfile(
  db: PostgreSQLDatabase,
  profileId: number,
  actor: string,
  changes: ProfileChanges
): Promise<Profile> {
  return db.withTransaction(async tx => {
    // Builders cannot express row locks, so the before-image is read with raw
    // SQL inside the same transaction that performs the update.
    const current = await tx.executeQuery<Profile>(
      'SELECT * FROM profiles WHERE id = :profileId FOR UPDATE',
      { profileId }
    );

    if (current.rowCount === 0 || current.records.length === 0) {
      throw new Error(`Profile #${profileId} does not exist`);
    }
    const before = current.records[0];

    const updated = await tx
      .update<Profile, { id: number }>('profiles')
      .values(changes)
      .filter({ id: profileId })
      .returning('*')
      .executeReturnSingle();

    if (updated === null) {
      throw new Error(`Update of profile #${profileId} returned no row`);
    }

    await tx
      .insert<ProfileAudit>('profile_audit')
      .values({
        profile_id: profileId,
        changed_by: actor,
        before_state: { email: before.email, display_name: before.display_name },
        after_state: { email: updated.email, display_name: updated.display_name },
      })
      .execute();

    return updated;
  });
}
```

### Why this pattern works

- `SELECT ... FOR UPDATE` inside the transaction gives an exact before-image: no other writer can change the row between the snapshot and the update, and the lock is released at commit or rollback.
- The audit insert shares the transaction, so a change without its audit entry (or an audit entry without its change) is impossible by construction.
- Application-level audits capture *who* (`actor`, typically the authenticated user or a worker identity), which trigger-based audits cannot know without session context.
- The builders do the heavy lifting for the update and insert, including the `RETURNING` after-image; raw SQL is used only for the one thing they cannot express.

### Caveats and performance notes

- `FOR UPDATE` serializes writers on the row. Keep the critical section small and never perform slow external work while holding the lock.
- When a transaction touches multiple rows, lock them in a consistent order to avoid deadlocks.
- Audit tables grow monotonically; plan for partitioning or retention policies. Storing before/after snapshots duplicates data — delta-based audits trade readability for size.
- `Record<string, unknown>` snapshots keep the table generic; version the snapshot shape if downstream readers depend on field names.
- For coverage guarantees, database triggers can complement app-level audit — but triggers cannot replace the actor information the application owns.

---

## Chunked Multi-Row Batch Inserts

**When to use it:** You are importing thousands of rows — CSV import, backfill, sync job. The statement builders insert one row per statement, which means one network round trip per row. Multi-row `VALUES` with generated placeholders moves a whole chunk per round trip while keeping every value bound as a parameter.

**Combines:** `executeQuery()` with generated named parameters, a chunking helper, `withTransaction()` for all-or-nothing semantics, and `ON CONFLICT DO NOTHING` for idempotent re-runs.

### Before / after

```typescript
// ❌ Before — one round trip per row: 10,000 rows = 10,000 statements.
// for (const row of rows) {
//   await db.insert<ImportRow>('users').values(row).execute();
// }
//
// ✅ After — one statement per 500 rows, inside a single transaction:
// const inserted = await importUsers(db, rows);
```

### Complete example

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

export interface ImportRow {
  name: string;
  email: string;
  age: number;
}

const INSERT_BATCH_SIZE = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function buildBatchInsert(batch: readonly ImportRow[]): {
  query: string;
  params: Record<string, string | number>;
} {
  const params: Record<string, string | number> = {};
  const tuples: string[] = [];

  batch.forEach((row, index) => {
    tuples.push(`(:name${index}, :email${index}, :age${index})`);
    params[`name${index}`] = row.name;
    params[`email${index}`] = row.email;
    params[`age${index}`] = row.age;
  });

  const query = `INSERT INTO users (name, email, age) VALUES ${tuples.join(', ')} ON CONFLICT (email) DO NOTHING`;
  return { query, params };
}

export async function importUsers(
  db: PostgreSQLDatabase,
  rows: readonly ImportRow[]
): Promise<number> {
  let inserted = 0;

  await db.withTransaction(async tx => {
    for (const batch of chunk(rows, INSERT_BATCH_SIZE)) {
      const { query, params } = buildBatchInsert(batch);
      const result = await tx.executeQuery(query, params);
      inserted += result.rowCount;
    }
  });

  return inserted;
}
```

### What a batch renders

```typescript
// A three-row batch renders:
//   INSERT INTO users (name, email, age)
//   VALUES (:name0, :email0, :age0), (:name1, :email1, :age1), (:name2, :email2, :age2)
//   ON CONFLICT (email) DO NOTHING
// parameters → { name0: 'Ada', email0: 'ada@example.com', age0: 36, name1: ..., ... }
//
// Only placeholder names and the tuple count vary; values are always bound.
```

### Why this pattern works

- Round trips dominate batch performance: one statement per 500 rows cuts them by 500×, and PostgreSQL plans and executes the whole batch once.
- Everything stays parameterized. The generated SQL text contains only placeholder names; row values never enter the query string, so the pattern avoids the injection risk that typically creeps into hand-built bulk SQL.
- Wrapping the chunks in a single `withTransaction()` makes the import all-or-nothing; `ON CONFLICT (email) DO NOTHING` makes retries safe, and `rowCount` reports the rows *actually* inserted, not the rows attempted.

### Caveats and performance notes

- The wire protocol allows at most 65,535 bound parameters per statement. With three parameters per row the ceiling is roughly 21,800 rows per statement — a batch size of 500 keeps statements small and memory flat with plenty of headroom.
- For millions of rows, `COPY FROM STDIN` is the right tool; it is not expressible through the adapter's named-parameter API, so use the `pg` driver directly or `psql` for that path.
- The single huge transaction grows undo on the server. If partial progress is acceptable, use one transaction per chunk with a resume marker (for example, the last imported email) instead.
- `ON CONFLICT` requires a unique index on the conflict target (`email` here). Without one PostgreSQL raises an error instead of skipping.
- Keep the statement structure static — only placeholder names and the tuple count vary. Never interpolate row values into the SQL string, even "temporarily".

---

## Integration Tests with Rollback Isolation

**When to use it:** You want tests that run against a real PostgreSQL instance, exercise the real transaction machinery — pinned clients, `BEGIN` / `COMMIT` / `ROLLBACK`, hooks, parameter binding — and never need cleanup code. Each test runs inside a transaction that is deliberately rolled back at the end. The package's own suite uses the same primitives (TEMP tables created inside a transaction, `withTransaction()` for isolation).

**Combines:** `withTransaction()`, a sentinel error to force rollback, statement builders, `executeQuery()`, and Vitest.

### Complete example

```typescript
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface TestUser {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class RollbackSignal extends Error {
  constructor() {
    super('rollback-requested');
  }
}

async function inRollbackTransaction<T>(
  db: PostgreSQLDatabase,
  fn: (tx: PostgreSQLDatabase) => Promise<T>
): Promise<T> {
  const holder: { result?: T } = {};
  try {
    await db.withTransaction(async tx => {
      holder.result = await fn(tx);
      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) {
      throw error;
    }
  }

  const { result } = holder;
  if (result === undefined) {
    throw new Error('Transaction produced no result');
  }
  return result;
}

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5599,
  database: 'testdb',
  user: 'testdb',
  pass: 'testdb',
};

describe('users table', () => {
  const db = new PostgreSQLDatabase(config);

  beforeAll(async () => {
    await db.executeQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true
      )
    `);
  });

  afterAll(async () => {
    await db.disconnect();
  });

  test('inserts and reads back a user, then rolls everything back', async () => {
    const { inserted, readBack } = await inRollbackTransaction(db, async tx => {
      const inserted = await tx
        .insert<TestUser>('users')
        .values({ name: 'Test User', email: 'test@example.com', active: true })
        .returning('*')
        .executeReturnSingle();

      const readBack = await tx.executeQuery<TestUser>(
        'SELECT * FROM users WHERE email = :email',
        { email: 'test@example.com' }
      );

      return { inserted, readBack };
    });

    expect(inserted).toMatchObject({ name: 'Test User', email: 'test@example.com' });
    expect(readBack.rowCount).toBe(1);
  });

  test('leaves no trace after the transaction is rolled back', async () => {
    await inRollbackTransaction(db, async tx => {
      await tx
        .insert<TestUser>('users')
        .values({ name: 'Ghost', email: 'ghost@example.com', active: true })
        .execute();
    });

    const { records } = await db.executeQuery<{ count: string }>(
      'SELECT COUNT(*) AS count FROM users WHERE email = :email',
      { email: 'ghost@example.com' }
    );

    expect(Number(records[0].count)).toBe(0);
  });
});
```

### Why this pattern works

- The production path is what the tests exercise: real transactions against a real server, including the adapter's commit/rollback handling and client release.
- No cleanup code: rolling back the transaction discards inserts, updates, and deletes — and TEMP tables created inside it, because PostgreSQL DDL is transactional too.
- The helper distinguishes its sentinel from real failures: anything that is not a `RollbackSignal` (assertion errors, constraint violations, hook errors) is rethrown, so Vitest reports the original failure after the automatic rollback.
- The returned result object survives the rollback, so assertions can run outside the transaction even though the data did not persist.

### Caveats and performance notes

- The helper must swallow exactly one error type; if `RollbackSignal` were ever caught by other code, rollback semantics would change. Keep it local to the test module.
- Do not nest `withTransaction()` inside the helper's callback — the helper already owns the transaction (Core Concepts, Transactions).
- SERIAL sequences do not roll back: IDs advance even though the rows don't exist afterwards. Assert shapes and counts, never exact generated IDs.
- Shared fixtures that must persist across tests belong in `beforeAll` (as above) or in TEMP tables created inside each test — never in rows inserted inside a rolled-back transaction.
- Pure SQL-generation checks (statement rendering and parameter objects) need no database at all; the package's `test:fast` script runs those tests without Docker.

---

## Service Lifecycle & Graceful Shutdown

**When to use it:** Any process that owns its own `PostgreSQLDatabase` — workers, CLI jobs, services not managed by a `blendsdk/webafx` WebApplication — must start predictably and shut down without hanging. This pattern covers pool sizing, single-owner shutdown, and the guard errors that protect you during teardown.

**Combines:** `poolConfig`, `disconnect(timeoutMs)`, the internal shutdown guards, and the `enableGracefulShutdown` trade-off.

### Complete example

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? '5432'),
  database: process.env.PGDATABASE ?? 'appdb',
  user: process.env.PGUSER ?? 'app_user',
  pass: process.env.PGPASSWORD ?? 'secret',
  poolConfig: {
    // Size for peak concurrent statements: each standalone query checks out one
    // client and each transaction pins one for its entire duration.
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },
  // Keep false inside a blendsdk/webafx WebApplication, which installs its own
  // SIGINT/SIGTERM handling; enable only for standalone processes.
  enableGracefulShutdown: false,
};

async function runDailyReport(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  let closed = false;

  const closeDb = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await db.disconnect(15000);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void closeDb().catch((error: unknown) => {
        console.error(`${signal} shutdown failed`, error);
      });
    });
  }

  try {
    const { records } = await db.executeQuery<{ total: string }>(
      `SELECT COUNT(*) AS total
         FROM orders
        WHERE created_at >= :since`,
      { since: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    );
    console.log(`Orders in the last 24h: ${Number(records[0].total)}`);
  } finally {
    await closeDb();
  }
}

runDailyReport().catch((error: unknown) => {
  console.error('Daily report failed', error);
  process.exitCode = 1;
});
```

### Why this pattern works

- Pool sizing follows workload math: `max` must cover peak concurrent *statements* — a transaction pins one client for its whole duration, a standalone query for one interaction — not the number of users or requests.
- `disconnect(15000)` drains gracefully: `pool.end()` waits for checked-out clients to be returned, then force-releases anything still held once the timeout elapses, so shutdown cannot hang forever.
- The local `closed` guard makes shutdown idempotent for the paths that can race (signal handler plus `finally`), and the signal handling is explicit instead of relying on the opt-in constructor flag.

### Caveats and performance notes

- Leave `enableGracefulShutdown` at its default (`false`) when a WebApplication from `blendsdk/webafx` owns the process. It registers its own `SIGINT` / `SIGTERM` handling, and enabling both causes signal-handler conflicts and unpredictable shutdown behavior. Enable the flag only for standalone processes that don't install their own handlers.
- Once `disconnect()` begins, new statements fail fast: `Cannot execute query: database is shutting down` and `Cannot start transaction: database is shutting down`. A multi-step flow that is mid-flight will fail at its *next* statement — stop accepting work at the application boundary before you disconnect rather than relying on the adapter to finish ongoing orchestration.
- Statements that are already running when shutdown begins do finish (the pool only closes after their clients are released), unless the timeout expires first.
- Call `disconnect()` from exactly one place — as the example's `closed` flag enforces — and give it a timeout that exceeds your slowest expected statement, or long transactions will be interrupted by the forced release.
- `connectionTimeoutMillis` bounds how long a statement waits when the pool and server cannot accept more connections; without it (default `0`) checkouts can wait indefinitely.

---

## Choosing Between Patterns

| If you need to… | Use pattern | Core building blocks |
| --- | --- | --- |
| Make several writes atomic | [Transactional Multi-Step Workflows](#transactional-multi-step-workflows) | `withTransaction()`, builders, `RETURNING`, guarded raw `UPDATE` |
| Stop repeating SQL across modules | [Repository Layer over the Statement Builders](#repository-layer-over-the-statement-builders) | Statement factories, generics, `executeReturn*` |
| Normalize or redact data on every path | [Composable Query Hook Pipelines](#composable-query-hook-pipelines) | `beforeQuery`, `afterQuery`, composition |
| Combine optional search filters safely | [Conditional Query Composition for Search & Cleanup](#conditional-query-composition-for-search--cleanup) | `blendsdk/expression`, `from().byExpression()`, `filter()` |
| Prevent lost updates on concurrent edits | [Optimistic Concurrency Control with Version Columns](#optimistic-concurrency-control-with-version-columns) | `update()` + version filter, `v_` parameters |
| Record who changed what, atomically | [Atomic Audit Trails](#atomic-audit-trails) | `withTransaction()`, `SELECT ... FOR UPDATE`, `insert()` |
| Import thousands of rows fast | [Chunked Multi-Row Batch Inserts](#chunked-multi-row-batch-inserts) | `executeQuery()` with generated placeholders, chunks, `ON CONFLICT` |
| Test against PostgreSQL without cleanup | [Integration Tests with Rollback Isolation](#integration-tests-with-rollback-isolation) | `withTransaction()`, sentinel rollback, TEMP tables |
| Start and stop a service cleanly | [Service Lifecycle & Graceful Shutdown](#service-lifecycle--graceful-shutdown) | `poolConfig`, `disconnect(timeout)`, shutdown guards |

For the mechanics behind these building blocks — configuration, query execution, transactions, statement builders, and hooks — see the Core Concepts companion.

---

# postgresql Common Scenarios

This document answers the most common "How do I ...?" questions about `blendsdk/postgresql`, ordered from simple to advanced. Every answer is a complete, strict-mode TypeScript program. For background material, see Overview and Core Concepts; the examples assume a reachable PostgreSQL server and a `users`-style table matching the columns shown.

---

## How do I connect to a PostgreSQL database and run my first query?

Create a `PostgreSQLDatabase` with a `PostgreSQLConfig`, run queries through `executeQuery()`, and call `disconnect()` when done. The constructor does not open a connection — the pool connects lazily on the first query — and `port` accepts a number or a numeric string (or can be omitted entirely).

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
    const { records, rowCount } = await db.executeQuery<{ connected: number }>(
      'SELECT 1 AS connected'
    );
    console.log(`Connected — ${rowCount} row(s), connected = ${records[0].connected}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I pass values into a query without risking SQL injection?

Always use named `:placeholder` parameters. The adapter translates them into positional parameters, so user input is bound as *data* and can never alter the query structure — never build SQL text by concatenating values.

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
    const maliciousInput = "'; DROP TABLE users; --";

    // The value is bound as a parameter — the SQL text can never change
    const injectionAttempt = await db.executeQuery<{ id: number; name: string }>(
      'SELECT id, name FROM users WHERE name = :name',
      { name: maliciousInput }
    );
    console.log(`Injection attempt matched ${injectionAttempt.rowCount} row(s) — table is intact`);

    // Regular values go through the exact same binding
    const legit = await db.executeQuery<{ id: number; name: string }>(
      'SELECT id, name FROM users WHERE name = :name',
      { name: 'legitimate_user' }
    );
    console.log(`Regular lookup: ${legit.rowCount} row(s), name = ${legit.records[0].name}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I configure the connection pool?

Pass a `poolConfig` object inside `PostgreSQLConfig` to tune the underlying `pg.Pool`. Every option is optional — omitting the whole object keeps the defaults below.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `max` | `number` | 10 | Maximum number of clients in the pool |
| `idleTimeoutMillis` | `number` | 30000 | Milliseconds a client may sit idle before being closed |
| `connectionTimeoutMillis` | `number` | 0 (no timeout) | Milliseconds to wait before timing out when connecting a new client |

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
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 5000,
  },
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const queries = Array.from({ length: 10 }, (_, index) =>
      db.executeQuery<{ num: number }>('SELECT :num::int AS num', { num: index })
    );
    const results = await Promise.all(queries);
    console.log(`Completed ${results.length} concurrent queries on a pool of max=20 clients`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I insert a row and get the created record back?

Chain `.returning('*')` (or a column list) before a terminal `execute*` method. All three statement builders share the same terminal methods and the same "nothing matched" behavior:

| Terminal method | Returns | Behavior when nothing is returned |
| --- | --- | --- |
| `execute()` | `QueryResult<T>` | `{ records: [], rowCount: 0, fields: [] }` |
| `executeReturnSingle()` | `T \| null` | Resolves to `null` |
| `executeReturnAll()` | `T[]` | Resolves to `[]` |
| `executeReturnCount()` | `number` | Resolves to `0` (works even without `RETURNING`) |

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
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
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);
  try {
    const created = await db
      .insert<User>('users')
      .values({ name: 'Ada Lovelace', email: 'ada@example.com', age: 36 })
      .returning('*')
      .executeReturnSingle();

    if (created === null) {
      throw new Error('Insert returned no record');
    }
    console.log(`Created user #${created.id}: ${created.name} <${created.email}>`);

    // Return only a subset of columns when you do not need the whole row
    const partial = await db
      .insert<User>('users')
      .values({ name: 'Grace Hopper', email: 'grace@example.com' })
      .returning(['id', 'name'] as (keyof User)[])
      .executeReturnSingle();
    console.log(`Created user #${partial?.id}: ${partial?.name}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I update only the rows that match a filter?

Pass the columns to change to `.values()` and the matching criteria to `.filter()`. The filter becomes a parameterized `WHERE` clause (its parameters are named `p1`, `p2`, …), and the `SET` values are prefixed with `v_` internally so the two can never collide.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

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
      .values({ active: false, age: 37 })
      .filter({ email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (updated === null) {
      console.log('No matching user found — nothing was updated');
    } else {
      console.log(`Updated user #${updated.id}: active = ${String(updated.active)}`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I delete a row and capture what was deleted?

Add `.returning('*')` and finish with `executeReturnSingle()` for one deleted row (or `null` when nothing matched) or `executeReturnAll()` for every deleted row. Always double-check the filter on a DELETE — an empty filter removes the whole table (see the bulk-operations scenario below).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name?: string;
  email?: string;
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
    const deleted = await db
      .delete<User>('users')
      .filter({ email: 'ada@example.com' })
      .returning('*')
      .executeReturnSingle();

    if (deleted === null) {
      console.log('Nothing deleted — no user matched the filter');
    } else {
      console.log(`Deleted user #${deleted.id} <${deleted.email}>`);
    }

    const purged = await db
      .delete<User>('users')
      .filter({ active: false })
      .returning(['id', 'email'] as (keyof User)[])
      .executeReturnAll();

    console.log(`Purged ${purged.length} inactive account(s)`);
    for (const account of purged) {
      console.log(`- #${account.id} <${account.email}>`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I find out how many rows were affected?

Use `executeReturnCount()` on any statement builder — it resolves to the number of affected rows and does not require a `RETURNING` clause. For raw SQL, read `rowCount` from the `executeQuery()` result.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email?: string;
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
    const insertedCount = await db
      .insert<User>('users')
      .values({ email: 'ada@example.com', active: true })
      .executeReturnCount();
    console.log(`Inserted ${insertedCount} row(s)`);

    const updatedCount = await db
      .update<User, User>('users')
      .values({ active: false })
      .filter({ active: true })
      .executeReturnCount();
    console.log(`Updated ${updatedCount} row(s)`);

    const deletedCount = await db
      .delete<User>('users')
      .filter({ active: false })
      .executeReturnCount();
    console.log(`Deleted ${deletedCount} row(s)`);

    // Raw SQL exposes the same information as result.rowCount
    const { rowCount } = await db.executeQuery(
      'UPDATE users SET active = :active WHERE email = :email',
      { active: true, email: 'ada@example.com' }
    );
    console.log(`Raw SQL update re-activated ${rowCount} row(s)`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

> ⚠️ A raw `SELECT COUNT(*)` returns a **string** (e.g. `"2"`) from the `pg` driver. Cast it with `COUNT(*)::int` or parse it — `executeReturnCount()` gives you a number directly.

---

## How do I update or delete every row in a table?

Omit `.filter()` entirely — or pass an empty object, such as `.filter({})` — and the statement has no `WHERE` clause, affecting every row. ⚠️ These are the only statements that touch all rows at once, so run them deliberately and use `executeReturnCount()` to confirm the impact.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email?: string;
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
    // ⚠️ No filter → every row is updated
    const deactivated = await db
      .update<User, {}>('users')
      .values({ active: false })
      .executeReturnCount();
    console.log(`Deactivated every user: ${deactivated} row(s)`);

    // ⚠️ Empty filter → bulk DELETE with no WHERE clause
    const purged = await db
      .delete<{}>('users')
      .filter({})
      .executeReturnCount();
    console.log(`Deleted every user: ${purged} row(s)`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I handle empty results and "nothing matched" situations?

The adapter never throws for empty result sets — each terminal method has a well-defined empty value:

- `executeQuery()` → `{ records: [], rowCount: 0, fields: [] }`
- `executeReturnSingle()` → `null`
- `executeReturnAll()` → `[]` (never `null`)
- `executeReturnCount()` → `0`

Note also that `null`/`undefined` filter values are bound as `NULL` (`p1: null`), and `column = NULL` never matches in SQL — use an expression filter with `isNull()`/`isNotNull()` for `NULL` checks.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name?: string;
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
    // SELECT: empty records, rowCount 0, and no field metadata
    const empty = await db.executeQuery<User>(
      'SELECT id, name, email FROM users WHERE email = :email',
      { email: 'nobody@example.com' }
    );
    console.log(
      `records=${empty.records.length} rowCount=${empty.rowCount} fields=${empty.fields.length}`
    );

    // executeReturnSingle resolves to null ...
    const missing = await db
      .delete<User>('users')
      .filter({ email: 'nobody@example.com' })
      .returning('*')
      .executeReturnSingle();
    console.log(`executeReturnSingle -> ${missing === null ? 'null' : 'a record'}`);

    // ... executeReturnAll to an empty array ...
    const missingAll = await db
      .delete<User>('users')
      .filter({ email: 'nobody@example.com' })
      .returning('*')
      .executeReturnAll();
    console.log(`executeReturnAll -> length ${missingAll.length}`);

    // ... and executeReturnCount to 0
    const missingCount = await db
      .update<User, User>('users')
      .values({ name: 'Should not match' })
      .filter({ email: 'nobody@example.com' })
      .executeReturnCount();
    console.log(`executeReturnCount -> ${missingCount}`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I run multiple statements atomically in a transaction?

Wrap the work in `withTransaction()`: the callback receives the database instance, all statements within it run on one pinned connection, and the adapter issues `COMMIT` on success or `ROLLBACK` on failure — rethrowing the original error. Transactions are not re-entrant, so use the provided transaction instance instead of calling `withTransaction()` again.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Order {
  id?: number;
  customer_name: string;
  total: number;
  status?: string;
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
    // Success path: every statement inside the callback commits together
    const orderId = await db.withTransaction(async transactionDb => {
      const order = await transactionDb
        .insert<Order>('orders')
        .values({ customer_name: 'Alice', total: 100.5, status: 'pending' })
        .returning('*')
        .executeReturnSingle();

      if (order === null) {
        throw new Error('Order insert returned no record');
      }

      await transactionDb.executeQuery(
        'UPDATE orders SET status = :status WHERE id = :id',
        { status: 'confirmed', id: order.id }
      );

      return order.id;
    });
    console.log(`Committed order #${orderId}`);

    // Failure path: the original error is rethrown after an automatic ROLLBACK
    try {
      await db.withTransaction(async transactionDb => {
        await transactionDb.executeQuery(
          'UPDATE orders SET status = :status WHERE id = :id',
          { status: 'cancelled', id: orderId }
        );
        throw new Error('Simulated failure — the update above is rolled back');
      });
    } catch (error) {
      console.log(`Rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I transform parameter values right before they hit the database?

Attach a `beforeQuery` hook to the statement. It receives the fully built parameter object — after the builder produced it, before the placeholders are translated — and must return the object to execute with. Parameter key names depend on the statement type:

| Statement | Parameter keys inside `beforeQuery` |
| --- | --- |
| `INSERT` | Column names, e.g. `params.email`, `params.password_hash` |
| `UPDATE` | `SET` values prefixed with `v_` (e.g. `params.v_password_hash`); `WHERE` values named `p1`, `p2`, … |
| `DELETE` | `WHERE` values named `p1`, `p2`, … |

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  email?: string;
  password_hash?: string;
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
    // INSERT: parameters are keyed by column name
    const insertedCount = await db
      .insert<User>('users')
      .values({ email: 'ADA@EXAMPLE.COM', password_hash: 'plaintext-secret' })
      .beforeQuery((params: Record<string, unknown>) => {
        const email = params.email;
        if (typeof email === 'string') {
          params.email = email.toLowerCase();
        }
        const passwordHash = params.password_hash;
        if (typeof passwordHash === 'string') {
          params.password_hash = `hashed(${passwordHash})`;
        }
        return params;
      })
      .executeReturnCount();
    console.log(`Inserted ${insertedCount} user(s) with a normalized email and hashed password`);

    // UPDATE: SET values are prefixed with v_ (WHERE parameters use p1, p2, ...)
    const updatedCount = await db
      .update<User, User>('users')
      .values({ password_hash: 'new-secret' })
      .filter({ email: 'ada@example.com' })
      .beforeQuery((params: Record<string, unknown>) => {
        const passwordHash = params.v_password_hash;
        if (typeof passwordHash === 'string') {
          params.v_password_hash = `hashed(${passwordHash})`;
        }
        return params;
      })
      .executeReturnCount();
    console.log(`Updated ${updatedCount} user(s) with a new hashed password`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I hide or reshape rows before my code sees them?

Attach an `afterQuery` hook: it receives the raw row array from the driver and must return an array. The transformation runs before the terminal `executeReturn*` methods inspect the rows, which makes it the perfect place to redact secrets or add computed fields. `afterQuery` pairs naturally with `beforeQuery` (hash on the way in, redact on the way out), and the same hooks can be passed as options to `executeQuery(query, params, { beforeQuery, afterQuery })` when you work with raw SQL.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name?: string;
  email?: string;
  password_hash?: string;
  api_key?: string;
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
    const safeRecord = await db
      .delete<User>('users')
      .filter({ email: 'sensitive@example.com' })
      .afterQuery((records: User[]) =>
        records.map(record => {
          const safe = { ...record };
          delete safe.password_hash;
          delete safe.api_key;
          return safe;
        })
      )
      .returning('*')
      .executeReturnSingle();

    console.log('Deleted record (secrets redacted):', safeRecord);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I query only specific columns?

Use the `from()` SELECT builder that `PostgreSQLDatabase` inherits from the base `Database` class. `.select()` with no arguments selects `*`, an array selects concrete columns, and an object maps output aliases to column expressions; finish with `.execute()`. (The base class also offers `db.selectAll(tableName)` as a shorthand for the select-all form.)

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
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
    // SELECT * FROM users
    const all = await db.from<User>('users').select().execute();
    console.log(`All users: ${all.rowCount} row(s)`);

    // SELECT id, name, email FROM users
    const partial = await db.from<User>('users').select(['id', 'name', 'email']).execute();
    for (const user of partial.records) {
      console.log(`- #${user.id} ${user.name} <${user.email}>`);
    }

    // SELECT id AS user_id, name AS user_name FROM users
    // (rows carry the aliased column names at runtime)
    const aliased = await db
      .from<User>('users')
      .select({ user_id: 'id', user_name: 'name' })
      .execute();
    console.log(`Aliased select: ${aliased.rowCount} row(s)`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I build complex WHERE clauses (AND, OR, IN, LIKE, BETWEEN)?

Beyond equality filters, use the expression compiler from the companion package `blendsdk/expression`. On UPDATE and DELETE statements, `filterByExpression(build)` receives the query builder and wires the compiled condition into the `WHERE` clause; on SELECT statements, `byExpression(compiled)` takes an already-compiled expression (call `.compile()` on the builder you create with `query<T>()`).

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';
import { query } from 'blendsdk/expression';

interface User {
  id?: number;
  name?: string;
  email?: string;
  age?: number;
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
    // UPDATE ... WHERE active = true AND age > 90
    const deactivated = await db
      .update<User, User>('users')
      .values({ active: false })
      .filterByExpression(q => q.where('active').equals(true).and('age').greaterThan(90))
      .executeReturnCount();
    console.log(`Deactivated ${deactivated} user(s)`);

    // DELETE ... WHERE email LIKE '%@old-domain.com'
    const purged = await db
      .delete<User>('users')
      .filterByExpression(q => q.where('email').like('%@old-domain.com'))
      .executeReturnCount();
    console.log(`Purged ${purged} account(s) from the old domain`);

    // SELECT ... WHERE age BETWEEN 18 AND 65 OR email IN (...)
    const selected = await db
      .from<User>('users')
      .select(['id', 'name', 'email'])
      .byExpression(
        query<User>()
          .where('age')
          .between(18, 65)
          .or('email')
          .in(['vip@example.com', 'staff@example.com'])
          .compile()
      )
      .execute();
    console.log(`Selected ${selected.rowCount} user(s)`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I store and read JSONB, arrays, and dates?

Pass JavaScript values directly — objects are serialized for `JSONB` columns, arrays map onto PostgreSQL array columns, and timestamp columns come back as `Date` objects. Common gotchas: `NUMERIC`/`DECIMAL` columns are returned as **strings** by the `pg` driver, and you can filter on `JSONB` fields with the `->>` operator using normal named parameters.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Document {
  id?: number;
  name: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  created_at?: Date;
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
      .insert<Document>('documents')
      .values({
        name: 'Release notes',
        metadata: { settings: { theme: 'dark' }, version: 2 },
        tags: ['changelog', 'release'],
      })
      .returning('*')
      .executeReturnSingle();

    if (created !== null) {
      console.log(`Inserted document #${created.id}`);
      console.log(`metadata: ${JSON.stringify(created.metadata)}`);
      console.log(`tags: ${created.tags?.join(', ')}`);
      console.log(`created_at is a Date: ${created.created_at instanceof Date}`);
    }

    const { records } = await db.executeQuery<Document>(
      `SELECT id, name, metadata, tags, created_at
         FROM documents
        WHERE metadata->>'version' = :version`,
      { version: '2' }
    );
    console.log(`Found ${records.length} document(s) with version 2`);
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## How do I shut the database down cleanly?

Call `disconnect(timeoutMs = 10000)`: it drains the pool, force-releases stuck clients if the close exceeds the timeout, and resolves without throwing even if the server was unreachable. Once shutdown begins, every new query rejects with `Cannot execute query: database is shutting down`, and new transactions with `Cannot start transaction: database is shutting down` — a deliberate fail-fast guard instead of hanging connections.

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

  const { rowCount } = await db.executeQuery('SELECT 1 AS alive');
  console.log(`Query before shutdown returned ${rowCount} row(s)`);

  // Drain the pool; stuck clients are force-released after 5000 ms
  await db.disconnect(5000);
  console.log('Pool drained');

  // From this point on, new work fails fast instead of hanging
  try {
    await db.executeQuery('SELECT 1 AS too_late');
  } catch (error) {
    console.log(`Rejected as expected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

void main();
```

> For standalone applications you can set `enableGracefulShutdown: true` in the config to register `SIGINT`/`SIGTERM` handlers that call `disconnect()` automatically. ⚠️ Never enable this when the database is managed by a `blendsdk/webafx` WebApplication — that framework installs its own signal handling, and enabling both causes signal-handler conflicts.

---

# postgresql Examples Library

This library collects copy-paste ready examples for `blendsdk/postgresql`, organized by feature area. Every example is complete and self-contained: it includes all imports, a `PostgreSQLConfig`, an executable `main()` function, and pool cleanup via `disconnect()`.

- Examples mirror the package's integration test suite and use a placeholder database (`localhost:5432`, database `appdb`).
- Tables are created with `CREATE TEMP TABLE` so examples can run repeatedly without leaving state behind. Where a TEMP table must stay visible across calls (TEMP tables are session-scoped), the example pins `poolConfig: { max: 1 }`.
- Expected results are shown as comments next to the relevant statements.

**Categories**

- [Connection & Configuration](#connection--configuration)
- [Query Execution](#query-execution)
- [Transactions](#transactions)
- [INSERT Statements](#insert-statements)
- [UPDATE Statements](#update-statements)
- [DELETE Statements](#delete-statements)
- [Query Hooks](#query-hooks)
- [Error Handling & Shutdown](#error-handling--shutdown)

---

## Connection & Configuration

### Create an Instance and Run Your First Query

Constructs a `PostgreSQLDatabase` from a `PostgreSQLConfig`, executes a query with a named parameter, prints the typed result, and closes the pool. The constructor never opens a connection — the pool connects lazily on first use.

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
    const { records, rowCount } = await db.executeQuery<{ answer: number }>(
      'SELECT :answer::integer AS answer',
      { answer: 42 }
    );

    console.log(`rowCount: ${rowCount}`);        // rowCount: 1
    console.log(`answer: ${records[0].answer}`); // answer: 42
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## Query Execution

### Bind Named Parameters and Read Typed Rows

Named `:param` placeholders are translated to positional parameters and bound by the driver, so values can never alter the query structure. Cast parameters with `::type` to control how PostgreSQL interprets them and what the driver returns.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface ProfileRow {
  id: number;
  name: string;
  created_at: Date;
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
    const { records, rowCount } = await db.executeQuery<ProfileRow>(
      'SELECT :id::integer AS id, :name::text AS name, now() AS created_at',
      { id: 7, name: 'john' }
    );

    const profile = records[0];
    console.log(`rowCount: ${rowCount}`);                        // rowCount: 1
    console.log(`id: ${typeof profile.id} ${profile.id}`);       // id: number 7
    console.log(`name: ${profile.name}`);                        // name: john
    console.log(`created_at is a Date: ${profile.created_at instanceof Date}`); // created_at is a Date: true
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Inspect Column Metadata with `fields`

`result.fields` contains the PostgreSQL column metadata (`FieldDef[]`) for the returned columns — useful for dynamic result handling and introspection.

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
    const result = await db.executeQuery<{ id: number; name: string; active: boolean }>(
      'SELECT 1 AS id, :name::text AS name, true AS active',
      { name: 'test' }
    );

    console.log(result.fields.map(field => field.name)); // [ 'id', 'name', 'active' ]
    console.log(result.fields.length);                   // 3
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Handle Empty Result Sets

When a query matches no rows, `executeQuery` resolves to an explicitly empty result: `records: []`, `rowCount: 0`, and `fields: []`. No error is thrown — check `rowCount` when the distinction matters.

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
    const result = await db.executeQuery<{ id: number }>(
      'SELECT id FROM (VALUES (1), (2), (3)) AS t(id) WHERE id = :id',
      { id: 999 }
    );

    console.log(result.records);  // []
    console.log(result.rowCount); // 0
    console.log(result.fields);   // []
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Query PostgreSQL-Specific Data Types

Parameter values are passed as native JavaScript values and cast to the wire type with `::type`. The `pg` driver maps the returned columns back: `jsonb` becomes an object, `text[]` an array, timestamps `Date` objects, and `numeric` values strings.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface PayloadRow {
  text_val: string;
  int_val: number;
  float_val: string;
  bool_val: boolean;
  date_val: Date;
  json_val: { key: string; nested: { count: number } };
  tags: string[];
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
    const { records } = await db.executeQuery<PayloadRow>(
      `SELECT
         :text_val::text       AS text_val,
         :int_val::integer     AS int_val,
         :float_val::numeric   AS float_val,
         :bool_val::boolean    AS bool_val,
         :date_val::timestamp  AS date_val,
         :json_val::jsonb      AS json_val,
         :tags::text[]         AS tags`,
      {
        text_val: 'hello world',
        int_val: 42,
        float_val: 3.14,
        bool_val: true,
        date_val: new Date('2023-01-01T00:00:00Z'),
        json_val: { key: 'value', nested: { count: 123 } },
        tags: ['alpha', 'beta'],
      }
    );

    const row = records[0];
    console.log(row.text_val);                  // hello world
    console.log(row.int_val);                   // 42
    console.log(row.float_val);                 // 3.14 (numeric values are returned as strings)
    console.log(row.bool_val);                  // true
    console.log(row.date_val instanceof Date);  // true
    console.log(row.json_val.nested.count);     // 123
    console.log(row.tags.join(', '));           // alpha, beta
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Prevent SQL Injection with Bound Parameters

Named parameters are converted to positional parameters and bound by the driver — they are never concatenated into the SQL text. A malicious string is therefore compared as plain data.

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
    const maliciousInput = "'; DROP TABLE users; --";

    const attacked = await db.executeQuery<{ name: string }>(
      "SELECT name FROM (VALUES ('legitimate_user'), ('someone_else')) AS t(name) WHERE name = :lookup",
      { lookup: maliciousInput }
    );

    console.log(attacked.rowCount); // 0 - the malicious value matched no rows
    console.log(attacked.records);  // []

    const legit = await db.executeQuery<{ name: string }>(
      "SELECT name FROM (VALUES ('legitimate_user'), ('someone_else')) AS t(name) WHERE name = :lookup",
      { lookup: 'legitimate_user' }
    );

    console.log(legit.records[0].name); // legitimate_user
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## Transactions

### Commit a Transaction's Work

`withTransaction()` pins one pooled client, issues `BEGIN`, runs the callback, and `COMMIT`s on success. The callback's return value is passed through to the caller. This example pins `max: 1` so the TEMP table stays visible across calls (TEMP tables are session-scoped).

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
  user: 'app_user',
  pass: 'secret',
  // A single pooled connection keeps the TEMP table of this example
  // visible to every call (TEMP tables are session-scoped).
  poolConfig: { max: 1 },
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);

  try {
    const created = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE tx_users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      await transactionDb.executeQuery(
        'INSERT INTO tx_users (name, email) VALUES (:name, :email)',
        { name: 'John Doe', email: 'john@example.com' }
      );

      const { records } = await transactionDb.executeQuery<UserRow>(
        'SELECT id, name, email FROM tx_users WHERE email = :email',
        { email: 'john@example.com' }
      );

      return records[0];
    });

    console.log(`Created: #${created.id} ${created.name}`); // Created: #1 John Doe

    // The transaction committed successfully - the row is still visible.
    const { rowCount } = await db.executeQuery<UserRow>(
      'SELECT id, name, email FROM tx_users WHERE email = :email',
      { email: 'john@example.com' }
    );
    console.log(`Visible after commit: ${rowCount === 1}`); // Visible after commit: true
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Automatic Rollback on Error

Any error thrown inside the callback triggers an automatic `ROLLBACK`, the original error is rethrown, and the client is returned to the pool. This example pins `max: 1` so the TEMP table remains visible for the post-rollback verification.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
  // Keeps the TEMP table visible across calls in this example.
  poolConfig: { max: 1 },
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(config);

  try {
    await db.executeQuery(`
      CREATE TEMP TABLE tx_products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(10,2) NOT NULL
      )
    `);

    await db.executeQuery(
      'INSERT INTO tx_products (name, price) VALUES (:name, :price)',
      { name: 'Initial Product', price: 10.0 }
    );

    try {
      await db.withTransaction(async transactionDb => {
        await transactionDb.executeQuery(
          'INSERT INTO tx_products (name, price) VALUES (:name, :price)',
          { name: 'Should Be Rolled Back', price: 20.0 }
        );

        throw new Error('Intentional error to test rollback');
      });
    } catch (error) {
      if (error instanceof Error) {
        console.log(`Transaction failed: ${error.message}`);
        // Transaction failed: Intentional error to test rollback
      }
    }

    const { records, rowCount } = await db.executeQuery<{ name: string; price: string }>(
      'SELECT name, price FROM tx_products ORDER BY id'
    );

    console.log(`Rows after rollback: ${rowCount}`); // Rows after rollback: 1
    console.log(records[0].name);                    // Initial Product
    console.log(records[0].price);                   // 10.00
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Run Multiple Statements in One Transaction

All statements issued through the callback run on the same pinned client inside one transaction and are committed or rolled back together.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface OrderSummary {
  count: string;
  total_sum: string;
  confirmed_count: string;
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
    const summary = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE tx_orders (
          id SERIAL PRIMARY KEY,
          customer_name VARCHAR(100) NOT NULL,
          total DECIMAL(10,2) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending'
        )
      `);

      await transactionDb.executeQuery(
        'INSERT INTO tx_orders (customer_name, total) VALUES (:name, :total)',
        { name: 'Alice', total: 100.5 }
      );

      await transactionDb.executeQuery(
        'INSERT INTO tx_orders (customer_name, total) VALUES (:name, :total)',
        { name: 'Bob', total: 75.25 }
      );

      await transactionDb.executeQuery(
        'UPDATE tx_orders SET status = :status WHERE customer_name = :name',
        { status: 'confirmed', name: 'Alice' }
      );

      const { records } = await transactionDb.executeQuery<OrderSummary>(`
        SELECT
          COUNT(*) AS count,
          SUM(total) AS total_sum,
          COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_count
        FROM tx_orders
      `);

      return records[0];
    });

    console.log(`orders: ${summary.count}`);             // orders: 2
    console.log(`total: ${summary.total_sum}`);          // total: 175.75
    console.log(`confirmed: ${summary.confirmed_count}`); // confirmed: 1
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## INSERT Statements

### Insert a Row and Read the Affected Count

`.values()` sets the column values, each key becoming a named parameter of the same name. `.execute()` resolves with the full query result, while `.executeReturnCount()` resolves with just the affected row count.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  age?: number;
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
    const totals = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER
        )
      `);

      const first = await transactionDb
        .insert<User>('users')
        .values({ name: 'Integration Test', email: 'integration@example.com', age: 30 })
        .execute();

      const second = await transactionDb
        .insert<User>('users')
        .values({ name: 'Second User', email: 'second@example.com' })
        .executeReturnCount();

      const { records } = await transactionDb.executeQuery<User>(
        'SELECT id, name, email, age FROM users ORDER BY id'
      );

      return { first: first.rowCount, second, total: records.length };
    });

    console.log(`execute(): ${totals.first}, executeReturnCount(): ${totals.second}, rows: ${totals.total}`);
    // execute(): 1, executeReturnCount(): 1, rows: 2
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Capture the Inserted Row with `returning()` and `executeReturnSingle()`

Chain `.returning('*')` and `.executeReturnSingle()` to receive the inserted row including database-generated values such as `id` and `created_at`. Keep `.returning()` in the chain whenever you need the row data back.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  created_at?: Date;
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
    const created = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      return transactionDb
        .insert<User>('users')
        .values({ name: 'Single Return Test', email: 'single@example.com' })
        .returning('*')
        .executeReturnSingle();
    });

    if (created !== null) {
      console.log(`#${created.id} ${created.name}`);       // #1 Single Return Test
      console.log(created.created_at instanceof Date);      // true
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Insert JSONB and Array Values with `executeReturnAll()`

JSONB and array values are passed as native JavaScript objects and arrays and stored directly. `.executeReturnAll()` resolves with every returned row as a typed array.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Document {
  id?: number;
  name: string;
  metadata: { settings: { theme: string }; preferences?: string[] };
  tags: string[];
  created_at?: Date;
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
    const inserted = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE documents (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          metadata JSONB,
          tags TEXT[],
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      return transactionDb
        .insert<Document>('documents')
        .values({
          name: 'Complex Return All Test',
          metadata: { settings: { theme: 'dark' }, preferences: ['email', 'sms'] },
          tags: ['test', 'complex', 'returning'],
        })
        .returning('*')
        .executeReturnAll();
    });

    console.log(`Inserted ${inserted.length} row(s)`); // Inserted 1 row(s)
    console.log(inserted[0].metadata.settings.theme);  // dark
    console.log(inserted[0].tags.join(', '));          // test, complex, returning
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## UPDATE Statements

### Update a Row by Filter with RETURNING

The `SET` clause comes from `.values()` (rendered with internal `:v_`-prefixed parameters) and the `WHERE` clause from `.filter()`. With `.returning('*')` the updated row is returned in full and typed as the table type.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

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
    const updated = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER,
          active BOOLEAN DEFAULT true
        )
      `);

      await transactionDb.executeQuery(
        'INSERT INTO users (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Original Name', email: 'update@example.com', age: 25 }
      );

      return transactionDb
        .update<User, UserFilter>('users')
        .values({ name: 'Updated Name', age: 26 })
        .filter({ email: 'update@example.com' })
        .returning('*')
        .executeReturnSingle();
    });

    if (updated !== null) {
      console.log(`${updated.name} / age ${updated.age}`); // Updated Name / age 26
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Update Multiple Rows with `executeReturnAll()`

`.filter()` can match many rows; `.executeReturnAll()` then resolves with every updated row. WHERE-clause parameters are named `p1`, `p2`, … and can never collide with the `v_`-prefixed `SET` values.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Item {
  id?: number;
  name: string;
  category: string;
  active?: boolean;
}

interface ItemFilter {
  category?: string;
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
    const updated = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE items (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL,
          active BOOLEAN DEFAULT true
        )
      `);

      await transactionDb.executeQuery(`
        INSERT INTO items (name, category) VALUES
          ('Return All Test 1', 'Test Category'),
          ('Return All Test 2', 'Test Category'),
          ('Untouched Item', 'Other Category')
      `);

      return transactionDb
        .update<Item, ItemFilter>('items')
        .values({ active: false })
        .filter({ category: 'Test Category' })
        .returning('*')
        .executeReturnAll();
    });

    console.log(`Updated ${updated.length} row(s)`); // Updated 2 row(s)
    for (const item of updated) {
      console.log(`${item.name}: active=${String(item.active)}`);
      // Return All Test 1: active=false
      // Return All Test 2: active=false
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Bulk Update All Rows (No Filter)

⚠️ Without a `.filter()` call (or with an empty `{}` filter) the UPDATE has no `WHERE` clause and affects **every row in the table**. This example intentionally deactivates the whole table and reads the affected count.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface Account {
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
    const updatedCount = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE accounts (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          active BOOLEAN DEFAULT true
        )
      `);

      await transactionDb.executeQuery(`
        INSERT INTO accounts (name) VALUES ('User 1'), ('User 2'), ('User 3')
      `);

      // No .filter() call - the statement updates every row in the table.
      return transactionDb
        .update<Account, {}>('accounts')
        .values({ active: false })
        .executeReturnCount();
    });

    console.log(`Deactivated ${updatedCount} account(s)`); // Deactivated 3 account(s)
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## DELETE Statements

### Delete a Row and Capture It

Deletes the matching row and returns it via `RETURNING *`. When nothing matches, `executeReturnSingle()` resolves to `null`.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface UserRow {
  id?: number;
  name?: string;
  email?: string;
  age?: number;
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
    const deleted = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          age INTEGER
        )
      `);

      await transactionDb.executeQuery(
        'INSERT INTO users (name, email, age) VALUES (:name, :email, :age)',
        { name: 'Single Return Test', email: 'single@example.com', age: 25 }
      );

      return transactionDb
        .delete<UserRow>('users')
        .filter({ email: 'single@example.com' })
        .returning('*')
        .executeReturnSingle();
    });

    if (deleted !== null) {
      console.log(`Deleted #${deleted.id}: ${deleted.email}`); // Deleted #1: single@example.com
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Bulk Delete Every Row

⚠️ An empty filter such as `.filter({})` produces no `WHERE` clause — the statement deletes **every row in the table**. Use it deliberately and verify the outcome.

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
    const { deleted, remaining } = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE purge_test (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL
        )
      `);

      await transactionDb.executeQuery(`
        INSERT INTO purge_test (name) VALUES ('User 1'), ('User 2'), ('User 3')
      `);

      // An empty filter produces no WHERE clause - this deletes every row.
      const deleteResult = await transactionDb.delete<{}>('purge_test').filter({}).execute();

      const { records } = await transactionDb.executeQuery<{ count: string }>(
        'SELECT COUNT(*) AS count FROM purge_test'
      );

      return { deleted: deleteResult.rowCount, remaining: parseInt(records[0].count, 10) };
    });

    console.log(`Deleted: ${deleted}, remaining: ${remaining}`); // Deleted: 3, remaining: 0
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Count Deleted Rows with `executeReturnCount()`

`executeReturnCount()` resolves with the number of deleted rows and needs no `RETURNING` clause — ideal for purge jobs and cleanup routines.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface ItemFilter {
  category?: string;
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
    const deletedCount = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE items (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          category VARCHAR(50) NOT NULL
        )
      `);

      await transactionDb.executeQuery(`
        INSERT INTO items (name, category) VALUES
          ('Count Test 1', 'Count Category'),
          ('Count Test 2', 'Count Category'),
          ('Count Test 3', 'Other Category')
      `);

      return transactionDb
        .delete<ItemFilter>('items')
        .filter({ category: 'Count Category' })
        .executeReturnCount();
    });

    console.log(`Deleted ${deletedCount} row(s)`); // Deleted 2 row(s)
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## Query Hooks

### Transform Parameters with `beforeQuery`

The `beforeQuery` hook receives the fully built parameter object (keyed by column name for INSERT) and must return the object to execute with. Typical uses: normalizing emails and hashing passwords before they reach the database.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
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
    const created = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255)
        )
      `);

      return transactionDb
        .insert<User>('users')
        .values({
          name: 'Hook Test User',
          email: 'HOOK@EXAMPLE.COM',
          password_hash: 'plaintext123',
        })
        .beforeQuery((params: Record<string, unknown>) => {
          const email = params.email;
          if (typeof email === 'string') {
            params.email = email.toLowerCase();
          }
          const passwordHash = params.password_hash;
          if (typeof passwordHash === 'string') {
            // Replace this with a real hash function in production
            params.password_hash = `bcrypt_${passwordHash}`;
          }
          return params;
        })
        .returning('*')
        .executeReturnSingle();
    });

    if (created !== null) {
      console.log(created.email);          // hook@example.com
      console.log(created.password_hash);  // bcrypt_plaintext123
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Redact Sensitive Fields with `afterQuery`

`afterQuery` receives the raw result rows and must return an array. Redacting sensitive columns here keeps them out of every consumer of the statement — a single choke point instead of scattered field checks.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
  api_key?: string;
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
    const records = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          api_key VARCHAR(255)
        )
      `);

      await transactionDb.executeQuery(
        `INSERT INTO users (name, email, password_hash, api_key)
         VALUES (:name, :email, :password_hash, :api_key)`,
        {
          name: 'Sensitive Test',
          email: 'sensitive@example.com',
          password_hash: 'hashed_secret123',
          api_key: 'secret_api_key_xyz',
        }
      );

      return transactionDb
        .delete<User>('users')
        .filter({ email: 'sensitive@example.com' })
        .afterQuery((rows: User[]) =>
          rows.map(row => {
            const safe = { ...row };
            delete safe.password_hash;
            delete safe.api_key;
            return safe;
          })
        )
        .returning('*')
        .executeReturnAll();
    });

    console.log('password_hash' in records[0]); // false
    console.log('api_key' in records[0]);       // false
    console.log(records[0].email);              // sensitive@example.com
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Combine beforeQuery and afterQuery

`beforeQuery` and `afterQuery` can be combined on one statement: parameters are transformed on the way in, result rows on the way out.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
  role?: string;
  created_at?: Date;
  /** Added by the afterQuery hook in this example. */
  displayName?: string;
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
    const created = await db.withTransaction(async transactionDb => {
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          role VARCHAR(20) DEFAULT 'user',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      return transactionDb
        .insert<User>('users')
        .values({
          name: 'Combined Test',
          email: 'COMBINED@EXAMPLE.COM',
          password_hash: 'plaintext123',
          role: 'admin',
        })
        .beforeQuery((params: Record<string, unknown>) => {
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
        .afterQuery((records: User[]) =>
          records.map(record => {
            const safe = { ...record };
            delete safe.password_hash;
            safe.displayName = `${safe.name} (${safe.role})`;
            return safe;
          })
        )
        .returning('*')
        .executeReturnSingle();
    });

    console.log(created?.email);        // combined@example.com
    console.log(created?.displayName);  // Combined Test (admin)
    console.log(created !== null && !('password_hash' in created)); // true
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Apply Hooks to a Single `executeQuery` Call

The same hooks are available as options of `executeQuery()` — `options.beforeQuery` runs before parameter translation, `options.afterQuery` transforms the rows before the result is resolved.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

interface User {
  id: number;
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
    const { records } = await db.executeQuery<User>(
      "SELECT 1 AS id, '  Ada  ' AS name, :email AS email",
      { email: 'ADA@EXAMPLE.COM' },
      {
        beforeQuery: (params: Record<string, unknown>) => {
          const email = params.email;
          if (typeof email === 'string') {
            params.email = email.toLowerCase();
          }
          return params;
        },
        afterQuery: (rows: User[]) =>
          rows.map(row => ({ ...row, name: row.name.trim().toUpperCase() })),
      }
    );

    console.log(records[0].email); // ada@example.com
    console.log(records[0].name);  // ADA
  } finally {
    await db.disconnect();
  }
}

void main();
```

---

## Error Handling & Shutdown

### Recover from a Failed Query

A failed query releases its pooled client, so the database instance remains fully usable — catch the error and continue with the next statement.

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
    try {
      await db.executeQuery('THIS IS NOT VALID SQL');
    } catch (error) {
      if (error instanceof Error) {
        console.log('Query failed as expected:'); // Query failed as expected:
        console.log(error.message);               // syntax error at or near "THIS"
      }
    }

    // The failed client was released - the pool still works.
    const { records } = await db.executeQuery<{ test: number }>('SELECT 1 AS test');
    console.log(records[0].test); // 1
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Fail Fast After Shutdown Begins

Once `disconnect()` is called the instance rejects new queries with `Cannot execute query: database is shutting down` and new transactions with `Cannot start transaction: database is shutting down`, instead of hanging on a drained pool.

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

  await db.executeQuery<{ one: number }>('SELECT 1 AS one');

  // Start the shutdown; new work is now rejected.
  const disconnectPromise = db.disconnect();

  try {
    await db.executeQuery<{ one: number }>('SELECT 1 AS one');
  } catch (error) {
    if (error instanceof Error) {
      console.log(error.message); // Cannot execute query: database is shutting down
    }
  }

  try {
    await db.withTransaction(async () => 'never runs');
  } catch (error) {
    if (error instanceof Error) {
      console.log(error.message); // Cannot start transaction: database is shutting down
    }
  }

  await disconnectPromise;
  console.log('Shutdown complete'); // Shutdown complete
}

void main();
```

### Clear Errors for Empty `values()`

Building an INSERT or UPDATE without any values fails fast with an explicit error message instead of sending invalid SQL to the server.

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
    try {
      await db.insert<{ name: string }>('users').values({}).execute();
    } catch (error) {
      if (error instanceof Error) {
        console.log(error.message);
        // Cannot build INSERT statement for table "users": no values provided.
        // Call .values() with at least one column before executing.
      }
    }

    try {
      await db
        .update<{ name: string }, { id: number }>('users')
        .values({})
        .filter({ id: 1 })
        .execute();
    } catch (error) {
      if (error instanceof Error) {
        console.log(error.message);
        // Cannot build UPDATE statement for table "users": no values provided.
        // Call .values() with at least one column before executing.
      }
    }
  } finally {
    await db.disconnect();
  }
}

void main();
```

### Handle Connection Errors and Disconnect Cleanly

Connection failures surface on the first query, not at construction time. `disconnect()` still resolves cleanly on a pool that never connected, so `finally` cleanup blocks are always safe.

```typescript
import { PostgreSQLConfig, PostgreSQLDatabase } from 'blendsdk/postgresql';

const invalidConfig: PostgreSQLConfig = {
  host: 'invalid-host',
  port: 9999,
  database: 'appdb',
  user: 'app_user',
  pass: 'secret',
};

async function main(): Promise<void> {
  const db = new PostgreSQLDatabase(invalidConfig);

  try {
    await db.executeQuery<{ one: number }>('SELECT 1 AS one');
    console.log('Unexpected success');
  } catch (error) {
    if (error instanceof Error) {
      console.log(`Query failed: ${error.message}`);
      // Query failed: getaddrinfo ENOTFOUND invalid-host
    }
  }

  // disconnect() still resolves cleanly even though the pool never connected.
  await db.disconnect();
  console.log('Disconnected cleanly'); // Disconnected cleanly
}

void main();
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
