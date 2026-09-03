# @blendsdk/codegen

A powerful TypeScript code generation library that provides a fluent API for creating schema definitions and generating corresponding TypeScript types, interfaces, and type aliases.

## Features

- **Fluent API**: Intuitive builder pattern for schema creation
- **Schema Registry**: Centralized management and reference resolution
- **Type Generation**: Automatic TypeScript code generation with proper formatting
- **Complex Types**: Support for nested objects, arrays, unions, and references
- **Type Modifiers**: Optional, nullable, partial, and array type support
- **JSDoc Integration**: Automatic documentation generation
- **PostgreSQL Migrations**: Snapshot-based, reviewable schema migrations from `DatabaseSchema`

## Installation

```bash
yarn add @blendsdk/codegen
```

The public `blendsdk migrate` executable is distributed by the assembled `blendsdk` package. Add
the optional `pg` peer when a command must connect to PostgreSQL:

```bash
yarn add blendsdk pg
```

## PostgreSQL migrations

Define the desired database once in a schema module and point a small configuration file at it:

```ts
// src/database/schema.ts
import { DatabaseSchema } from 'blendsdk/codegen';

const schema = new DatabaseSchema('app');
const customer = schema.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255);

export default schema;
```

```ts
// blendsdk.migrations.ts
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
});
```

Create the initial lineage once, then use the same short loop for each modeled change:

```bash
yarn blendsdk migrate baseline initial
yarn blendsdk migrate generate add-customer-status
yarn blendsdk migrate validate --offline
```

Review and commit the generated `.up.sql` file and `schema.snapshot.json` together. Use
`yarn blendsdk migrate create <name>` for data changes or PostgreSQL objects the schema model cannot
represent. Database-backed commands use the environment variable named by `databaseUrlEnv`
(`DATABASE_URL` by default):

```bash
yarn blendsdk migrate status
yarn blendsdk migrate up --dry-run
yarn blendsdk migrate up
```

Production applies only committed migrations; it never generates from the live database. Keep
`down` for explicitly guarded local recovery and prefer forward recovery in production.

## Quick Start

```typescript
import {
  SchemaRegistry,
  ObjectSchema,
  StringSchema,
  NumberSchema,
  BooleanSchema,
  TypeGenerator,
} from '@blendsdk/codegen';

// Create a registry
const registry = new SchemaRegistry();

// Define a user schema
const userSchema = new ObjectSchema(registry)
  .named('User')
  .description('User account information')
  .properties({
    id: new NumberSchema(registry).description('Unique user identifier'),
    name: new StringSchema(registry).description('User display name'),
    email: new StringSchema(registry).description('User email address'),
    isActive: new BooleanSchema(registry).optional().description('Account status'),
  });

// Generate TypeScript code
const generator = new TypeGenerator(userSchema);
const code = await generator.generate();

console.log(code);
```

**Generated Output:**

```typescript
export interface User {
  /** Unique user identifier */
  id: number;
  /** User display name */
  name: string;
  /** User email address */
  email: string;
  /** Account status */
  isActive?: boolean;
}
```

## Core Concepts

### Schema Registry

The SchemaRegistry acts as a central container for managing named schemas:

```typescript
// Create registries with different scopes
const globalRegistry = new SchemaRegistry(); // Uses 'default' scope
const apiRegistry = new SchemaRegistry('api');
const dbRegistry = new SchemaRegistry('database');

// Register schemas
const userSchema = new ObjectSchema(apiRegistry).named('User');
const postSchema = new ObjectSchema(apiRegistry).named('Post');

// Later reference them
const userRef = new ReferenceSchema(apiRegistry).to('User');
```

### Schema Types

#### String Schema

```typescript
// Basic string type
const nameSchema = new StringSchema(registry)
  .named('UserName')
  .description("The user's display name")
  .optional();

// String literal enum
const statusSchema = new StringSchema(registry)
  .named('Status')
  .enum('active', 'inactive', 'pending')
  .description('User account status');

// Generates: export type Status = 'active' | 'inactive' | 'pending';
```

#### Number Schema

```typescript
// Basic number type
const ageSchema = new NumberSchema(registry)
  .named('Age')
  .description('User age in years')
  .optional();

// Numeric literal enum
const prioritySchema = new NumberSchema(registry)
  .named('Priority')
  .enum(1, 2, 3, 4, 5)
  .description('Task priority level');

// Generates: export type Priority = 1 | 2 | 3 | 4 | 5;

// HTTP status codes example
const httpStatusSchema = new NumberSchema(registry)
  .named('HttpStatus')
  .enum(200, 404, 500)
  .description('Common HTTP status codes');
```

#### Boolean Schema

```typescript
// Basic boolean type
const isActiveSchema = new BooleanSchema(registry)
  .named('IsActive')
  .description('Whether the user account is active')
  .optional();

// Boolean as object property
const userSchema = new ObjectSchema(registry).named('User').properties({
  name: new StringSchema(registry),
  isVerified: new BooleanSchema(registry).description('Email verification status'),
  hasPermissions: new BooleanSchema(registry)
    .optional()
    .description('Whether user has admin permissions'),
});

// Generates:
// export interface User {
//   name: string;
//   /** Email verification status */
//   isVerified: boolean;
//   /** Whether user has admin permissions */
//   hasPermissions?: boolean;
// }
```

#### Object Schema

```typescript
// Single property addition
const userSchema = new ObjectSchema(registry)
  .named('User')
  .property('id', new NumberSchema(registry))
  .property('name', new StringSchema(registry))
  .property('email', new StringSchema(registry).optional());

// Multiple properties at once
const userSchema = new ObjectSchema(registry).named('User').properties({
  id: new NumberSchema(registry).description('User ID'),
  name: new StringSchema(registry).description('Full name'),
  email: new StringSchema(registry).description('Email address'),
  age: new NumberSchema(registry).optional().description('User age'),
  status: new StringSchema(registry).enum('active', 'inactive'),
});

// Can also be chained with individual property calls
userSchema.property('createdAt', new StringSchema(registry).description('Creation timestamp'));

// Nested object example
const profileSchema = new ObjectSchema(registry).named('Profile').properties({
  user: userSchema, // Reference to another object schema
  settings: new ObjectSchema(registry).properties({
    theme: new StringSchema(registry).enum('light', 'dark'),
    notifications: new BooleanSchema(registry),
  }),
});
```

### Type Modifiers

#### Fluent API Methods

```typescript
// Creates Partial<User> instead of User
const partialUser = userSchema.partial();

// Generates: string | string[]
const flexibleString = stringSchema.singleOrArrayed();

// Generates: string[]
const stringArray = stringSchema.arrayed();

// Generates: string | null
const nullableString = stringSchema.nullable();

// In an interface: name?: string
const optionalName = stringSchema.optional();
```

#### Descriptions and Metadata

```typescript
const documented = stringSchema.description(
  "The user's email address",
  'Must be a valid email format'
);

const userSchema = objectSchema.named('User');
// Later can be referenced: referenceSchema.to('User')

const annotated = stringSchema.metadata({
  validation: { minLength: 3, maxLength: 50 },
  ui: { component: 'TextInput' },
});
```

### Schema Registry Methods

```typescript
const userSchema = new ObjectSchema(registry);
registry.register('User', userSchema);

// Now can be referenced elsewhere
const userRef = new ReferenceSchema(registry).to('User');

// Get all schemas
const allSchemas = registry.getAllSchemas();
Object.entries(allSchemas).forEach(([name, schema]) => {
  console.log(`Found schema: ${name}`);
});

// Get specific schema
const userSchema = registry.getSchema('User');
if (userSchema) {
  // Schema exists, safe to use
  console.log('User schema found');
}

// Check if schema exists
if (registry.hasSchema('User')) {
  // Safe to create a reference to User
  const userRef = new ReferenceSchema(registry).to('User');
} else {
  console.warn('User schema not found');
}

console.log(`Registry contains ${registry.getSchemaCount()} schemas`);

const names = registry.getSchemaNames();
console.log('Available schemas:', names.join(', '));
```

### Object Schema Utilities

```typescript
const userSchema = new ObjectSchema(registry).properties({
  id: new NumberSchema(registry),
  name: new StringSchema(registry),
});

const props = userSchema.getProperties();
Object.entries(props).forEach(([propName, propSchema]) => {
  console.log(`Property: ${propName}, Type: ${propSchema.getData().tsType}`);
});
// Output:
// Property: id, Type: number
// Property: name, Type: string

const userSchema = new ObjectSchema(registry).properties({
  id: new NumberSchema(registry),
  name: new StringSchema(registry),
  email: new StringSchema(registry),
});

console.log(userSchema.getPropertyCount()); // Output: 3
console.log(userSchema.getPropertyNames()); // Output: ['id', 'name', 'email']

const userSchema = new ObjectSchema(registry).property('id', new NumberSchema(registry));

console.log(userSchema.hasProperty('id')); // Output: true
console.log(userSchema.hasProperty('name')); // Output: false
```

### Type Generation

```typescript
// Create schemas
const registry = new SchemaRegistry();
const userSchema = new ObjectSchema(registry).named('User').properties({
  name: new StringSchema(registry).description('User name'),
  age: new NumberSchema(registry).optional(),
});

// Generate TypeScript code
const generator = new TypeGenerator(userSchema);
const code = await generator.generate();

// Result:
// export interface User {
//   /** User name */
//   name: string;
//   age?: number;
// }

const generator = new TypeGenerator(schema);
const typeDefinitions = await generator.generate();
console.log(typeDefinitions); // Formatted TypeScript code
```

## Advanced Examples

### Complex Nested Structures

```typescript
const registry = new SchemaRegistry();

// Define address schema
const addressSchema = new ObjectSchema(registry).named('Address').properties({
  street: new StringSchema(registry).description('Street address'),
  city: new StringSchema(registry).description('City name'),
  zipCode: new StringSchema(registry).description('ZIP/Postal code'),
  country: new StringSchema(registry).description('Country name'),
});

// Define user schema with nested address
const userSchema = new ObjectSchema(registry).named('User').properties({
  id: new NumberSchema(registry).description('Unique identifier'),
  name: new StringSchema(registry).description('Full name'),
  email: new StringSchema(registry).description('Email address'),
  addresses: addressSchema.arrayed().description('User addresses'),
  primaryAddress: addressSchema.optional().description('Primary address'),
});

// Generate code
const generator = new TypeGenerator(userSchema);
const code = await generator.generate();
```

### Enum Types and Unions

```typescript
const registry = new SchemaRegistry();

// String enums
const userRoleSchema = new StringSchema(registry)
  .named('UserRole')
  .enum('admin', 'user', 'guest')
  .description('User role in the system');

// Number enums
const httpStatusSchema = new NumberSchema(registry)
  .named('HttpStatus')
  .enum(200, 201, 400, 401, 403, 404, 500)
  .description('HTTP response status codes');

// Complex object with enums
const apiResponseSchema = new ObjectSchema(registry).named('ApiResponse').properties({
  status: httpStatusSchema.description('Response status code'),
  data: new StringSchema(registry).nullable().description('Response data'),
  userRole: userRoleSchema.optional().description('User role if authenticated'),
});
```

## API Reference

### BaseSchema

Abstract base class providing the fluent API foundation.

**Methods:**

- `partial()` - Mark as partial type
- `singleOrArrayed()` - Accept single value or array
- `arrayed()` - Mark as array type
- `nullable()` - Allow null values
- `optional()` - Mark as optional property
- `description(...strings)` - Set description
- `named(name)` - Assign name and register
- `metadata(data)` - Attach metadata

### SchemaRegistry

Central registry for schema management.

**Methods:**

- `register(name, schema)` - Register a schema
- `getAllSchemas()` - Get all registered schemas
- `getSchema(name)` - Get specific schema
- `hasSchema(name)` - Check if schema exists
- `getSchemaCount()` - Get count of schemas
- `getSchemaNames()` - Get array of schema names

### TypeGenerator

Generates TypeScript code from schemas.

**Methods:**

- `generate()` - Generate formatted TypeScript code

## License

MIT License - see LICENSE file for details.
