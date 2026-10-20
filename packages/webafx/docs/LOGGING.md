# Logging System

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

WebAFX provides two logger implementations: `ConsoleLogger` for development (human-readable) and `StructuredLogger` for production (JSON output for log aggregation systems). Both implement the `Logger` interface.

## Logger Interface

```typescript
interface Logger {
  info(message: string, data?: Record<string, any>): Promise<void>;
  error(message: string, data?: Record<string, any>): Promise<void>;
  warn(message: string, data?: Record<string, any>): Promise<void>;
  debug(message: string, data?: Record<string, any>): Promise<void>;
}
```

All log methods are async to support various logging backends.

## Log Levels

| Level | Value | Description |
|-------|-------|-------------|
| `ERROR` | 1 | Errors only (highest priority) |
| `WARN` | 2 | Errors and warnings |
| `INFO` | 3 | Errors, warnings, and info |
| `DEBUG` | 4 | All messages (lowest priority) |

Messages are logged if their level is **at or below** the configured threshold. For example, `LOG_LEVEL: 'WARN'` logs ERROR and WARN, but not INFO or DEBUG.

### Automatic Log Level

If `LOG_LEVEL` is not explicitly set:
- **Production**: defaults to `ERROR`
- **Non-production**: defaults to `DEBUG`
- If `DEBUG: true` is set: forces `DEBUG` regardless of environment

## ConsoleLogger

Human-readable output for development. Each message includes log type, optional prefix, and optional data.

```typescript
import { ConsoleLogger } from '@blendsdk/webafx';

const logger = new ConsoleLogger('MyService', 'DEBUG');

await logger.info('Server started', { port: 3000 });
// [INFO:MYSERVICE]: Server started - {"port":3000}

await logger.error('Connection failed', { host: 'db.local' });
// [ERROR:MYSERVICE]: Connection failed - {"host":"db.local"}

await logger.debug('Query executed', { sql: 'SELECT *', duration: 15 });
// [DEBUG:MYSERVICE]: Query executed - {"sql":"SELECT *","duration":15}
```

### Constructor

```typescript
new ConsoleLogger(prefix?: string, logLevel?: LogLevel)
```

- `prefix` — Optional identifier prepended to messages (e.g., `'APP'`, `'Plugin:Auth'`)
- `logLevel` — Override log level (defaults to `process.env.LOG_LEVEL` or `'ERROR'`)

## StructuredLogger

JSON output for production environments. Ideal for log aggregation systems like ELK, CloudWatch, or Datadog.

```typescript
import { StructuredLogger } from '@blendsdk/webafx';

const logger = new StructuredLogger('API', 'INFO');

await logger.info('User login', { userId: 123 });
// {"timestamp":"2026-02-09T10:00:00.000Z","level":"INFO","message":"User login","prefix":"API","data":{"userId":123}}

await logger.error('Database timeout', { query: 'SELECT ...' });
// {"timestamp":"2026-02-09T10:00:00.000Z","level":"ERROR","message":"Database timeout","prefix":"API","data":{"query":"SELECT ..."}}
```

### Constructor

```typescript
new StructuredLogger(
  prefix?: string,
  logLevel?: LogLevel,
  contextFn?: () => Record<string, unknown>
)
```

- `prefix` — Optional identifier included in log entries
- `logLevel` — Override log level
- `contextFn` — Optional function to inject dynamic context into every log entry (e.g., request ID)

### Context Function

The `contextFn` parameter allows injecting dynamic data into every log entry:

```typescript
import { getRequestId } from '@blendsdk/webafx';

const logger = new StructuredLogger('API', 'INFO', () => ({
  requestId: getRequestId(),
  environment: 'production',
}));

await logger.info('Processing order');
// {"timestamp":"...","level":"INFO","message":"Processing order","prefix":"API","requestId":"abc-123","environment":"production"}
```

### Log Entry Format

```typescript
interface LogEntry {
  timestamp: string;          // ISO 8601
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
  message: string;
  prefix?: string;            // Logger prefix
  requestId?: string;         // From contextFn
  data?: Record<string, unknown>; // Additional data
  [key: string]: unknown;     // Dynamic context properties
}
```

## Built-in Request Logging

WebAFX automatically logs every request after the response completes:

```
[INFO:APP]: GET /api/users 200 15ms - {"method":"GET","url":"/api/users","statusCode":200,"duration":15,"requestId":"abc-123"}
```

This includes:
- HTTP method and URL
- Status code
- Response duration in milliseconds
- Request ID for correlation

## Using Loggers in Plugins

Plugins receive a pre-configured logger:

```typescript
const myPlugin: PluginDefinition = {
  name: 'my-plugin',
  factory: async ({ logger }) => {
    // Logger is pre-configured with prefix 'Plugin:my-plugin'
    await logger.info('Initializing');
    await logger.debug('Configuration loaded');

    return {
      shutdown: async () => {
        await logger.info('Shutting down');
      },
    };
  },
};
```

## Choosing a Logger

| Use Case | Logger | Why |
|----------|--------|-----|
| Local development | `ConsoleLogger` | Human-readable, colorless terminal output |
| Production | `StructuredLogger` | JSON format for log aggregation (ELK, CloudWatch) |
| Testing | `ConsoleLogger` | Simple output for test debugging |

### Switching Logger via Plugin

```typescript
const productionLoggerPlugin: PluginDefinition = {
  name: 'structured-logger',
  priority: 1, // Install first
  factory: async ({ app }) => {
    const settings = app.getSettings();
    if (settings.isProduction()) {
      const logger = new StructuredLogger('APP', settings.get('LOG_LEVEL'));
      app.registerService({
        name: 'logger',
        type: 'singleton',
        factory: () => logger,
      });
    }
  },
};
```

---

**Back to**: [README](../README.md) | **Prev**: [Errors](./ERRORS.md) | **Next**: [Middleware](./MIDDLEWARE.md)
