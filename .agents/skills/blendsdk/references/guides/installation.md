# Installation

> **Module**: Getting Started
> **Audience**: Developers new to BlendSDK

## Overview

BlendSDK is distributed as a single npm package (`blendsdk`) with subpath exports. You install one package and import only the modules you need. Each subpath maps to an internal package (e.g., `blendsdk/webafx`, `blendsdk/postgresql`).

## Requirements

| Requirement | Version |
|-------------|---------|
| Node.js | >= 22.0.0 |
| TypeScript | >= 5.6.0 |
| Package manager | npm, yarn, or pnpm |

## Install BlendSDK

```bash
# npm
npm install blendsdk

# yarn
yarn add blendsdk

# pnpm
pnpm add blendsdk
```

This gives you access to all 12 subpath modules via a single dependency.

## Install Peer Dependencies

BlendSDK uses **optional peer dependencies** — you only install the ones needed by the subpaths you use. The table below shows which peer dependencies each subpath requires:

| Subpath | Peer Dependencies | Install Command |
|---------|-------------------|-----------------|
| `blendsdk/stdlib` | *(none)* | — |
| `blendsdk/cmdline` | *(none)* | — |
| `blendsdk/expression` | *(none)* | — |
| `blendsdk/dbcore` | *(none)* | — |
| `blendsdk/postgresql` | `pg`, `yesql` | `npm install pg yesql` |
| `blendsdk/webafx` | `express`, `cookie-parser`, `cors`, `helmet` | `npm install express cookie-parser cors helmet` |
| `blendsdk/webafx-cache` | `ioredis` | `npm install ioredis` |
| `blendsdk/webafx-mailer` | `nodemailer` | `npm install nodemailer` |
| `blendsdk/webafx-auth` | `jose` | `npm install jose` |
| `blendsdk/i18n` | *(none)* | — |
| `blendsdk/webafx-i18n` | *(peer: webafx, optional: postgresql)* | see webafx + postgresql rows |
| `blendsdk/codegen` | *(peer: postgresql, webafx)* | see postgresql + webafx rows |

### Example: Web API with PostgreSQL

If you're building a web API with a PostgreSQL database:

```bash
# Core SDK
npm install blendsdk

# Peer deps for webafx + postgresql
npm install express cookie-parser cors helmet pg yesql

# TypeScript types (dev deps)
npm install -D typescript @types/express @types/cookie-parser @types/cors @types/pg @types/node
```

### Example: Web API with Caching and Email

```bash
# Core SDK
npm install blendsdk

# Peer deps for webafx + cache + mailer
npm install express cookie-parser cors helmet ioredis nodemailer

# TypeScript types (dev deps)
npm install -D typescript @types/express @types/cookie-parser @types/cors @types/nodemailer @types/node
```

## TypeScript Configuration

BlendSDK requires strict TypeScript with ESM module resolution. Create a `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

**Key settings explained:**

- **`module: "Node16"`** — Required for subpath imports (`blendsdk/webafx`) to resolve correctly
- **`moduleResolution: "Node16"`** — Matches the module setting; resolves `exports` map in `package.json`
- **`strict: true`** — BlendSDK is written in strict TypeScript; your project should match
- **`target: "ES2022"`** — Supports modern syntax used by BlendSDK (top-level await, etc.)

## Package.json Configuration

Your project must use ESM modules:

```json
{
  "type": "module",
  "engines": {
    "node": ">=22.0.0"
  }
}
```

The `"type": "module"` field is **required** — BlendSDK only ships ESM builds (no CommonJS).

## Verify Installation

Create a quick test file to verify everything works:

```typescript
// src/verify.ts
import { isString } from 'blendsdk/stdlib';

console.log('BlendSDK installed correctly!');
console.log('isString("hello"):', isString('hello')); // true
console.log('isString(42):', isString(42));            // false
```

Run it:

```bash
npx tsx src/verify.ts
```

Expected output:

```
BlendSDK installed correctly!
isString("hello"): true
isString(42): false
```

## Subpath Import Pattern

BlendSDK uses the **subpath exports** pattern. You never import from the package root — always from a specific subpath:

```typescript
// ✅ Correct — import from subpath
import { WebApplication } from 'blendsdk/webafx';
import { query } from 'blendsdk/expression';
import { PostgreSQLDatabase } from 'blendsdk/postgresql';

// ❌ Wrong — no root export exists
import { WebApplication } from 'blendsdk';
```

This ensures your bundle only includes the code you actually use.

## See Also

- [Project Scaffolding](project-scaffolding.md) — Create a full project from scratch
- [Docker Setup](docker-setup.md) — Set up databases and services for development
- Imports Cheatsheet — All available subpath imports
