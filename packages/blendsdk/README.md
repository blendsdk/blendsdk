# blendsdk

[![npm version](https://img.shields.io/npm/v/blendsdk.svg)](https://www.npmjs.com/package/blendsdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 22.0.0](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)

Enterprise-grade TypeScript SDK for web applications, database operations, caching, pub/sub, email, i18n, and code generation.

## Installation

```bash
npm install blendsdk
```

## Available Modules

| Module | Import | Description | Peer Deps Required |
| --- | --- | --- | --- |
| stdlib | `blendsdk/stdlib` | Type guards, utilities, helpers | — |
| cmdline | `blendsdk/cmdline` | CLI argument parser | — |
| blendscript | `blendsdk/blendscript` | Safe business-rule expression evaluator | — |
| expression | `blendsdk/expression` | Immutable SQL WHERE clause builder | — |
| dbcore | `blendsdk/dbcore` | Database abstractions, CRUD statement builders | — |
| postgresql | `blendsdk/postgresql` | PostgreSQL client + connection pooling | `pg`, `yesql` |
| webafx | `blendsdk/webafx` | Express 5 web framework with DI, plugins, routing | `express`, `cors`, `helmet`, `cookie-parser` |
| webafx-cache | `blendsdk/webafx-cache` | Caching + pub/sub (Redis and in-memory backends) | `ioredis` |
| webafx-mailer | `blendsdk/webafx-mailer` | Email sending (SMTP and in-memory backends) | `nodemailer` |
| webafx-mailer-azure | `blendsdk/webafx-mailer-azure` | Microsoft Graph email sending | `@azure/msal-node` |
| webafx-auth | `blendsdk/webafx-auth` | Token validation plugin (JWT/OIDC) | `jose` |
| i18n | `blendsdk/i18n` | Internationalization core (Translator, catalogs) | — |
| i18n-node | `blendsdk/i18n-node` | i18n Node.js sources (JSON files, content files) | — |
| webafx-i18n | `blendsdk/webafx-i18n` | i18n webafx plugin (locale resolution) | — |
| codegen | `blendsdk/codegen` | Code generators (TypeScript, Zod, OpenAPI, SQL) | `pg`, `postgres-array` |

## Quick Start

### Web API with Express 5

```typescript
import { WebApplication, BaseController, RouteDefinition } from "blendsdk/webafx";

// Define a controller with routes
class HelloController extends BaseController {
  routes(): RouteDefinition[] {
    return [
      this.route()
        .get("/hello")
        .handle(async (_req, res) => {
          this.ok(res, { message: "Hello from BlendSDK!" });
        }),
    ];
  }
}

// Create the application and register the controller
const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: "development",
});

app.registerController("/api", HelloController);

const shutdown = await app.start();
// Server running → GET /api/hello returns { success: true, data: { message: "Hello from BlendSDK!" } }
```

### SQL Expression Building

```typescript
import { query } from "blendsdk/expression";

// Build a type-safe WHERE clause
const filter = query()
  .where("status").equals("active")
  .and("age").greaterThanOrEqual(18);

// Compile to parameterized SQL
const { sql, params } = filter.compile();
// sql: "status = :p1 AND age >= :p2"
// params: { p1: "active", p2: 18 }

// Nested conditions with grouping
const advanced = query()
  .where("status").equals("active")
  .and(q => q
    .where("age").greaterThan(21)
    .or("verified").equals(true)
  )
  .compile();
// sql: "status = :p1 AND (age > :p2 OR verified = :p3)"
// params: { p1: "active", p2: 21, p3: true }
```

### Business Rule Expressions

```typescript
import { compileExpression, evaluateExpression } from "blendsdk/blendscript";

const compiled = compileExpression(
  'Country == "NL" AND isBlank(CustomerName) == FALSE',
  {
    schema: {
      Country: { type: "string" },
      CustomerName: { type: "string" },
    },
    expectedResult: "boolean",
  },
);

if (compiled.ok) {
  const result = evaluateExpression(compiled.expression, {
    Country: "NL",
    CustomerName: "Ada",
  });
}
```

See the [BlendScript guide](https://github.com/TrueSoftwareNL/blendsdk/tree/v5/packages/blendscript)
for syntax, built-ins, diagnostics, and limits.
The [BlendScript course](https://github.com/TrueSoftwareNL/blendsdk/blob/v5/packages/blendsdk-docs/docs/guides/blendscript-v1.md)
teaches formula authoring and external application integration step by step.

### CLI Argument Parser

```typescript
import { CommandLineParser } from "blendsdk/cmdline";

const cli = new CommandLineParser({ name: "my-cli", version: "1.0.0" });

cli.addCommand({
  name: "deploy",
  description: "Deploy the application",
  options: [
    {
      name: "environment",
      short: "e",
      type: "string",
      required: true,
      choices: ["dev", "staging", "production"],
    },
    {
      name: "verbose",
      short: "v",
      type: "boolean",
      description: "Verbose output",
    },
  ],
  handler: async (params) => {
    console.log(`Deploying to ${params.environment}...`);
  },
});

await cli.execute();
// Usage: my-cli deploy --environment=staging --verbose
```

### Database CRUD Operations

```typescript
import { Database } from "blendsdk/dbcore";

// Insert with returning clause
const user = await db
  .insert<{ name: string; email: string }>("users")
  .values({ name: "Alice", email: "alice@example.com" })
  .returning("*")
  .execute();

// Update with filter
await db
  .update<{ name: string }, { id: number }>("users")
  .values({ name: "Bob" })
  .filter({ id: 1 })
  .returning("*")
  .execute();

// Delete with expression filter
await db
  .delete<{ status: string }>("users")
  .filterByExpression(q => q.where("status").equals("inactive"))
  .execute();
```

### Caching

```typescript
import { MemoryCacheProvider } from "blendsdk/webafx-cache";

const cache = new MemoryCacheProvider({
  rootKey: "MyApp",
  defaultTTL: 300, // 5 minutes
});

// Simple set/get with type safety
await cache.set("user:1", { name: "Alice", role: "admin" });
const user = await cache.get<{ name: string; role: string }>("user:1");

// Cache-aside pattern (getOrSet)
const product = await cache.getOrSet(
  "product:42",
  async () => {
    return await fetchProductFromDatabase(42);
  },
  60, // TTL in seconds
);

// Pattern-based deletion
await cache.deletePattern("user:*"); // Remove all user cache entries
```

### Pub/Sub Messaging

```typescript
import { MemoryPubSubProvider } from "blendsdk/webafx-cache";

const pubsub = new MemoryPubSubProvider();

// Subscribe to a specific channel with typed messages
await pubsub.subscribe<{ id: number; total: number }>("order:new", (msg) => {
  console.log(`New order on ${msg.channel}:`, msg.data);
});

// Pattern subscription (wildcard matching)
await pubsub.psubscribe("order:*", (msg) => {
  console.log(`Order event [${msg.pattern}] on ${msg.channel}`);
});

// Publish returns the number of receivers
const receiverCount = await pubsub.publish("order:new", { id: 1, total: 99.99 });
```

### Internationalization

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
  defaultLocale: "en",
  catalog: {
    greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
    book: {
      en: ["${count} book", "${count} books"],
      nl: ["${count} boek", "${count} boeken"],
    },
  },
});

translator.translate("greeting", "en", { name: "Alice" }); // "Hello Alice"
translator.translate("greeting", "nl", { name: "Alice" }); // "Hallo Alice"
translator.translate("book", "en", { count: 1 });           // "1 book"
translator.translate("book", "en", { count: 5 });           // "5 books"
translator.translate("farewell", "en_GB");                   // "Goodbye" (falls back to "en")
```

### Utilities

```typescript
import { isNullOrUndef, isString } from "blendsdk/stdlib";

const value: unknown = getUserInput();

if (!isNullOrUndef(value) && isString(value)) {
  console.log("Got a string:", value);
}
```

## Peer Dependencies

Install only the peer dependencies for the modules you use:

```bash
# Web framework (webafx)
npm install express cors helmet cookie-parser

# PostgreSQL database (postgresql, codegen)
npm install pg yesql

# Redis caching + pub/sub (webafx-cache)
npm install ioredis

# Email sending (webafx-mailer)
npm install nodemailer

# Microsoft Graph email (webafx-mailer-azure)
npm install @azure/msal-node

# Authentication — JWT/OIDC (webafx-auth)
npm install jose

# Code generation (codegen)
npm install pg postgres-array
```

## Requirements

- **Node.js** >= 22.0.0
- **TypeScript** >= 5.6.0 (peer dependency)
- **ESM only** — this package uses `"type": "module"`

## Links

- [GitHub Repository](https://github.com/blendsdk/blendsdk)
- [Contributing Guide](https://github.com/blendsdk/blendsdk/blob/main/CONTRIBUTING.md)
- [License (MIT)](https://github.com/blendsdk/blendsdk/blob/main/LICENSE)

## Author

[TrueSoftware B.V.](https://truesoftware.nl)
