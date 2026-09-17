# Code Generation Pattern

> Generate TypeScript types from your PostgreSQL database schema.

**Packages:** `codegen`, `postgresql`

---

## Problem

How do I generate TypeScript interfaces from my database tables so my code stays in sync with the schema?

## Solution

### Basic Type Generation

```typescript fragment
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import { writeFileSync } from 'fs';

async function generateTypes() {
  const db = new PostgreSQLDatabase({
    host: 'localhost',
    port: 5432,
    database: 'myapp',
    user: 'postgres',
    password: 'password',
  });

  // Read the live schema into a container
  const container = new SchemaContainer();
  await new PostgreSQLIntrospector(db).introspect(container);

  // Render TypeScript from the container and write it out
  const lines = await new TypeGenerator().generate(container);
  writeFileSync('./src/generated/database-types.ts', lines.join('\n'));

  await db.close();
}
```

### Custom Type Mapping for JSON Columns

By default JSON/JSONB columns generate `any`. You can map them to custom types:

```typescript fragment
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import type { ColumnMapper } from 'blendsdk/codegen';

const container = new SchemaContainer();

// Map JSON/JSONB columns to a named type instead of the default `any`
const mapJsonColumns: ColumnMapper = (column, scope) => {
  if (!['json', 'jsonb'].includes(column.pg_type)) return undefined;
  return scope.object({}).named('UserPreferences');
};

await new PostgreSQLIntrospector(db).introspect(container, mapJsonColumns);

const lines = await new TypeGenerator().generate(container);
```

**Generated output:**
```typescript
export interface UserPreferences {
  theme: 'light' | 'dark' | 'auto';
  emailNotifications: boolean;
  language: 'en' | 'nl' | 'de';
}

export interface Users {
  id: number;
  email: string;
  preferences: UserPreferences; // ✅ Type-safe instead of 'any'
}
```

### Schema Builder for Temporary Test Databases

```typescript fragment
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('testdb');

schema.table('users').bigint('id').primaryKey();
schema.table('users').varchar('email', 255).unique();
schema.table('users').jsonb('preferences');
schema.table('users').timestamp('created_at').default('CURRENT_TIMESTAMP');
```

## Key Points

- **Define custom types before introspection** — the mapper reads from the container
- **`ColumnMapper`** receives a column description and the schema scope for the relation
- Run `yarn generate-types` as part of your build pipeline to keep types fresh
- `SchemaContainer` holds the introspected types; `TypeGenerator` renders them to TypeScript
- `DatabaseSchema` builds a migration schema for isolated test databases
