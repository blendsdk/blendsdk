# BlendSDK v5

> Enterprise-grade TypeScript libraries for web applications, database operations, and code generation

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Monorepo](https://img.shields.io/badge/Monorepo-Turbo-blueviolet.svg)](https://turbo.build/)

## Overview

BlendSDK v5 is a modern TypeScript monorepo providing production-ready libraries for building enterprise web applications. With a focus on **type safety**, **developer experience**, and **fluent APIs**, BlendSDK offers everything from web frameworks to database abstraction and code generation tools.

### Core Principles

- 🎯 **Type Safety First** - Strict TypeScript with full type coverage
- 🔄 **Fluent APIs** - Chainable, intuitive interfaces
- 📦 **Modular Design** - Use only what you need
- ⚡ **Performance** - Optimized for production workloads
- 🧪 **Fully Tested** - Comprehensive test coverage with Vitest
- 🚀 **ESM Native** - Modern ECMAScript modules

## Packages

### Web Application Framework

#### [@blendsdk/webafx](packages/webafx)

Production-ready Express.js framework with dependency injection, plugin system, and fluent routing.

```typescript
import { WebApplication, BaseController } from '@blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

class UserController extends BaseController {
  routes() {
    return [
      this.route().get('/').handle(this.list),
      this.authenticated().post('/').handle(this.create),
    ];
  }
}

app.registerController('/api/users', UserController);
await app.start();
```

**Features:**

- Dependency injection container
- Plugin-based architecture
- Fluent route builder with authentication/authorization
- Built-in middleware (CORS, compression, request ID)
- Graceful shutdown support
- Health checks

---

### Database & Persistence

#### [@blendsdk/postgresql](packages/postgresql)

PostgreSQL client with connection pooling and graceful shutdown.

```typescript
import { PostgreSQLDatabase } from '@blendsdk/postgresql';

const db = new PostgreSQLDatabase({
  host: 'localhost',
  database: 'myapp',
  user: 'postgres',
  password: 'secret',
});

await db.connect();
const users = await db.query('SELECT * FROM users WHERE active = $1', [true]);
await db.shutdown();
```

**Features:**

- Connection pooling with `pg` driver
- Graceful connection management
- Transaction support
- Prepared statements
- Health checks

#### [@blendsdk/dbcore](packages/dbcore)

Database abstraction layer with CRUD statement builders.

```typescript
import { SelectStatement } from '@blendsdk/dbcore';

const query = new SelectStatement()
  .from('users')
  .select('id', 'email', 'name')
  .where('active = $1', true)
  .orderBy('created_at DESC')
  .limit(10);

const { sql, params } = query.compile();
```

**Features:**

- Fluent query builders (SELECT, INSERT, UPDATE, DELETE)
- Expression builder integration
- Parameter binding
- Type-safe compilation

#### [@blendsdk/expression](packages/expression)

Immutable AST-based SQL WHERE clause builder.

```typescript
import { query } from '@blendsdk/expression';

const result = query()
  .where('status')
  .equals('active')
  .and(q => q.where('age').greaterThan(21).or('verified').equals(true))
  .compile();

// Output: { sql: "status = $1 AND (age > $2 OR verified = $3)", params: {...} }
```

**Features:**

- Immutable query objects
- Nested conditions
- Type-safe operators
- SQL injection protection

---

### Code Generation

#### [@blendsdk/codegen](packages/codegen)

TypeScript/Zod/SQL generator with PostgreSQL introspection.

```typescript
import { SchemaContainer, TypeGenerator } from '@blendsdk/codegen';

const schema = new SchemaContainer();
const s = schema.scope('api');

const User = s
  .object({
    id: s.number(),
    email: s.string(),
    role: s.string().enum(['admin', 'user']),
  })
  .named('User');

const typeGen = new TypeGenerator();
const tsCode = await typeGen.generate(schema);
```

**Features:**

- Database schema builder (DDL generation)
- TypeScript type generation
- Zod schema generation
- PostgreSQL introspection (reverse engineering)
- Supports enums, arrays, nullable types

---

### Utilities

#### [@blendsdk/blendscript](packages/blendscript)

Safe, deterministic expression evaluation for business-authored rules.

```typescript
import { compileExpression, evaluateExpression } from '@blendsdk/blendscript';

const compiled = compileExpression('Country == "NL" AND Enabled == TRUE', {
  schema: {
    Country: { type: 'string' },
    Enabled: { type: 'boolean' },
  },
  expectedResult: 'boolean',
});

if (compiled.ok) {
  const result = evaluateExpression(compiled.expression, {
    Country: 'NL',
    Enabled: true,
  });
}
```

**Features:**

- Formula-friendly comparisons, logic, membership, and text functions
- Validation, reusable compilation, and deterministic evaluation
- No dynamic code, host functions, I/O, or runtime dependencies

#### [@blendsdk/stdlib](packages/stdlib)

Standard library with type guards and utility functions.

```typescript
import { isString, isNumber, isDefined } from '@blendsdk/stdlib';

if (isString(value)) {
  console.log(value.toUpperCase()); // TypeScript knows value is string
}
```

**Features:**

- Type guards for runtime checking
- Common utility functions
- No external dependencies

#### [@blendsdk/cmdline](packages/cmdline)

Fluent command-line argument parser with validation.

```typescript
import { CommandLineParser } from '@blendsdk/cmdline';

const parser = new CommandLineParser()
  .option('--port', { type: 'number', default: 3000 })
  .option('--env', { type: 'string', choices: ['dev', 'prod'] })
  .flag('--verbose');

const args = parser.parse(process.argv);
console.log(`Starting on port ${args.port}`);
```

**Features:**

- Type-safe argument parsing
- Validation and default values
- Help text generation
- Boolean flags

### React Components

#### [@blendsdk/react](packages/react)

React component and hook library for BlendSDK applications. Provides reusable UI components with full TypeScript support.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from '@blendsdk/react';

// Wrap your app with the provider
<GlobalLoaderProvider config={{ spinnerColor: '#25b09b' }}>
  <App />
</GlobalLoaderProvider>;

// Use the hook anywhere inside the provider
const { showLoader, setText } = useGlobalLoader();
setText('Loading data…');
showLoader(true);
```

**Features:**

- Full-screen GlobalLoader with CSS-only spinner animation
- Context + Provider + Hook pattern for app-wide loader control
- Configurable appearance (colors, size, z-index, custom text component)
- Body scroll lock, nesting detection, auto-text-clearing
- Zero dependencies beyond React 19+

---

## Installation

### Install Individual Packages

```bash
# Web framework
npm install @blendsdk/webafx

# Database
npm install @blendsdk/postgresql @blendsdk/dbcore @blendsdk/expression

# Code generation
npm install @blendsdk/codegen

# Utilities
npm install @blendsdk/stdlib @blendsdk/cmdline
```

### Prerequisites

- **Node.js**: >= 22.0.0
- **Package Manager**: npm, yarn, or pnpm

---

## Quick Start

### 1. Web Application

```typescript
import { WebApplication, BaseController } from '@blendsdk/webafx';
import { PostgreSQLDatabase } from '@blendsdk/postgresql';

const app = new WebApplication({ PORT: 3000 });

// Register database service
app.registerService({
  name: 'db',
  type: 'singleton',
  factory: async () => {
    const db = new PostgreSQLDatabase({/* config */});
    await db.connect();
    return db;
  },
});

// Create controller
class UserController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.list)];
  }

  async list(req, res) {
    const db = await req.services.get('db');
    const users = await db.query('SELECT * FROM users');
    res.json(users);
  }
}

app.registerController('/api/users', UserController);

const shutdown = await app.start();
console.log('Server running on http://localhost:3000');

process.on('SIGTERM', shutdown);
```

### 2. Database Queries

```typescript
import { PostgreSQLDatabase } from '@blendsdk/postgresql';
import { SelectStatement } from '@blendsdk/dbcore';
import { query } from '@blendsdk/expression';

const db = new PostgreSQLDatabase({/* config */});
await db.connect();

// Using raw queries
const result = await db.query('SELECT * FROM users WHERE id = $1', [123]);

// Using statement builders
const stmt = new SelectStatement()
  .from('users')
  .select('*')
  .where(query().where('active').equals(true).and('role').in(['admin', 'user']).compile());

const { sql, params } = stmt.compile();
const users = await db.query(sql, Object.values(params));
```

### 3. Code Generation

```typescript
import { SchemaContainer, TypeGenerator, ZodGenerator } from '@blendsdk/codegen';

const schema = new SchemaContainer();
const s = schema.scope('api');

// Define schema
const User = s
  .object({
    id: s.number(),
    email: s.string(),
    name: s.string().optional(),
    roles: s.string().arrayed(),
  })
  .named('User');

// Generate TypeScript types
const typeGen = new TypeGenerator();
const types = await typeGen.generate(schema);
console.log(types);
// export interface User {
//   id: number;
//   email: string;
//   name?: string;
//   roles: string[];
// }

// Generate Zod schemas
const zodGen = new ZodGenerator();
const schemas = await zodGen.generate(schema);
console.log(schemas);
// export const UserSchema = z.object({
//   id: z.number(),
//   email: z.string(),
//   name: z.string().optional(),
//   roles: z.array(z.string())
// });
```

---

## Development

BlendSDK is a monorepo managed with [Turbo](https://turbo.build/) and uses **lockstep versioning** (all packages share the same version).

### Setup

```bash
# Clone repository
git clone https://github.com/TrueSoftwareNL/blendsdk.git
cd blendsdk

# Install dependencies (requires Yarn)
yarn install

# Build all packages
yarn build

# Run tests
yarn test
```

### Package Scripts

```bash
# Build all packages
yarn build

# Test all packages
yarn test

# Test with coverage
yarn test --coverage

# Watch mode
yarn test:watch

# Type check
yarn type-check

# Clean build artifacts
yarn clean
```

### Working with Individual Packages

```bash
# Navigate to package
cd packages/webafx

# Build specific package
yarn build

# Test specific package
yarn test

# Watch mode
yarn dev
```

### Version Management

BlendSDK uses lockstep versioning - all packages are versioned together:

```bash
# Auto-detect version bump from conventional commits
yarn lockstep:version:auto --ci

# Explicit version bumps
yarn lockstep:version:patch --ci
yarn lockstep:version:minor --ci
yarn lockstep:version:major --ci

# Publish to npm
yarn lockstep:publish:latest
yarn lockstep:publish:next
```

---

## Architecture

### Monorepo Structure

```
packages/
├── stdlib/         # Foundation (no dependencies)
├── expression/     # SQL expression builder (depends on stdlib)
├── dbcore/         # Database abstraction (depends on expression)
├── postgresql/     # PostgreSQL client (depends on dbcore)
├── cmdline/        # CLI parser (depends on stdlib)
├── codegen/        # Code generators (depends on dbcore, postgresql)
└── webafx/         # Web framework (depends on stdlib)
```

### Dependency Graph

```
stdlib ──→ cmdline
expression ──→ dbcore ──→ postgresql ──→ codegen
webafx (standalone, depends on express)
```

### Key Technologies

- **TypeScript 5.9** - Strict mode, ESM modules
- **Vitest** - Fast, modern test framework
- **Turbo** - High-performance build system
- **Express 5** - Web server (webafx)
- **pg** - PostgreSQL driver (postgresql)
- **Zod** - Schema validation (codegen)

---

## Testing

### Running Tests

```bash
# All packages
yarn test

# With coverage
yarn test --coverage

# Watch mode
yarn test:watch

# Specific package
cd packages/webafx && yarn test
```

### Integration Tests

Some packages (postgresql, codegen) use Docker Compose for integration testing:

```bash
# Start test database
cd packages/postgresql
yarn db:up

# Run tests
yarn test

# Stop test database
yarn db:down
```

---

## Documentation

- **[Package Documentation](packages/)** - Individual package READMEs
- **[API Reference](packages/*/src/)** - JSDoc comments in source code
- **[Implementation Plans](implementation/)** - Architecture documents
- **[AI Agent Instructions](.github/copilot-instructions.md)** - Development guidelines

---

## Contributing

We welcome contributions! Please follow these guidelines:

1. **Follow existing patterns** - Review code in similar packages
2. **Write tests** - All new features must have test coverage
3. **Use conventional commits** - For automatic versioning
4. **Update documentation** - Keep READMEs and JSDoc current
5. **Run tests before committing** - Ensure all tests pass

### Conventional Commits

```
feat: add new feature (minor version bump)
fix: bug fix (patch version bump)
docs: documentation only
refactor: code change without feature/fix
test: adding/updating tests
chore: maintenance tasks

BREAKING CHANGE: triggers major version bump
```

---

## License

MIT © [True Software](https://github.com/TrueSoftwareNL)

---

## Support

- **Issues**: [GitHub Issues](https://github.com/TrueSoftwareNL/blendsdk/issues)
- **Discussions**: [GitHub Discussions](https://github.com/TrueSoftwareNL/blendsdk/discussions)

---

## Versioning

BlendSDK follows [Semantic Versioning](https://semver.org/):

- **Major** (x.0.0): Breaking changes
- **Minor** (0.x.0): New features (backward compatible)
- **Patch** (0.0.x): Bug fixes (backward compatible)

Current version: **5.32.0** (lockstep across all packages)

---

**Built with ❤️ by [TrueSoftware](https://github.com/TrueSoftwareNL)**
