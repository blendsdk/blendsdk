> **Package**: `blendsdk/webafx-pino`

# webafx-pino Core Concepts

This document is a deep dive into every major abstraction exposed by `blendsdk/webafx-pino`. Each section follows the same structure: **What It Is**, **How It Works**, a complete runnable example, and a reference table. The concepts covered are:

- `LoggerProvider` — the abstract provider contract
- `PinoLoggerProvider` — the pino-backed implementation
- Structured JSON logging and the message-first adapter
- Log level normalization with `normalizeLevel()`
- Sensitive data redaction
- Request-scoped child loggers
- Pretty printing and custom destinations
- Plugin factories: `pinoLoggerPlugin` and `createLoggerPlugin`
- Configuration types and default constants

For a quick start, see Basic Usage; for the big picture, see the Overview.

---

## LoggerProvider: The Abstract Base Class

### What It Is

`LoggerProvider` is the abstract foundation for every logger implementation in the package. It implements the BlendSDK `Logger` interface — the four asynchronous methods `info()`, `error()`, `warn()`, and `debug()` — and adds provider-specific concerns on top: a `serviceName` used for WebAFX service-container registration, the lifecycle methods `health()` and `shutdown()`, and `createRequestLogger(bindings)` for request-scoped logging. Concrete providers such as `PinoLoggerProvider` extend it and translate `Logger` calls into their underlying logging library.

### How It Works

- The constructor accepts an optional `LoggerProviderConfig` and stores the service name in the protected `_serviceName` field, defaulting to `DEFAULT_SERVICE_NAME` (`'logger'`). The value is exposed through a public `serviceName` getter.
- The four logging methods plus `health()`, `shutdown()`, and `createRequestLogger()` are declared `abstract` — every subclass is forced by the compiler to implement them.
- The class imports `Logger` from `blendsdk/webafx` with `import type` only, so it has **no runtime dependency on WebAFX**. It can be subclassed in any TypeScript project, standalone or not.
- The class itself cannot be instantiated directly (it is abstract). You either subclass it — as shown below — or use it as the contract that `PinoLoggerProvider` fulfills.

### Complete Example

A minimal custom provider that implements every abstract member. This is the exact surface `PinoLoggerProvider` fills with pino.

```typescript
import { LoggerProvider } from 'blendsdk/webafx-pino';
import type { Logger } from 'blendsdk/webafx';

/**
 * Minimal concrete provider that keeps entries in memory.
 * Shows everything a LoggerProvider subclass must implement.
 */
class InMemoryLogger extends LoggerProvider {
  readonly entries: string[] = [];

  async info(message: string, data?: Record<string, unknown>): Promise<void> {
    this.entries.push(`INFO  ${message} ${JSON.stringify(data ?? {})}`);
  }

  async error(message: string, data?: Record<string, unknown>): Promise<void> {
    this.entries.push(`ERROR ${message} ${JSON.stringify(data ?? {})}`);
  }

  async warn(message: string, data?: Record<string, unknown>): Promise<void> {
    this.entries.push(`WARN  ${message} ${JSON.stringify(data ?? {})}`);
  }

  async debug(message: string, data?: Record<string, unknown>): Promise<void> {
    this.entries.push(`DEBUG ${message} ${JSON.stringify(data ?? {})}`);
  }

  async health(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    this.entries.length = 0;
  }

  createRequestLogger(bindings: Record<string, unknown>): Logger {
    const parent = this;
    return {
      async info(message: string, data?: Record<string, unknown>): Promise<void> {
        await parent.info(message, { ...bindings, ...data });
      },
      async error(message: string, data?: Record<string, unknown>): Promise<void> {
        await parent.error(message, { ...bindings, ...data });
      },
      async warn(message: string, data?: Record<string, unknown>): Promise<void> {
        await parent.warn(message, { ...bindings, ...data });
      },
      async debug(message: string, data?: Record<string, unknown>): Promise<void> {
        await parent.debug(message, { ...bindings, ...data });
      },
    };
  }
}

const logger = new InMemoryLogger({ serviceName: 'audit-logger' });

await logger.info('provider ready', { serviceName: logger.serviceName });
await logger.shutdown();
```

### Key Methods/Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config?: LoggerProviderConfig)` | Initializes `serviceName` from config, falling back to `DEFAULT_SERVICE_NAME` |
| `serviceName` | `string` (getter) | Name used when the plugin registers the provider in the WebAFX service container |
| `info` | `abstract info(message: string, data?: Record<string, any>): Promise<void>` | Log an informational message |
| `error` | `abstract error(message: string, data?: Record<string, any>): Promise<void>` | Log an error message |
| `warn` | `abstract warn(message: string, data?: Record<string, any>): Promise<void>` | Log a warning message |
| `debug` | `abstract debug(message: string, data?: Record<string, any>): Promise<void>` | Log a debug message |
| `health` | `abstract health(): Promise<boolean>` | Health check consumed by the application lifecycle; stateless loggers return `true` |
| `shutdown` | `abstract shutdown(): Promise<void>` | Flush buffered entries and release resources |
| `createRequestLogger` | `abstract createRequestLogger(bindings: Record<string, unknown>): Logger` | Return a `Logger` that includes `bindings` in every entry |

---

## PinoLoggerProvider: The Pino-Backed Provider

### What It Is

`PinoLoggerProvider` is the concrete `LoggerProvider` implementation that adapts **pino** behind the BlendSDK `Logger` interface. Each provider instance owns exactly one root pino logger and translates the message-first, asynchronous `Logger` calls into pino's object-first, synchronous calls. It supports structured JSON output, log-level normalization, sensitive-data redaction, development pretty-printing, custom output destinations, custom serializers, and request-scoped child loggers.

### How It Works

The constructor runs a fixed pipeline:

1. Calls `super(config)` — establishing `serviceName` (default `'logger'`) on the base class.
2. Normalizes the level: `normalizeLevel(config?.level ?? 'info')` — see [Log Level Normalization](#log-level-normalization-with-normalizelevel) below.
3. Resolves redact paths: `config?.redact ?? DEFAULT_REDACT_PATHS`. The `redact` pino option is only applied when the array is non-empty.
4. Builds `pino.LoggerOptions` as `{ level, redact?, serializers?, ...pinoOptions }`. Because `pinoOptions` is spread **last**, it can override any named option.
5. If `pretty: true` **and** no custom `destination` is set, attaches the `pino-pretty` transport (`{ colorize: true }`). When a destination is provided, `pretty` is ignored — a pino transport and a custom destination stream cannot be combined.
6. Instantiates pino: `pino(pinoOpts, config.destination)` when a destination is given, otherwise `pino(pinoOpts)` writing to stdout.

The `Logger` methods forward to the corresponding pino level methods. Pino writes synchronously and the wrapper methods resolve their promises immediately after the entry has been handed to the destination. `shutdown()` resolves once `pino.flush()` has drained buffered entries, which matters for asynchronous transports and streams.

### Complete Example

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({
  level: 'DEBUG',        // normalized to 'debug'
  serviceName: 'appLogger',
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'user.password',
  ],
  serializers: {
    req: (req: unknown) => req,
    res: (res: unknown) => res,
  },
  pinoOptions: { name: 'checkout-service' },
});

await logger.info('provider constructed', { serviceName: logger.serviceName });

// Escape hatch: the raw pino instance for advanced scenarios (e.g., pino-http)
const raw = logger.getPinoInstance();
await logger.info('raw pino available', { hasChild: typeof raw.child === 'function' });

// Flush buffered entries before shutdown
await logger.shutdown();
```

### Key Methods/Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `constructor` | `(config?: PinoLoggerProviderConfig)` | Normalizes the level, applies defaults, and builds the underlying pino instance |
| `info` / `error` / `warn` / `debug` | `(message: string, data?: Record<string, any>): Promise<void>` | Emit a structured JSON entry at the corresponding pino level |
| `health` | `(): Promise<boolean>` | Always resolves `true` — pino writes synchronously and has no meaningful failure state |
| `shutdown` | `(): Promise<void>` | Resolves once `pino.flush()` completes, draining buffered entries |
| `createRequestLogger` | `(bindings: Record<string, unknown>): Logger` | Creates a pino child logger and wraps it in the internal `PinoChildLoggerAdapter` |
| `getPinoInstance` | `(): PinoLogger` | Returns the raw pino logger for pino-specific features not covered by the `Logger` interface |

---

## Structured JSON Logging and the Message-First Adapter

### What It Is

The central mechanism of the package is the adapter between two API shapes: the BlendSDK `Logger` interface is **message-first and asynchronous** (`await logger.info('Server started', { port: 3000 })`), while pino is **object-first and synchronous** (`pino.info({ port: 3000 }, 'Server started')`). `PinoLoggerProvider` translates every call so that the result is a structured JSON record containing the message, the numeric level, a timestamp, and any contextual fields as top-level properties.

### How It Works

- **Argument order swap**: when `data` is present, the provider calls `pino.info(data, message)` (object first, message last). When `data` is omitted, it calls `pino.info(message)` directly. The same pattern applies to `error`, `warn`, and `debug`.
- **JSON record shape**: pino serializes each call into one JSON line. The message lands in `msg`, the severity in `level` (numeric), the timestamp in `time` (epoch milliseconds), and every key of `data` becomes a top-level field of the record.
- **Async facade over sync writes**: pino writes to the destination synchronously and returns `void`. The provider's methods are `async` only to satisfy the `Logger` contract; they resolve after the entry has been written.
- **Field precedence**: fields from `data` are merged at the top level of the record; child-logger bindings (see [Request-Scoped Child Loggers](#request-scoped-child-loggers)) are merged into the same record.
- **Call translation at a glance**:

| BlendSDK call | Emitted pino call | Resulting JSON (abridged) |
|---------------|-------------------|---------------------------|
| `await logger.info('server started')` | `pino.info('server started')` | `{ "level": 30, "time": <epoch-ms>, "msg": "server started" }` |
| `await logger.info('server started', { port: 3000 })` | `pino.info({ port: 3000 }, 'server started')` | `{ "level": 30, "time": <epoch-ms>, "msg": "server started", "port": 3000 }` |

- **Numeric levels** written by pino:

| Level | Numeric value |
|-------|---------------|
| `trace` | 10 |
| `debug` | 20 |
| `info` | 30 |
| `warn` | 40 |
| `error` | 50 |
| `fatal` | 60 |
| `silent` | no output |

- Pino also adds `pid` and `hostname` to every record by default. Both can be suppressed by passing `pinoOptions: { base: null }` — see [Configuration Types and Constants](#configuration-types-and-constants).

### Complete Example

This example captures the raw JSON output with a `Writable` destination stream so the record shape is directly observable.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const records: Array<Record<string, unknown>> = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: 'info', destination: capture });

await logger.info('server started', { port: 3000, host: 'localhost' });

// records[0].level === 30
// records[0].msg === 'server started'
// records[0].port === 3000
// records[0].host === 'localhost'

await logger.shutdown();
```

### Key Methods/Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `info` | `(message: string, data?: Record<string, any>): Promise<void>` | Writes `pino.info(data, message)` — `msg` plus top-level data fields |
| `error` | `(message: string, data?: Record<string, any>): Promise<void>` | Writes `pino.error(data, message)` — numeric level `50` |
| `warn` | `(message: string, data?: Record<string, any>): Promise<void>` | Writes `pino.warn(data, message)` — numeric level `40` |
| `debug` | `(message: string, data?: Record<string, any>): Promise<void>` | Writes `pino.debug(data, message)` — numeric level `20` |
| `msg` (JSON field) | `string` | The `message` argument of the Logger call |
| `level` (JSON field) | `number` | The numeric pino level of the call |
| `time` (JSON field) | `number` | Epoch milliseconds, added by pino |

---

## Log Level Normalization with normalizeLevel()

### What It Is

`normalizeLevel()` is a small exported utility that maps any log-level string to a valid pino level. It exists because configuration sources differ in casing — environment variables and `ApplicationSettings` conventionally use uppercase (`'INFO'`, `'DEBUG'`), while pino requires lowercase level names. The function is applied automatically inside the `PinoLoggerProvider` constructor; it is also exported so you can reuse the same rules elsewhere.

### How It Works

- The input is lowercased with `toLowerCase()` and checked against the valid set: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`.
- Valid values pass through in lowercase — `'INFO'`, `'Info'`, and `'info'` all become `'info'`.
- Unrecognized values — including `'verbose'`, `'CRITICAL'`, and the empty string — **fall back to `'info'`** rather than throwing. Misconfiguration degrades to a safe, sensible default instead of crashing startup.
- The provider applies it as `normalizeLevel(config?.level ?? 'info')`, so omitting `level` entirely is equivalent to passing `'info'`.

### Complete Example

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider, normalizeLevel } from 'blendsdk/webafx-pino';

// Direct normalization: mixed-case input becomes a valid pino level
const level: string = normalizeLevel('WARN'); // 'warn'

const records: Array<Record<string, unknown>> = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

const logger = new PinoLoggerProvider({ level, destination: capture });

// Everything below 'warn' is filtered out by pino
await logger.debug('suppressed');
await logger.info('suppressed');
await logger.warn('visible');
await logger.error('visible');

// records.length === 2 — both entries have msg === 'visible'

await logger.shutdown();
```

### Key Methods/Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `normalizeLevel` | `(level: string): string` | Lowercases the input, validates it against the pino level set, and returns `'info'` for unrecognized values |

Input/output mapping:

| Input | Output | Reason |
|-------|--------|--------|
| `'info'` | `'info'` | Valid level passes through |
| `'INFO'` / `'Info'` | `'info'` | Lowercased, then matched |
| `'DEBUG'` | `'debug'` | Lowercased, then matched |
| `'verbose'` | `'info'` | Not a pino level — safe fallback |
| `'CRITICAL'` | `'info'` | Not a pino level — safe fallback |
| `''` | `'info'` | Not a pino level — safe fallback |

---

## Sensitive Data Redaction

### What It Is

Redaction is the mechanism that keeps credentials out of log output. `PinoLoggerProvider` configures pino's built-in `redact` option so that matched paths are replaced with the placeholder `'[Redacted]'` before the entry is serialized. Two paths are redacted by default — `req.headers.authorization` and `req.headers.cookie` — because request objects are the most common source of accidentally logged secrets.

### How It Works

- The default paths come from the exported `DEFAULT_REDACT_PATHS` constant. They are applied whenever the `redact` config option is **not** provided.
- **Providing `redact` replaces the defaults entirely — the arrays are not merged.** If you set `redact: ['user.password']`, the authorization and cookie headers are no longer redacted.
- The `redact` pino option is only attached when the resolved array is non-empty. An explicit `redact: []` therefore disables redaction completely.
- Redaction matches paths that actually exist in the logged object; paths that are absent from an entry are simply ignored.
- The replacement label is pino's default censor, the string `'[Redacted]'`.

### Complete Example

The example shows both behaviors side by side: default redaction, and a custom `redact` configuration that replaces — not extends — the defaults.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const records: Array<Record<string, unknown>> = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

// 1. Default redaction — authorization and cookie headers are masked
const defaultLogger = new PinoLoggerProvider({ level: 'info', destination: capture });

await defaultLogger.info('request received', {
  req: {
    headers: {
      authorization: 'Bearer super-secret-token',
      cookie: 'session=abc123',
      'content-type': 'application/json',
    },
  },
});

// records[0].req.headers.authorization === '[Redacted]'
// records[0].req.headers.cookie === '[Redacted]'
// records[0].req.headers['content-type'] === 'application/json'

await defaultLogger.shutdown();

// 2. Custom redact — REPLACES the defaults, does not merge with them
const customLogger = new PinoLoggerProvider({
  level: 'info',
  destination: capture,
  redact: ['user.password'],
});

await customLogger.info('login attempt', {
  user: { name: 'admin', password: 'secret123' },
  req: { headers: { authorization: 'Bearer no-longer-redacted' } },
});

// records[1].user.password === '[Redacted]'
// records[1].user.name === 'admin'
// records[1].req.headers.authorization === 'Bearer no-longer-redacted'

await customLogger.shutdown();
```

### Key Methods/Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `redact` | `string[]` | Paths to mask in log output. When provided, **replaces** `DEFAULT_REDACT_PATHS` entirely |
| `DEFAULT_REDACT_PATHS` | `readonly string[]` | `['req.headers.authorization', 'req.headers.cookie']` — applied when `redact` is omitted |
| `redact: []` | `string[]` | Explicitly disables redaction (the pino `redact` option is skipped for empty arrays) |
| Censor placeholder | `'[Redacted]'` | pino's default replacement string for matched paths |

---

## Request-Scoped Child Loggers

### What It Is

A request-scoped logger is a `Logger` instance whose every entry automatically carries a fixed set of context fields — most commonly a `requestId`. `PinoLoggerProvider.createRequestLogger(bindings)` produces one by creating a pino child logger (`pino.child(bindings)`) and wrapping it in `PinoChildLoggerAdapter`, an internal class that satisfies the BlendSDK `Logger` interface. This is the mechanism the WebAFX plugin middleware uses to attach `req.log` to each request.

### How It Works

- `createRequestLogger(bindings)` calls `this.pino.child(bindings)` and returns a new `PinoChildLoggerAdapter` around the child. The adapter is **not exported** from the package — child loggers are only reachable through this factory method.
- Every entry emitted through the adapter merges the bindings with the per-call `data`, so a child bound to `{ requestId: 'req-42' }` emits `requestId` on every record, plus whatever data each call adds.
- The child **inherits the parent's level**: a child of a `warn`-level provider suppresses `debug` and `info` calls.
- Bindings are snapshotted at creation time. Children are independent of each other — the same provider can produce one child per in-flight request without interference.
- Inside the WebAFX plugin, the middleware creates exactly one child per request: bindings are `{ requestId: req.id }` when `req.id` is set by upstream middleware, and `{}` otherwise.

### Complete Example

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const records: Array<Record<string, unknown>> = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: 'trace', destination: capture });

// One child per request, carrying the correlation context
const requestLogger = logger.createRequestLogger({
  requestId: 'req-42',
  userId: 'user-7',
});

await requestLogger.info('fetching profile', { durationMs: 12 });
await requestLogger.warn('cache miss');

// records[0].requestId === 'req-42'
// records[0].userId === 'user-7'
// records[0].durationMs === 12
// records[0].msg === 'fetching profile'
// records[1].requestId === 'req-42'
// records[1].msg === 'cache miss'

await logger.shutdown();
```

### Key Methods/Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `createRequestLogger` | `(bindings: Record<string, unknown>): Logger` | Creates `pino.child(bindings)` and wraps it in `PinoChildLoggerAdapter` |
| `PinoChildLoggerAdapter` | not exported (internal class) | Adapter implementing `Logger`; merges bindings into every entry |
| `PinoChildLoggerAdapter.info` | `(message: string, data?: Record<string, any>): Promise<void>` | Child-level `info` with bindings plus per-call data |
| `PinoChildLoggerAdapter.error` | `(message: string, data?: Record<string, any>): Promise<void>` | Child-level `error` with bindings plus per-call data |
| `PinoChildLoggerAdapter.warn` | `(message: string, data?: Record<string, any>): Promise<void>` | Child-level `warn` with bindings plus per-call data |
| `PinoChildLoggerAdapter.debug` | `(message: string, data?: Record<string, any>): Promise<void>` | Child-level `debug` with bindings plus per-call data |

---

## Pretty Printing and Custom Destinations

### What It Is

The package offers two output-routing options. `pretty: true` switches the output from raw JSON lines to colorized, human-readable lines for local development, using the optional `pino-pretty` peer dependency. `destination` replaces stdout with any Node.js `Writable` stream — the primary testing tool in this package, since it makes log output programmatically inspectable, and also the hook for custom transports in production.

### How It Works

- When `pretty: true` is set and **no** destination is configured, the constructor attaches pino's transport mechanism: `{ target: 'pino-pretty', options: { colorize: true } }`. This spins up pino's worker-thread transport.
- When `destination` is provided, the provider calls `pino(pinoOpts, config.destination)` and **ignores `pretty`**. A pino transport (`pino-pretty`) and a custom destination stream are mutually exclusive; the destination wins.
- Requires `pino-pretty` (peer dependency, `>=11.0.0`) only when pretty-printing is actually enabled — it is optional and does not need to be installed for production JSON logging.
- Because pretty output goes through a transport, always call `await logger.shutdown()` before process exit; `shutdown()` waits for `pino.flush()` so no buffered line is lost.

### Complete Example

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// 1. Development — colorized output on stdout (requires pino-pretty)
const devLogger = new PinoLoggerProvider({ level: 'debug', pretty: true });
await devLogger.debug('colorized line written to stdout');
await devLogger.shutdown();

// 2. Testing — capture raw JSON lines with a custom destination
const lines: string[] = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    lines.push(chunk.toString().trim());
    callback();
  },
});

// pretty is set but ignored: a custom destination takes precedence
const testLogger = new PinoLoggerProvider({
  level: 'info',
  pretty: true,
  destination: capture,
});

await testLogger.info('captured as JSON');
await testLogger.shutdown();

// lines[0] is a raw JSON string such as:
// {"level":30,"time":1730000000000,"msg":"captured as JSON"}
```

### Key Methods/Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `pretty` | `boolean` (default `false`) | Attaches the `pino-pretty` transport with colorized output; ignored when `destination` is set |
| `destination` | `import('node:stream').Writable` | Custom output stream; pino writes raw JSON to it instead of stdout |
| `pino-pretty` | optional peer dependency (`>=11.0.0`) | Required only when `pretty: true` is used |
| `shutdown()` | `(): Promise<void>` | Flushes the transport/destination via `pino.flush()` — call before process exit |

---

## Plugin Factories: pinoLoggerPlugin and createLoggerPlugin

### What It Is

The plugin factories are the bridge from a standalone provider to a WebAFX application. `pinoLoggerPlugin(options)` is the one-call convenience form: it constructs a `PinoLoggerProvider` from the given options and wraps it. `createLoggerPlugin(provider, options?)` is the provider-first, two-step form: you construct and configure **any** `LoggerProvider` yourself, then wrap it. Both return a `PluginDefinition` for `app.use()` and perform the same four installation steps when the application installs the plugin.

### How It Works

The plugin definition has the identifier `'pino-logger'`, a default priority of `20` (`DEFAULT_PLUGIN_PRIORITY`) — lower numbers install first, so the logger is available before the cache and mailer plugins at priority `30` — and an async `factory` that runs these steps during installation:

1. **`app.setLogger(provider)`** — replaces the application's default logger with the provider.
2. **Installs Express middleware** — for every request it builds `bindings` from `req.id` (only when present) and assigns `req.log = provider.createRequestLogger(bindings)`, then calls `next()`. Every request thus carries a request-scoped logger with a `requestId` binding when upstream middleware (e.g., express-request-id) set `req.id`.
3. **Registers the service** — `app.registerService({ name: provider.serviceName, type: 'singleton', factory: () => provider })`, so the provider is injectable under `'logger'` (or a custom `serviceName`) as a singleton.
4. **Returns lifecycle hooks** — `{ health: () => provider.health(), shutdown: () => provider.shutdown() }`, which the application uses during its own health checks and graceful shutdown.

The factory also augments the Express `Request` type globally with two optional members — `req.id?: string` and `req.log?: Logger` — so handlers get typed access. Because `createLoggerPlugin` accepts any `LoggerProvider`, it is the extensibility point for wiring a custom provider into the identical WebAFX lifecycle.

### Complete Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import {
  PinoLoggerProvider,
  createLoggerPlugin,
  pinoLoggerPlugin,
} from 'blendsdk/webafx-pino';

// ── One-liner form — constructs the provider internally ──────────────
const app = new WebApplication();
app.use(pinoLoggerPlugin({ level: 'info', pretty: true }));

// ── Provider-first form — wrap a provider you constructed yourself ───
const configuredApp = new WebApplication();
const provider = new PinoLoggerProvider({ level: 'info', serviceName: 'appLogger' });
configuredApp.use(createLoggerPlugin(provider, { priority: 10 }));

// ── Inside a request handler ─────────────────────────────────────────
// The plugin's middleware has set req.log with { requestId: req.id }.
async function listOrders(req: Request, res: Response): Promise<void> {
  await req.log?.info('listing orders', { path: req.path });
  res.status(200).json({ orders: [] });
}

// Keep the handler referenced so the example compiles as a unit
void listOrders;
```

### Key Methods/Properties

| Name | Type/Signature | Description |
|------|----------------|-------------|
| `pinoLoggerPlugin` | `(options?: PinoLoggerPluginOptions): PluginDefinition` | One-liner: constructs a `PinoLoggerProvider` and delegates to `createLoggerPlugin` |
| `createLoggerPlugin` | `(provider: LoggerProvider, options?: { priority?: number }): PluginDefinition` | Provider-first: wraps any `LoggerProvider` in WebAFX wiring; `priority` defaults to `DEFAULT_PLUGIN_PRIORITY` |
| `plugin.name` | `'pino-logger'` | Plugin identifier |
| `plugin.priority` | `number` | Install order; lower installs first. Default `20` (before cache/mailer at `30`) |
| `plugin.factory` | `(context) => Promise<{ health: () => Promise<boolean>; shutdown: () => Promise<void> }>` | Performs `setLogger`, `req.log` middleware, service registration, and returns lifecycle hooks |
| `express.Request.id` | `string \| undefined` | Set by upstream middleware (e.g., express-request-id); source of the `requestId` binding |
| `express.Request.log` | `Logger \| undefined` | Request-scoped logger installed by the plugin middleware |

---

## Configuration Types and Constants

### What It Is

The public configuration surface consists of three interfaces and three constants, all exported from the package root. `LoggerProviderConfig` is the base contract shared by any provider; `PinoLoggerProviderConfig` extends it with pino-specific options; `PinoLoggerPluginOptions` extends the pino config with the plugin `priority`. The constants provide the defaults that the provider and plugin apply when options are omitted.

### How It Works

- `LoggerProviderConfig` carries the two settings every provider understands: `level` (case-insensitive, normalized at construction) and `serviceName` (service-container identity, default `'logger'`).
- `PinoLoggerProviderConfig` adds `pretty`, `redact`, `serializers`, `pinoOptions`, and `destination` — documented in the table below.
- `pinoOptions` is typed as `Record<string, unknown>` deliberately, so the public API does not leak pino's own option types; it is spread **after** the named options when constructing the pino instance and can therefore override them (including pino features such as `base: null` to drop `pid`/`hostname`).
- `PinoLoggerPluginOptions` is `PinoLoggerProviderConfig` plus `priority?: number`; `pinoLoggerPlugin()` forwards its provider options to `PinoLoggerProvider` and its `priority` to `createLoggerPlugin`.
- The constants — `DEFAULT_SERVICE_NAME`, `DEFAULT_PLUGIN_PRIORITY`, `DEFAULT_REDACT_PATHS` — are the single source of truth for the defaults described throughout this document.

### Complete Example

```typescript
import { Writable } from 'node:stream';
import {
  PinoLoggerProvider,
  normalizeLevel,
  DEFAULT_SERVICE_NAME,
  DEFAULT_PLUGIN_PRIORITY,
  DEFAULT_REDACT_PATHS,
  type LoggerProviderConfig,
  type PinoLoggerProviderConfig,
  type PinoLoggerPluginOptions,
} from 'blendsdk/webafx-pino';

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  },
});

// Base config — shared by every provider implementation
const baseConfig: LoggerProviderConfig = {
  level: 'info',
  serviceName: DEFAULT_SERVICE_NAME,
};

// Pino-specific config — everything PinoLoggerProvider accepts
const pinoConfig: PinoLoggerProviderConfig = {
  ...baseConfig,
  pretty: false,
  redact: DEFAULT_REDACT_PATHS,
  serializers: {
    req: (req: unknown) => req,
    res: (res: unknown) => res,
  },
  pinoOptions: { name: 'checkout-service', base: null },
  destination: capture,
};

// Plugin options — provider config plus a priority override
const pluginOptions: PinoLoggerPluginOptions = {
  ...pinoConfig,
  priority: DEFAULT_PLUGIN_PRIORITY,
};

const logger = new PinoLoggerProvider(pluginOptions);

await logger.info('effective configuration', {
  level: normalizeLevel(pluginOptions.level ?? 'info'),
  serviceName: logger.serviceName,
  priority: pluginOptions.priority,
});

await logger.shutdown();
```

### Key Methods/Properties

All options accepted by `PinoLoggerProviderConfig` / `PinoLoggerPluginOptions`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `level` | `string` | `'info'` | Case-insensitive level; normalized via `normalizeLevel()` |
| `serviceName` | `string` | `'logger'` | Name for service-container registration (singleton) |
| `pretty` | `boolean` | `false` | Colorized pino-pretty output; ignored when `destination` is set |
| `redact` | `string[]` | `DEFAULT_REDACT_PATHS` | Paths masked as `'[Redacted]'`; replaces the defaults |
| `serializers` | `{ req?: (req: unknown) => unknown; res?: (res: unknown) => unknown }` | — | Custom pino serializers for request/response objects |
| `pinoOptions` | `Record<string, unknown>` | — | Extra pino constructor options; spread last, so they take precedence |
| `destination` | `import('node:stream').Writable` | stdout | Custom output stream; disables `pretty` |
| `priority` | `number` | `20` | Plugin-only: install order, lower first |

Exported constants:

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `'logger'` | Service-container name used when `serviceName` is omitted |
| `DEFAULT_PLUGIN_PRIORITY` | `20` | Install order — before cache and mailer plugins (priority `30`) |
| `DEFAULT_REDACT_PATHS` | `['req.headers.authorization', 'req.headers.cookie']` | Applied when `redact` is not configured |

Exported types (implementation-neutral entry points):

| Type | Extends | Purpose |
|------|---------|---------|
| `LoggerProviderConfig` | — | Base config for any provider implementation |
| `PinoLoggerProviderConfig` | `LoggerProviderConfig` | Full configuration for `PinoLoggerProvider` |
| `PinoLoggerPluginOptions` | `PinoLoggerProviderConfig` | Configuration for `pinoLoggerPlugin()`, plus `priority` |

---

# webafx-pino Basic Usage

This guide takes you from installation to your first working log entries — first using `PinoLoggerProvider` standalone, then wiring it into a WebAFX application with the plugin factories. Every section builds on the previous one, and all code examples are complete and runnable as shown. For architectural background, see the Overview; for deep dives into each abstraction, see Core Concepts.

---

## Installation

### 1. Install the package

```bash
# npm
npm install blendsdk/webafx-pino

# yarn
yarn add blendsdk/webafx-pino
```

### 2. Install the required peer dependency

```bash
npm install blendsdk/webafx
```

`blendsdk/webafx` supplies the `Logger` and `PluginDefinition` interfaces. The package imports them with `import type` only — there is no runtime dependency on WebAFX — but the peer must be present for the TypeScript compiler.

### 3. Optionally install pino-pretty

Only needed if you plan to use `pretty: true` for colorized development output:

```bash
npm install --save-dev pino-pretty
```

> **Note**: npm 7+ auto-installs peer dependencies. With yarn or older npm versions, install the peers explicitly as shown.

### Requirements

| Requirement | Value | Notes |
|-------------|-------|-------|
| Node.js | >= 22.0.0 | Modern ESM and `node:stream` support |
| Module system | ESM only | No CommonJS entry point — use `import`, never `require()` |
| TypeScript | Strict mode | All public types are strict-safe |

---

## Quick Start

### Standalone

No WebAFX application required — construct the provider and log:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

await logger.info('Hello from webafx-pino', { service: 'orders' });

await logger.shutdown();
```

The log call writes one JSON line to stdout:

```json
{"level":30,"time":1730000000000,"pid":48213,"hostname":"devbox","service":"orders","msg":"Hello from webafx-pino"}
```

Pino adds `time`, `pid`, and `hostname` automatically; `service` comes from the structured data passed as the second argument. Always `await logger.shutdown()` before process exit so buffered entries are flushed.

### In a WebAFX Application

One `app.use()` call replaces the application's default logger and installs request-scoped logging:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

app.use(pinoLoggerPlugin({ level: 'info' }));
```

From this point on, the application logger writes structured JSON, and every request gets a request-scoped `req.log`. The rest of this document walks through the fundamentals one concept at a time.

---

## Fundamentals

### 1. Creating a Provider

Every use of the package starts with `new PinoLoggerProvider(config?)`.

With no arguments at all, you get sensible defaults — level `info`, service name `logger`, default redaction, and JSON output to stdout:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider();

await logger.info('Provider created with defaults');

await logger.shutdown();
```

Each provider owns one pino instance. Every logging call serializes a single JSON record: the message lands in `msg`, the severity in `level`, the timestamp in `time`, and pino adds `pid` and `hostname`.

The next level: pass a configuration object. `level` and `serviceName` are the two options every logger provider accepts:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({
  level: 'debug',
  serviceName: 'appLogger',
});

await logger.debug('Constructed with custom configuration', {
  serviceName: logger.serviceName,
});

await logger.shutdown();
```

`serviceName` matters when the provider is registered in a WebAFX service container (see [section 8](#8-using-it-as-a-webafx-plugin)); standalone, it is readable metadata exposed on the `serviceName` getter.

### 2. Logging at Different Levels

The BlendSDK `Logger` interface has four asynchronous methods — `info()`, `error()`, `warn()`, and `debug()` — each with the signature `(message: string, data?: Record<string, any>): Promise<void>`:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'debug' });

await logger.debug('Cache lookup missed', { key: 'user:42' });
await logger.info('Request completed', { path: '/api/orders' });
await logger.warn('Retry attempt 2 of 3', { endpoint: '/api/payments' });
await logger.error('Payment declined', { code: 'card_expired' });

await logger.shutdown();
```

Each method maps to a numeric pino level:

| Method | Pino level name | Numeric value |
|--------|-----------------|---------------|
| `debug` | `debug` | 20 |
| `info` | `info` | 30 |
| `warn` | `warn` | 40 |
| `error` | `error` | 50 |

The next level: the configured `level` acts as a threshold. Calls below it are filtered out before anything reaches the destination:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'warn' });

await logger.debug('Suppressed — below warn'); // not emitted
await logger.info('Suppressed — below warn');  // not emitted
await logger.warn('Emitted — level 40');
await logger.error('Emitted — level 50');

await logger.shutdown();
```

`'trace'`, `'fatal'`, and `'silent'` are also valid values for the `level` option, even though the `Logger` interface exposes only the four methods above. `'silent'` disables output entirely, which is useful when testing components that log.

### 3. Attaching Structured Data

The optional second argument is where structured logging pays off: every key becomes a top-level field of the JSON record, alongside `msg`:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

await logger.info('User signed in', {
  userId: 'user-42',
  plan: 'pro',
  durationMs: 128,
});

await logger.shutdown();
```

The emitted record (abridged):

```json
{"level":30,"time":1730000000000,"userId":"user-42","plan":"pro","durationMs":128,"msg":"User signed in"}
```

Under the hood, the provider swaps the argument order for you: the message-first call `logger.info(message, data)` becomes pino's object-first call `pino.info(data, message)`.

The next level: values may be nested objects and arrays — pino serializes them as JSON:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

await logger.error('Order validation failed', {
  orderId: 'order-9',
  errors: ['missing shipping address', 'invalid coupon'],
  totals: { subtotal: 4999, tax: 800 },
});

await logger.shutdown();
```

### 4. Normalizing Log Levels

Configuration typically arrives uppercase (`LOG_LEVEL=DEBUG`), while pino requires lowercase level names. The exported `normalizeLevel()` bridges the two — and never throws:

```typescript
import { PinoLoggerProvider, normalizeLevel } from 'blendsdk/webafx-pino';

const level: string = normalizeLevel(process.env.LOG_LEVEL ?? 'info');

const logger = new PinoLoggerProvider({ level });

await logger.info('Logger started', { level });

await logger.shutdown();
```

| Input | Output | Reason |
|-------|--------|--------|
| `'info'` | `'info'` | Valid level passes through |
| `'INFO'` | `'info'` | Lowercased, valid pino level |
| `'Debug'` | `'debug'` | Lowercased, valid pino level |
| `'verbose'` | `'info'` | Not a pino level — safe fallback |
| `'CRITICAL'` | `'info'` | Not a pino level — safe fallback |
| `''` | `'info'` | Empty input — safe fallback |

The provider normalizes internally as well, so `level: 'INFO'` works directly in the constructor. Use `normalizeLevel()` itself when you need the resolved value — to log it, compare it, or pass it to other systems.

### 5. Redacting Sensitive Data

Two paths are redacted out of the box — `req.headers.authorization` and `req.headers.cookie` — so credentials do not reach the logs when request-like objects are logged:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

await logger.info('Incoming request', {
  req: {
    headers: {
      authorization: 'Bearer secret-token',
      cookie: 'session=abc123',
      'content-type': 'application/json',
    },
  },
});

await logger.shutdown();
```

In the emitted record, `authorization` and `cookie` are replaced with `"[Redacted]"`, while `content-type` passes through untouched.

The next level: a custom `redact` array **replaces** the defaults — the arrays are not merged:

```typescript
import { PinoLoggerProvider, DEFAULT_REDACT_PATHS } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({
  level: 'info',
  redact: [
    ...DEFAULT_REDACT_PATHS, // keep the built-in coverage…
    'user.password',         // …and add your own paths
    'payment.cardNumber',
  ],
});

await logger.info('Login attempt', {
  user: { name: 'admin', password: 'secret123' },
});

await logger.shutdown();
```

If you customize, re-list the defaults you still want masked — a bare `redact: ['user.password']` would let the authorization and cookie headers through. An explicit `redact: []` disables redaction entirely; use that only deliberately.

### 6. Creating Request-Scoped Loggers

`createRequestLogger(bindings)` returns a `Logger` whose every entry automatically includes the given bindings — the standard way to correlate logs with a request:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

const requestLogger = logger.createRequestLogger({ requestId: 'req-42' });

await requestLogger.info('Fetching profile', { userId: 'user-7' });
await requestLogger.warn('Cache miss');

// Both entries carry "requestId":"req-42"; the first also has "userId":"user-7".

await logger.shutdown();
```

How child loggers behave:

- Bindings are merged into every record, alongside each call's own data
- The child inherits the parent's configured level
- Children are independent of one another — create one per request

The next level: one child per in-flight request. This is exactly what the WebAFX plugin's middleware does with `req.id`:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

for (const requestId of ['req-1', 'req-2', 'req-3']) {
  const requestLogger = logger.createRequestLogger({ requestId });
  await requestLogger.info('Handled request');
}

await logger.shutdown();
```

### 7. Controlling Output: Destinations and Pretty Printing

By default, records are written as JSON lines to stdout. A custom `destination` replaces stdout with any writable stream — the standard way to capture and inspect entries in tests:

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const records: Array<Record<string, unknown>> = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: 'info', destination: capture });

await logger.info('Captured entry', { test: true });

// records[0].msg  === 'Captured entry'
// records[0].test === true

await logger.shutdown();
```

The next level: human-readable, colorized output for development with `pretty: true` (requires the optional `pino-pretty` peer from the installation step):

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'debug', pretty: true });

await logger.debug('Colorized line written to stdout');

await logger.shutdown();
```

Two rules to remember:

- `pretty` is ignored when `destination` is set — a pino transport and a custom stream cannot be combined, and the destination wins
- Call `await logger.shutdown()` before process exit — it waits for `pino.flush()`, so buffered entries (especially with the pretty transport) are not lost

### 8. Using It as a WebAFX Plugin

Everything so far ran standalone. Inside a WebAFX application, the plugin factories wire the same provider into the application lifecycle. The one-liner constructs the provider for you:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

app.use(pinoLoggerPlugin({ level: 'info' }));
```

Installing the plugin does four things:

1. Calls `app.setLogger(provider)` — replacing WebAFX's default console logger
2. Installs Express middleware that sets `req.log` on every request — a request-scoped logger bound to `{ requestId: req.id }` when an upstream middleware (e.g., express-request-id) has set `req.id`
3. Registers the provider in the service container as a singleton under `'logger'` (or your custom `serviceName`)
4. Returns `health()` / `shutdown()` hooks so the application lifecycle manages the provider

The next level: when you want to construct and configure the provider yourself, use the provider-first form:

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

const provider = new PinoLoggerProvider({
  level: 'debug',
  pretty: true,
  serviceName: 'appLogger',
});

app.use(createLoggerPlugin(provider, { priority: 10 }));
```

`createLoggerPlugin()` accepts any `LoggerProvider`, so it is also the extension point for custom provider implementations. The plugin installs at priority `20` by default — before the cache and mailer plugins at priority `30` — and the `priority` option overrides that order. If you ever need pino features beyond the `Logger` interface, `provider.getPinoInstance()` returns the underlying pino logger.

Inside a request handler, log through `req.log`:

```typescript
import type { Request, Response } from 'express';

// The plugin's middleware has already attached req.log to this request.
async function listOrders(req: Request, res: Response): Promise<void> {
  await req.log?.info('Listing orders', { path: req.path });
  res.status(200).json({ orders: [] });
}

// Keep the handler referenced so the example compiles as a unit.
void listOrders;
```

---

## Configuration

Every option is optional — the defaults give you safe, redacted JSON logging out of the box.

### Provider options

These options are accepted by `new PinoLoggerProvider(...)` and by `pinoLoggerPlugin()`:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `level` | `string` | `'info'` | Minimum level to emit. Case-insensitive; normalized with `normalizeLevel()`, unknown values fall back to `'info'`. |
| `serviceName` | `string` | `'logger'` | Name under which the provider is registered in the WebAFX service container (as a singleton). |
| `pretty` | `boolean` | `false` | Colorized, human-readable output via the optional `pino-pretty` peer. Ignored when `destination` is set. |
| `redact` | `string[]` | `DEFAULT_REDACT_PATHS` | Paths masked as `'[Redacted]'`. Replaces the defaults — spread `DEFAULT_REDACT_PATHS` to keep them. |
| `serializers` | `{ req?: (req: unknown) => unknown; res?: (res: unknown) => unknown }` | — | Custom pino serializers controlling what request/response data appears in entries. |
| `pinoOptions` | `Record<string, unknown>` | — | Additional pino constructor options, spread last so they can override the named options (e.g., `{ base: null }` drops `pid` and `hostname`). |
| `destination` | `import('node:stream').Writable` | stdout | Custom output stream — raw JSON is written there instead of stdout. Takes precedence over `pretty`. |

### Plugin-only options

Passed to `pinoLoggerPlugin()`; `createLoggerPlugin()` accepts only `priority`:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `priority` | `number` | `20` | Plugin install order — lower installs first. `20` places the logger before the cache and mailer plugins (`30`). |

### Default constants

All exported from the package root, in case you need to reference them:

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `'logger'` | Service-container name used when `serviceName` is omitted |
| `DEFAULT_PLUGIN_PRIORITY` | `20` | Plugin install priority |
| `DEFAULT_REDACT_PATHS` | `['req.headers.authorization', 'req.headers.cookie']` | Redaction applied when `redact` is omitted |

### Full configuration example

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider, DEFAULT_REDACT_PATHS } from 'blendsdk/webafx-pino';

const destination = new Writable({
  write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  },
});

const logger = new PinoLoggerProvider({
  level: process.env.LOG_LEVEL ?? 'info',
  serviceName: 'appLogger',
  pretty: false,
  redact: [...DEFAULT_REDACT_PATHS, 'user.password'],
  serializers: {
    req: (req: unknown) => req,
    res: (res: unknown) => res,
  },
  pinoOptions: { base: null },
  destination,
});

await logger.info('Fully configured logger');

await logger.shutdown();
```

---

## Error Handling

The package is designed to degrade safely rather than fail loudly: invalid log levels never throw, and the logging methods resolve quietly for valid input. The errors you can actually encounter come from two places — pino rejecting configuration at construction time, and failures on a custom destination. This section covers each case with a pattern you can copy.

### Initialization errors

The `PinoLoggerProvider` constructor builds the pino instance eagerly. If pino rejects a configuration — for example a malformed `redact` path — the constructor throws. When configuration comes from outside your code (environment variables, config files), catch the failure and fall back:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

function createLogger(redactPaths: string[]): PinoLoggerProvider {
  try {
    return new PinoLoggerProvider({ level: 'info', redact: redactPaths });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Invalid logger configuration (${message}); using defaults\n`);
    return new PinoLoggerProvider({ level: 'info' });
  }
}

const logger = createLogger(['user.password']);

await logger.info('Logger created');

await logger.shutdown();
```

### Missing pino-pretty

If `pretty: true` is set but `pino-pretty` is not installed, pino cannot resolve the transport target and fails to start. The fix is either to install the optional peer:

```bash
npm install --save-dev pino-pretty
```

or to leave `pretty` unset — the default is plain JSON output, which needs no extra dependency.

### Destination stream errors

Failures on a custom `destination` are emitted as `'error'` events on the stream; they are not thrown by `info()`, `error()`, `warn()`, or `debug()`. An unhandled `'error'` event crashes the process, so always attach a listener when you supply a destination:

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const destination = new Writable({
  write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  },
});

destination.on('error', (error: Error) => {
  // Keep a logging failure from taking down the process.
  process.stderr.write(`Log destination failed: ${error.message}\n`);
});

const logger = new PinoLoggerProvider({ level: 'info', destination });

await logger.info('Logged to a monitored destination');

await logger.shutdown();
```

### Logging inside try/catch/finally

A complete pattern that logs failures and always flushes before returning:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

async function processOrder(orderId: string): Promise<void> {
  const logger = new PinoLoggerProvider({ level: 'info' });

  try {
    await logger.info('Processing order', { orderId });
    throw new Error('Payment gateway timeout'); // simulated failure
  } catch (error: unknown) {
    await logger.error('Order processing failed', {
      orderId,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await logger.shutdown();
  }
}

await processOrder('order-42');
```

### Error types and their meanings

The package defines no custom error classes; every error originates in pino or in a destination stream:

| Error source | When it occurs | Meaning and handling |
|--------------|----------------|----------------------|
| Constructor `Error` / `TypeError` | `new PinoLoggerProvider(...)` with a configuration pino rejects (e.g., a malformed `redact` path or invalid `serializers`) | Fail-fast on bad configuration. Fix the config, or wrap construction in try/catch and fall back to defaults when the values come from an untrusted source. |
| Transport resolution failure | `pretty: true` without `pino-pretty` installed | The optional peer dependency is missing. Install `pino-pretty`, or disable `pretty` (it is ignored when `destination` is set anyway). |
| Stream `'error'` event | A custom `destination` fails while writing | Emitted on the stream, not thrown by the logging methods. Attach an `'error'` listener as shown above. |
| Unrecognized level string | `level` set to an unknown value (`'verbose'`, `'CRITICAL'`, `''`) | Not an error — `normalizeLevel()` silently falls back to `'info'`, so misconfiguration never crashes startup. |
| Plugin installation failure | `app.setLogger()`, middleware installation, or service registration throws inside the plugin factory | The factory's promise rejects and the failure surfaces through `app.use(...)` during application startup. |

Behaviors that hold by design:

- `info()`, `error()`, `warn()`, and `debug()` never throw for valid input — each resolves after the entry has been handed to the destination
- `health()` resolves `true` (pino writes synchronously and has no failure state)
- `shutdown()` resolves once `pino.flush()` completes — always await it before process exit so buffered entries are not lost

---

## Next Steps

- Overview — what the package is, how it fits together, and when to use it
- Core Concepts — deep dives into every abstraction with reference tables

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
