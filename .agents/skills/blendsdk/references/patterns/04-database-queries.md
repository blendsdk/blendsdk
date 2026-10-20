# Database Query Patterns

> Build type-safe SQL queries with the expression builder and database abstraction.

**Packages:** `expression`, `dbcore`, `postgresql`

---

## Problem

How do I build type-safe, parameterized SQL queries without writing raw SQL strings?

## Solution

### Expression Builder — WHERE Clauses

```typescript
import { query } from 'blendsdk/expression';

// Simple equality
const result = query()
  .where('status').equals('active')
  .compile();
// SQL: status = $1  |  Params: { $1: 'active' }

// Multiple conditions
const result = query()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .compile();
// SQL: status = $1 AND age > $2

// Nested groups
const result = query()
  .where('status').equals('active')
  .and(q => q
    .where('role').equals('admin')
    .or('verified').equals(true)
  )
  .compile();
// SQL: status = $1 AND (role = $2 OR verified = $3)
```

### Common Operations

```typescript
// Range
query().where('price').between(10, 100);

// Set membership
query().where('status').in(['active', 'pending']);

// NULL checks
query().where('deleted_at').isNull();

// Pattern matching
query().where('email').like('%@gmail.com');
query().where('name').ilike('%john%');     // Case-insensitive
query().where('name').startsWith('John');  // LIKE 'John%'
query().where('name').contains('smith');   // LIKE '%smith%'
```

### PostgreSQL JSON Operations

```typescript
// JSON contains (@>)
query().where('metadata').jsonContains({ type: 'premium' });

// Has key (?)
query().where('settings').jsonHasKey('theme');

// Full-text search
query().where('content').search('javascript tutorial');
query().search(['title', 'body'], 'react hooks', { mode: 'websearch' });
```

### Type-Safe Queries with Generics

```typescript
interface User {
  id: number;
  email: string;
  age: number;
  status: 'active' | 'inactive';
}

const result = query<User>()
  .where('email').equals('test@example.com')  // ✓ type-safe
  .and('age').greaterThan(18)                  // ✓ type-safe
  // .where('invalid').equals('x')             // ✗ compile error
  .compile();
```

### Using with Database Statements

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { query } from 'blendsdk/expression';

const db = new PostgreSQLDatabase({ host: 'localhost', database: 'myapp' });
await db.connect();

// SELECT with expression filter
const users = await db.from('users')
  .selectAll()
  .where(query<User>()
    .where('status').equals('active')
    .and('age').greaterThan(18)
  )
  .execute();

// INSERT
const newUser = await db.insert('users')
  .values({ email: 'alice@example.com', name: 'Alice', status: 'active' })
  .returning('*')
  .execute();

// UPDATE with expression filter
await db.update('users')
  .set({ status: 'inactive' })
  .where(query().where('last_login').lessThan(new Date('2025-01-01')))
  .execute();

// DELETE with expression filter
await db.delete('users')
  .where(query().where('status').equals('deleted'))
  .execute();
```

### Connection Pool Management

```typescript
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: 5432,
  database: 'myapp',
  user: 'postgres',
  password: 'password',
  // Pool settings
  poolSize: 20,
  idleTimeout: 30000,
});

await db.connect();

// In WebAFX — register as singleton with dispose
app.registerService({
  name: 'db',
  type: 'singleton',
  factory: async (container, settings) => {
    const db = new PostgreSQLDatabase({
      host: settings.get('DB_HOST', 'localhost'),
      database: settings.get('DB_NAME', 'myapp'),
    });
    await db.connect();
    return db;
  },
  dispose: async (db) => await db.close(),
});
```

## Key Points

- **`query()`** creates an immutable expression builder — each method returns a new instance
- **Parameters are automatic** — no manual `$1`, `$2` numbering (prevents SQL injection)
- Use **generics** (`query<User>()`) for compile-time column name checking
- **`compile()`** is lazy — SQL is only generated when you call it
- **Zero dependencies** in the expression package — lightweight and focused
- For WebAFX: register `PostgreSQLDatabase` as a **singleton service with `dispose`**
- Use **`db.from(table).selectAll()`** for SELECT, **`db.insert(table).values()`** for INSERT
