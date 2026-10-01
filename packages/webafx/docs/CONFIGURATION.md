# Configuration Reference

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

WebAFX uses a layered configuration system with Zod validation. Configuration can be provided via the constructor, `.env.js` files, or `.env.local.js` files (for local overrides).

## Configuration Loading Order

Configuration is merged in this order (later values override earlier):

```
1. Defaults (ENV_MODE: 'production')
2. Constructor config: new WebApplication({ PORT: 3000 })
3. .env.js (project-level config, committed to git)
4. .env.local.js (local overrides, gitignored)
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `PORT` | `number` | `4000` | Server port (0-65535). Use `0` for random port in tests. |
| `ENV_MODE` | `'production' \| 'development' \| 'test'` | `'production'` | Environment mode. Controls error detail, logging, and shutdown timing. |
| `LOG_LEVEL` | `'ERROR' \| 'WARN' \| 'INFO' \| 'DEBUG'` | `'ERROR'` | Logging verbosity. Auto-set to `'DEBUG'` in non-production if not specified. |
| `DEBUG` | `boolean` | `undefined` | If `true`, forces `LOG_LEVEL` to `'DEBUG'`. |
| `TRUST_PROXY` | `boolean` | `true` | Trust `X-Forwarded-*` headers (required behind nginx/load balancers). |
| `BODY_LIMIT` | `string` | `'10mb'` | Maximum request body size (Express format: `'1mb'`, `'500kb'`). |
| `SHUTDOWN_TIMEOUT` | `number` | `7` | Graceful shutdown timeout in seconds (0-300). In dev, always 1 second. |
| `CORS` | `boolean \| CorsConfig` | `undefined` | CORS configuration. `true` for permissive defaults, object for custom config. |

### Custom Properties

The configuration schema uses `.passthrough()`, so you can add any custom properties:

```typescript
const app = new WebApplication({
  PORT: 3000,
  ENV_MODE: 'development',
  // Custom properties — accessible via settings.get()
  DATABASE_URL: 'postgresql://localhost:5432/mydb',
  JWT_SECRET: 'my-secret-key',
  FEATURE_FLAGS: { enableCache: true },
});
```

## Configuration Files

### .env.js (Project Configuration)

Create `.env.js` in your project root (committed to git):

```javascript
// .env.js
export default {
  PORT: 4000,
  ENV_MODE: 'production',
  LOG_LEVEL: 'WARN',
  TRUST_PROXY: true,
  BODY_LIMIT: '10mb',
  SHUTDOWN_TIMEOUT: 10,
  CORS: {
    origin: ['https://app.example.com'],
    credentials: true,
  },
  // Custom properties
  DATABASE_URL: process.env.DATABASE_URL,
};
```

### .env.local.js (Local Overrides)

Create `.env.local.js` for local development (add to `.gitignore`):

```javascript
// .env.local.js
export default {
  PORT: 3000,
  ENV_MODE: 'development',
  LOG_LEVEL: 'DEBUG',
  CORS: true, // Allow all origins in development
  DATABASE_URL: 'postgresql://localhost:5432/mydb_dev',
};
```

## Accessing Configuration

### In Application Setup

```typescript
const app = new WebApplication(config);

// Get all settings
const settings = app.getSettings();
console.log(settings.PORT); // 3000

// Get with type parameter for custom settings
interface MySettings extends ApplicationConfig {
  DATABASE_URL: string;
  JWT_SECRET: string;
}
const mySettings = app.getSettings<MySettings>();
```

### In Controllers

```typescript
class MyController extends BaseController {
  routes() {
    // this.settings is available via BaseController
    const dbUrl = this.settings.get<string>('DATABASE_URL');
    const isProduction = this.settings.isProduction();
    return [];
  }
}
```

### ApplicationSettings API

```typescript
class ApplicationSettings {
  // Get a single value with optional default
  get<T>(key: string, defaultValue?: T): T;

  // Get all settings as a shallow copy
  getAll<T extends ApplicationConfig>(): T;

  // Check if running in production
  isProduction(): boolean;

  // Load from a JavaScript file
  loadFromFile(jsPath: string): Promise<void>;
}
```

## Configuration Validation

Configuration is validated using Zod on construction and after loading files. Invalid values throw an error at startup:

```
Error: Configuration validation failed:
  - PORT: Expected number, received string
  - ENV_MODE: Invalid enum value. Expected 'production' | 'development' | 'test'
```

## CORS Configuration

### Disable CORS

```typescript
// Don't set CORS property, or set to false/undefined
const app = new WebApplication({ PORT: 3000 });
```

### Permissive (Development)

```typescript
const app = new WebApplication({
  CORS: true,
  // Allows all origins with wildcard '*'
  // Enables credentials
  // Responds with 204 for preflight
});
```

### Restrictive (Production)

```typescript
const app = new WebApplication({
  CORS: {
    origin: ['https://app.example.com', 'https://admin.example.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Request-ID'],
    credentials: true,
    maxAge: 86400, // 24 hours preflight cache
  },
});
```

### Dynamic Origin Validation

```typescript
const app = new WebApplication({
  CORS: {
    origin: (origin, callback) => {
      const allowed = origin?.endsWith('.example.com') ?? false;
      callback(null, allowed);
    },
    credentials: true,
  },
});
```

## Environment-Specific Behavior

| Behavior | Production | Development | Test |
|----------|-----------|-------------|------|
| Error stack traces | Hidden | Shown | Shown |
| Default LOG_LEVEL | ERROR | DEBUG | DEBUG |
| Shutdown timeout | `SHUTDOWN_TIMEOUT` seconds | 1 second | 1 second |
| Security headers | Full Helmet | Full Helmet | Full Helmet |

---

**Back to**: [README](../README.md) | **Next**: [Controllers](./CONTROLLERS.md)
