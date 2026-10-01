# @blendsdk/expression2

A modern, type-safe SQL WHERE clause builder with fluent API design. Built for performance, maintainability, and developer experience.

## Features

- 🔒 **Type-Safe**: Full TypeScript support with generic schema types
- 🔗 **Fluent API**: Chainable methods for intuitive query building
- 🎯 **Multi-Dialect**: PostgreSQL support (MySQL, MSSQL, SQLite coming soon)
- 🚀 **Performance**: Immutable AST with efficient compilation
- 🛡️ **SQL Injection Prevention**: Automatic parameter management
- 🔍 **Advanced Operations**: JSON, full-text search, subqueries
- 🐛 **Debug Mode**: Detailed compilation information
- 📦 **Zero Dependencies**: Lightweight and focused

## Installation

```bash
yarn add @blendsdk/expression2
```

## Quick Start

```typescript
import { query } from '@blendsdk/expression2';

// Simple equality
const result = query()
  .where('status').equals('active')
  .compile();
// SQL: status = $1
// Params: { $1: 'active' }

// Multiple conditions
const result = query()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .compile();
// SQL: status = $1 AND age > $2
// Params: { $1: 'active', $2: 18 }

// Nested conditions with grouping
const result = query()
  .where('status').equals('active')
  .and(q => q
    .where('age').greaterThan(21)
    .or('verified').equals(true)
  )
  .compile();
// SQL: status = $1 AND (age > $2 OR verified = $3)
// Params: { $1: 'active', $2: 21, $3: true }
```

## API Reference

### Creating a Query

```typescript
import { query, SqlDialect } from '@blendsdk/expression2';

// Default (PostgreSQL)
const q = query();

// With options
const q = query({
  dialect: SqlDialect.PostgreSQL,
  debug: true
});

// With TypeScript schema
interface User {
  id: number;
  email: string;
  age: number;
  status: string;
}

const q = query<User>();
```

### Comparison Operators

#### Basic Comparisons

```typescript
// Equality
.where('status').equals('active')
.where('status').notEquals('deleted')

// Numeric comparisons
.where('age').greaterThan(18)
.where('age').greaterThanOrEqual(18)
.where('age').lessThan(65)
.where('age').lessThanOrEqual(65)

// Range
.where('age').between(18, 65)
.where('age').notBetween(0, 17)

// Set membership
.where('status').in(['active', 'pending'])
.where('status').notIn(['deleted', 'banned'])

// Null checks
.where('deleted_at').isNull()
.where('deleted_at').isNotNull()
```

#### Pattern Matching

```typescript
// LIKE operator
.where('email').like('%@gmail.com')
.where('email').ilike('%@GMAIL.COM')  // Case-insensitive

// Helper methods
.where('name').startsWith('John')     // name LIKE 'John%'
.where('name').endsWith('Smith')      // name LIKE '%Smith'
.where('name').contains('middle')     // name LIKE '%middle%'
```

### Logical Operators

```typescript
// AND
query()
  .where('status').equals('active')
  .and('age').greaterThan(18)

// OR
query()
  .where('role').equals('admin')
  .or('role').equals('moderator')

// Nested conditions with callbacks
query()
  .where('status').equals('active')
  .and(q => q
    .where('age').greaterThan(21)
    .or('verified').equals(true)
  )
```

### JSON Operations

PostgreSQL JSON/JSONB operators:

```typescript
// Contains (@>)
.where('data').jsonContains({ type: 'premium' })

// Contained by (<@)
.where('data').jsonContainedBy({ type: 'premium', active: true })

// Has key (?)
.where('metadata').jsonHasKey('email')

// Has any key (?|)
.where('metadata').jsonHasAnyKey(['email', 'phone'])

// Has all keys (?&)
.where('metadata').jsonHasAllKeys(['email', 'phone'])

// Path exists (@?)
.where('data').jsonPathExists('$.user.email')
```

### Full-Text Search

PostgreSQL full-text search:

```typescript
// Simple search (single column)
.where('content').search('javascript')

// Multi-column search
.search(['title', 'content'], 'javascript tutorial')

// Search modes
.where('content').search('javascript', { mode: 'plain' })
.where('content').search('javascript tutorial', { mode: 'phrase' })
.where('content').search('javascript -tutorial', { mode: 'websearch' })

// Custom language
.where('content').search('bonjour', { language: 'french' })
```

### Subqueries

```typescript
// EXISTS
.where('id').exists(
  query().where('user_id').equalsColumn('users.id')
)

// NOT EXISTS
.where('id').notExists(
  query().where('user_id').equalsColumn('users.id')
)

// IN subquery
.where('id').inSubquery(
  query().where('status').equals('active')
)

// NOT IN subquery
.where('id').notInSubquery(
  query().where('status').equals('deleted')
)
```

### Compilation

```typescript
const result = query()
  .where('status').equals('active')
  .compile();

console.log(result.sql);     // "status = $1"
console.log(result.params);  // { $1: 'active' }
```

### Debug Mode

```typescript
const result = query({ debug: true })
  .where('status').equals('active')
  .compile();

console.log(result.debug);
// {
//   ast: { ... },
//   optimizations: [],
//   parameterCount: 1,
//   compilationTime: 0.123,
//   warnings: []
// }
```

## Type Safety

The library provides full TypeScript support with generic schema types:

```typescript
interface User {
  id: number;
  email: string;
  age: number;
  status: 'active' | 'inactive' | 'deleted';
  metadata: {
    verified: boolean;
    premium: boolean;
  };
}

const result = query<User>()
  .where('email').equals('test@example.com')  // ✓ Type-safe
  .and('age').greaterThan(18)                 // ✓ Type-safe
  .and('status').equals('active')             // ✓ Type-safe
  // .where('invalid').equals('value')        // ✗ Compile error
  .compile();
```

## Integration with dbcore

This package is designed to integrate seamlessly with `@blendsdk/dbcore`:

```typescript
import { Database } from '@blendsdk/dbcore';
import { query } from '@blendsdk/expression2';

const db = new Database(/* ... */);

// Build WHERE clause
const whereClause = query<User>()
  .where('status').equals('active')
  .and('age').greaterThan(18);

// Use with dbcore
const users = await db
  .from('users')
  .where(whereClause)
  .select();
```

## Architecture

### Immutable AST

The library uses an immutable Abstract Syntax Tree (AST) to represent queries:

```typescript
// Each operation creates a new AST node
const ast = createComparisonNode('status', '=', 'active', undefined, ['p1']);
```

### Parameter Management

Automatic parameter management prevents SQL injection:

```typescript
// Parameters are automatically numbered and tracked
const paramManager = new ParameterManager(SqlDialect.PostgreSQL);
const paramName = paramManager.addParameterWithValue('active');
// Returns: 'p1'
// Formatted as: '$1' for PostgreSQL
```

### Compiler Pattern

Dialect-specific compilers generate SQL from the AST:

```typescript
const compiler = new PostgreSQLCompiler(paramManager);
const sql = compiler.compile(ast);
```

## Performance Considerations

- **Immutable AST**: Prevents accidental mutations and enables safe sharing
- **Parameter Deduplication**: Reuses parameters with identical values (optional)
- **Lazy Compilation**: SQL is only generated when `.compile()` is called
- **Zero Runtime Dependencies**: Minimal overhead

## Roadmap

- [ ] MySQL dialect support
- [ ] MSSQL dialect support
- [ ] SQLite dialect support
- [ ] Query optimization passes
- [ ] Performance profiling tools
- [ ] Additional operators (SIMILAR TO, REGEXP, etc.)
- [ ] Window functions support
- [ ] CTE (Common Table Expressions) support

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests to our repository.

## License

MIT License - see LICENSE file for details

## Related Packages

- `@blendsdk/dbcore` - Database abstraction layer
- `@blendsdk/postgresql` - PostgreSQL-specific implementation
- `@blendsdk/codegen` - Schema code generation

## Support

For issues, questions, or contributions, please visit our GitHub repository.
