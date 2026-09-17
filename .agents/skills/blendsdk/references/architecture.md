# Architecture

> BlendSDK project structure, design patterns, and architectural decisions.

## Topics

| # | Topic | Description |
|---|-------|-------------|
| 02 | [Project Structure](#project-structure) | Monorepo layout, package dependencies, directory conventions |
| 03 | [Design Patterns](#design-patterns) | Builder, Repository, Plugin, DI, Strategy patterns used across packages |

## Overview

BlendSDK v5 is a **lockstep-versioned monorepo** of TypeScript libraries for building enterprise web applications. All packages share a single version number and are published as a unified `blendsdk` npm package with subpath exports (`blendsdk/webafx`, `blendsdk/postgresql`, etc.).

### Core Principles

- **TypeScript-first** — strict mode, extensive generics, ESM-only
- **Zero unnecessary dependencies** — prefer building over importing
- **Fluent APIs** — builder pattern with method chaining throughout
- **Plugin architecture** — WebAFX plugins for extensibility
- **Strategy pattern** — swappable backends (Redis/Memory cache, SMTP/Memory mail)
- **Immutable data structures** — Expression builder uses immutable AST nodes

---

# Project Structure

> Monorepo layout, package dependencies, directory conventions, and import paths.

---

## Monorepo Overview

BlendSDK v5 is a **lockstep-versioned monorepo** managed by Yarn workspaces and Turbo. All packages share a single version number and are published as a unified `blendsdk` npm package with subpath exports.

```
blendsdk-v5/
├── packages/           # All library packages
├── plans/              # Implementation plan documents
├── reports/            # Analysis and audit reports
├── scripts/            # Build tooling, changelog, version management
├── package.json        # Root workspace config
├── turbo.json          # Build orchestration
├── vitest.config.ts    # Shared test config
└── yarn.lock           # Dependency lockfile
```

---

## Package Map

| Package | Import Path | Description | Dependencies |
|---------|-------------|-------------|-------------|
| **stdlib** | `blendsdk/stdlib` | Type guards, utilities (zero deps) | — |
| **cmdline** | `blendsdk/cmdline` | CLI argument parser | stdlib |
| **expression** | `blendsdk/expression` | Immutable SQL WHERE clause builder | — |
| **dbcore** | `blendsdk/dbcore` | Database abstraction, CRUD statement builders | expression |
| **postgresql** | `blendsdk/postgresql` | PostgreSQL client + connection pooling | dbcore |
| **i18n** | `blendsdk/i18n` | Internationalization core — Translator, catalogs, sources | stdlib |
| **webafx** | `blendsdk/webafx` | Express 5 web framework with DI, plugins, routing | — |
| **webafx-auth** | `blendsdk/webafx-auth` | Authentication plugin for WebAFX | webafx (peer) |
| **webafx-cache** | `blendsdk/webafx-cache` | Caching + pub/sub — Redis and In-Memory backends | webafx (peer) |
| **webafx-mailer** | `blendsdk/webafx-mailer` | Email sending — SMTP and In-Memory backends | webafx (peer) |
| **webafx-i18n** | `blendsdk/webafx-i18n` | i18n WebAFX plugin — locale resolution, PostgreSQL source | i18n, webafx (peer) |
| **codegen** | `blendsdk/codegen` | Code generators: TypeScript, Zod, OpenAPI, SQL | dbcore, postgresql, webafx |

---

## Dependency Graph

```
stdlib ──→ cmdline
stdlib ──→ i18n ──→ webafx-i18n (peer: webafx)

expression ──→ dbcore ──→ postgresql ──→ codegen

webafx (standalone, Express 5) ──────────→ codegen
webafx ←── (peer dep) ── webafx-auth
webafx ←── (peer dep) ── webafx-cache
webafx ←── (peer dep) ── webafx-mailer
webafx ←── (peer dep) ── webafx-i18n
```

### Layer Architecture

```
┌─────────────────────────────────────────────┐
│           Application Layer                  │
│   codegen · playground                       │
├─────────────────────────────────────────────┤
│          Framework Layer                     │
│   webafx · webafx-auth · webafx-cache        │
│   webafx-mailer · webafx-i18n                │
├─────────────────────────────────────────────┤
│          Data Access Layer                   │
│   postgresql · dbcore · expression           │
├─────────────────────────────────────────────┤
│          Foundation Layer                    │
│   stdlib · cmdline · i18n                    │
└─────────────────────────────────────────────┘
```

---

## Import Convention

All packages are consumed via the `blendsdk` npm package with subpath exports:

```typescript
// Foundation
import { isNullOrUndef, wrapInArray } from 'blendsdk/stdlib';

// Data access
import { query } from 'blendsdk/expression';
import { Database } from 'blendsdk/dbcore';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

// Web framework
import { WebApplication, BaseController } from 'blendsdk/webafx';
import { redisCachePlugin, CacheProvider } from 'blendsdk/webafx-cache';
import { smtpMailPlugin, MailProvider } from 'blendsdk/webafx-mailer';

// Internationalization
import { Translator, mergeCatalogs } from 'blendsdk/i18n';
import { JsonFileSource, ContentFileSource } from 'blendsdk/i18n-node';
import { createI18nPlugin } from 'blendsdk/webafx-i18n';

// Code generation
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
```

---

## Standard Package Layout

Each package follows a consistent directory structure:

```
packages/<name>/
├── src/
│   ├── index.ts        # Public API — re-exports all public symbols
│   └── *.ts            # Implementation files (kebab-case)
├── tests/
│   ├── *.test.ts       # Unit tests
│   └── docker/         # Integration test support (if applicable)
├── package.json        # Package manifest
├── tsconfig.json       # TypeScript config (extends root)
├── CHANGELOG.md        # Auto-generated changelog
├── README.md           # Package documentation
├── .npmignore          # Publish exclusions
└── docker/             # Docker Compose for integration tests (if applicable)
    └── docker-compose.yml
```

### File Naming

- **Source files:** kebab-case (`crud-statement.ts`, `service-container.ts`)
- **Test files:** `<name>.test.ts` matching source file names
- **Index files:** `index.ts` — re-export public API only

---

## Docker Integration

Several packages require Docker for integration tests:

| Package | Service | Port | Purpose |
|---------|---------|------|---------|
| postgresql | PostgreSQL 16 | 5499 | Database integration tests |
| webafx-cache | Redis 7 | 6399 | Cache + pub/sub integration tests |
| webafx-mailer | Mailpit | 1025/8025 | SMTP + API email testing |
| codegen | PostgreSQL 16 | 5498 | Schema introspection tests |
| webafx | PostgreSQL 16 | 5497 | Full framework integration tests |

### Running Tests

```bash
# Unit tests only (no Docker)
clear && cd packages/<name> && yarn test:fast

# Full tests (Docker required)
clear && yarn test

# Start Docker services for a specific package
cd packages/<name>/docker && docker compose up -d
```

---

## Build System

### Turbo (Build Orchestration)

Turbo handles task parallelization and caching across all packages:

```bash
clear && yarn build    # Build all packages (respects dependency graph)
clear && yarn test     # Run all tests
clear && yarn clean    # Remove all build artifacts
```

### TypeScript Configuration

All packages share base compiler options:
- **Module:** `NodeNext` (ESM-first)
- **Target:** `ES2022`
- **Strict mode:** enabled
- **Declaration files:** generated for every package

### Version Management

All packages use **lockstep versioning** — the same version number across all packages. Version bumps are managed by the lockstep script:

```bash
clear && yarn lockstep:version:patch   # x.y.z → x.y.(z+1)
clear && yarn lockstep:version:minor   # x.y.z → x.(y+1).0
clear && yarn lockstep:version:major   # x.y.z → (x+1).0.0
```

---

## Key Conventions

1. **ESM only** — all packages use `"type": "module"` with `.js` extensions in imports
2. **Zero unnecessary dependencies** — prefer building over importing third-party
3. **Peer dependencies for webafx plugins** — `webafx-cache`, `webafx-mailer`, `webafx-i18n`, `webafx-auth` declare `webafx` as a peer dependency
4. **Public API via `index.ts`** — only symbols re-exported from `src/index.ts` are public
5. **JSDoc on public APIs** — all exported classes, functions, and types must have JSDoc comments
6. **Fluent API pattern** — builder methods return `this` for chaining
7. **Playground is private** — `packages/playground` is for development only, never published

---

# Design Patterns

> Core design patterns used across BlendSDK packages.

---

## Builder Pattern

**Used in:** `expression`, `dbcore`, `postgresql`, `webafx`

The Builder pattern creates complex objects through a fluent, chainable API. Methods return `this` to enable method chaining.

### Expression Builder

```typescript
import { query } from 'blendsdk/expression';

const filter = query<User>()
  .where('status').equals('active')
  .and('age').greaterThan(18)
  .and(q => q
    .where('role').equals('admin')
    .or('verified').equals(true)
  )
  .compile();
// SQL: status = $1 AND age > $2 AND (role = $3 OR verified = $4)
```

### RouteBuilder

```typescript
import { BaseController } from 'blendsdk/webafx';

class MyController extends BaseController {
  routes() {
    return [
      this.route()
        .post('/items')
        .secure()
        .authorize(async (req, user) => user?.role === 'admin')
        .validate(createItemSchema)
        .middleware(rateLimitMiddleware({ maxRequests: 10 }))
        .handle(this.create),
    ];
  }
}
```

### Statement Builders (dbcore)

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const result = await db
  .from('users')
  .selectAll()
  .where(query().where('active').equals(true))
  .limit(20)
  .offset(0)
  .execute();
```

**Key principle:** Every builder method returns `this`, and the chain is finalized by a terminal method (`.compile()`, `.handle()`, `.execute()`).

---

## Strategy Pattern

**Used in:** `webafx-cache`, `webafx-mailer`

The Strategy pattern defines a family of algorithms (backends), encapsulates each one, and makes them interchangeable. Application code depends on the abstract interface, not a specific implementation.

### Cache Provider Strategy

```typescript
import { CacheProvider, MemoryCacheProvider, RedisCacheProvider, createCache } from 'blendsdk/webafx-cache';

// Abstract interface — used by controllers
const cache: CacheProvider = createCache({
  type: process.env.NODE_ENV === 'production' ? 'redis' : 'memory',
  rootKey: 'MyApp',
  host: process.env.REDIS_HOST,
});

// Both implementations share the same API
await cache.set('key', value, 300);
const result = await cache.get<T>('key');
await cache.getOrSet('key', factory, 300);
```

### Mail Provider Strategy

```typescript
import { createMailProvider } from 'blendsdk/webafx-mailer';

// SMTP in production, In-Memory for testing
const mailer = createMailProvider({
  type: process.env.NODE_ENV === 'production' ? 'smtp' : 'memory',
  host: process.env.SMTP_HOST,
});

// Same API regardless of backend
await mailer.send({
  from: 'no-reply@example.com',
  to: 'user@example.com',
  subject: 'Hello',
  html: '<p>Hi</p>',
});
```

**Key principle:** Consumers depend on the abstract base class (`CacheProvider`, `MailProvider`). The concrete implementation is chosen at configuration time, not in business logic.

---

## Plugin System

**Used in:** `webafx`

Plugins are reusable extensions that add cross-cutting concerns (auth, caching, metrics) to WebAFX applications. They follow a defined lifecycle with priority ordering.

```typescript
import type { PluginDefinition } from 'blendsdk/webafx';

const myPlugin: PluginDefinition = {
  name: 'my-plugin',
  priority: 30,  // Lower = installs first

  factory: async ({ app, express, logger }) => {
    // Register services
    app.registerService({ name: 'myService', type: 'singleton', factory: () => new MyService() });

    // Add middleware
    express.use(myMiddleware);

    return {
      health: async () => true,           // Powers /health endpoint
      shutdown: async () => cleanup(),     // Called on graceful shutdown
    };
  },
};

app.use(myPlugin);
```

### Plugin Priority Ordering

| Priority | Purpose |
|----------|---------|
| 1–20 | Authentication, security |
| 21–50 | Caching, session management |
| 51–80 | Metrics, monitoring |
| 81–100+ | General features (default: 100) |

**Key principle:** Plugins encapsulate complex features as composable, reusable units with health checks and shutdown hooks.

---

## Dependency Injection

**Used in:** `webafx`

WebAFX's ServiceContainer manages service lifecycle with two scopes: **singleton** (application-wide) and **per-request** (fresh for each HTTP request).

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { ServiceDefinition } from 'blendsdk/webafx';

// Singleton — created once, shared across all requests
const dbService: ServiceDefinition = {
  name: 'db',
  type: 'singleton',
  factory: async (container, settings) => {
    const db = new PostgreSQLDatabase({ host: settings.get('DB_HOST') });
    await db.connect();
    return db;
  },
  dispose: async (db) => await db.close(),
};

// Per-request — created fresh for each HTTP request
const userService: ServiceDefinition = {
  name: 'user',
  type: 'per-request',
  factory: async (container, settings, req) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    return verifyToken(token, settings.get('JWT_SECRET'));
  },
};

// Dependencies resolved automatically
const repoService: ServiceDefinition = {
  name: 'userRepo',
  type: 'singleton',
  dependencies: ['db'],
  factory: async (container) => {
    const db = await container.get<Database>('db');
    return new UserRepository(db);
  },
};
```

**Key principle:** No global state. Each `WebApplication` owns its own service registry, ensuring complete isolation for testing.

---

## Repository Pattern

**Used in:** `dbcore`

`QueryDataService<T>` provides a typed interface for database operations against a specific table, abstracting away raw SQL.

```typescript
import { QueryDataService } from 'blendsdk/dbcore';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';
import { query } from 'blendsdk/expression';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

class UserRepository extends QueryDataService<User> {
  constructor(db: PostgreSQLDatabase) {
    super(db, 'users');
  }

  async findActive(): Promise<User[]> {
    return this.find(query<User>().where('active').equals(true));
  }

  async findByEmail(email: string): Promise<User | undefined> {
    return this.findOne(query<User>().where('email').equals(email));
  }
}
```

**Key principle:** Business logic works with typed repository methods, not raw SQL. The query builder ensures type safety and SQL injection prevention.

---

## Immutable AST

**Used in:** `expression`

The Expression builder constructs an immutable Abstract Syntax Tree (AST) of query conditions. Each operation creates a new AST node rather than mutating existing state.

```typescript
import { query } from 'blendsdk/expression';

// Each method call creates a new AST node
const base = query<User>().where('active').equals(true);
const withAge = base.and('age').greaterThan(18);      // base is unchanged
const withRole = base.and('role').equals('admin');     // base is unchanged

// Safe to share and compose queries
const result1 = withAge.compile();  // active = $1 AND age > $2
const result2 = withRole.compile(); // active = $1 AND role = $2
```

**Benefits:**
- **Thread-safe** — no shared mutable state
- **Composable** — build complex queries from simple parts
- **Debuggable** — AST can be inspected before compilation
- **Parameterized** — automatic SQL parameter management prevents injection

---

## Template Method

**Used in:** `dbcore`

The `Statement` base class defines the skeleton of query building (`buildQuery()` / `buildParameters()`), letting subclasses override specific steps.

```
Statement (abstract)
├── buildQuery()       — Template method: assemble SQL string
├── buildParameters()  — Template method: collect parameter values
└── execute()          — Final: calls buildQuery + buildParameters + run
    │
    ├── FromStatement (SELECT)
    │   ├── selectAll(), columns(), where(), limit(), offset()
    │   └── buildQuery() → "SELECT ... FROM ... WHERE ... LIMIT ..."
    │
    ├── InsertStatement
    │   ├── values(), returning()
    │   └── buildQuery() → "INSERT INTO ... VALUES (...) RETURNING ..."
    │
    ├── UpdateStatement
    │   ├── set(), where(), returning()
    │   └── buildQuery() → "UPDATE ... SET ... WHERE ... RETURNING ..."
    │
    └── DeleteStatement
        ├── where()
        └── buildQuery() → "DELETE FROM ... WHERE ..."
```

**Key principle:** The base class controls the execution flow. Subclasses implement the specifics for each SQL operation type.

---

## Abstract Factory

**Used in:** `dbcore`, `postgresql`

The `Database` class provides factory methods for creating statement objects, abstracting the creation of SQL statements:

```typescript
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

const db = new PostgreSQLDatabase(config);

// Factory methods create the appropriate statement type
const select = db.from('users');           // → FromStatement
const insert = db.insert('users');         // → InsertStatement
const update = db.update('users');         // → UpdateStatement
const del    = db.delete('users');         // → DeleteStatement

// Each statement knows how to build and execute its SQL
const users = await select.selectAll().where(filter).execute();
```

**Key principle:** Client code never instantiates statement classes directly. The `Database` factory ensures each statement is configured with the correct database connection and dialect.

---

## Pub/Sub Messaging

**Used in:** `webafx-cache`

Typed publish/subscribe messaging with channel prefixes and pattern matching:

```typescript
import { RedisPubSubProvider } from 'blendsdk/webafx-cache';

const pubsub = new RedisPubSubProvider({ host: 'localhost', channelPrefix: 'MyApp' });

// Typed subscribe
interface OrderEvent { id: number; total: number; }
await pubsub.subscribe<OrderEvent>('order:created', async (msg) => {
  console.log(msg.data.id, msg.data.total);
});

// Pattern subscribe (glob wildcards)
await pubsub.psubscribe('audit:*', async (msg) => {
  console.log(`Event on ${msg.channel}, pattern: ${msg.pattern}`);
});

// Publish (returns receiver count)
await pubsub.publish('order:created', { id: 1, total: 99.99 });
```

**Key principle:** Handler errors are isolated — one failing handler doesn't affect others. Channel prefixes provide namespace isolation across applications.

---

## Locale Fallback Chain

**Used in:** `i18n`, `webafx-i18n`

The Translator resolves translations through a fallback chain: exact locale → language-only → default locale.

```typescript
import { Translator } from 'blendsdk/i18n';

const translator = new Translator({
  defaultLocale: 'en',
  catalog: {
    greeting: { en: 'Hello', en_GB: 'Hullo', nl: 'Hallo' },
    farewell: { en: 'Goodbye', nl: 'Tot ziens' },
  },
});

translator.translate('greeting', 'en_GB');  // "Hullo" (exact match)
translator.translate('farewell', 'en_GB');  // "Goodbye" (falls back to "en")
translator.translate('greeting', 'fr');     // "Hello" (falls back to default "en")
```

**Key principle:** Translations degrade gracefully. Users always see something meaningful, even when a specific locale isn't fully translated.

---

## Catalog Merging

**Used in:** `i18n`

Multiple translation sources (JSON files, content files, database) are merged in order — last source wins per key+locale:

```typescript
import { mergeCatalogs, JsonFileSource, ContentFileSource } from 'blendsdk/i18n-node';

const jsonCatalog = await new JsonFileSource({ paths: ['./translations/*.json'] }).load();
const contentCatalog = await new ContentFileSource({ paths: ['./content/emails'] }).load();

// Content catalog overrides JSON for overlapping keys
const catalog = mergeCatalogs([jsonCatalog, contentCatalog]);
```

**Key principle:** Translation sources are composable. Each source implements `TranslationSource`, and `mergeCatalogs` combines them with a predictable override strategy.

---

## Dependency Graph

---



---

The package dependency graph is regenerated from package metadata. See [dependency-graph.md](dependency-graph.md).
