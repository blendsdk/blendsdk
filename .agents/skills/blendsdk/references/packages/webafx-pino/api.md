> **Package**: `blendsdk/webafx-pino`

# webafx-pino API Reference

Complete reference of every public class, method, function, type, and constant exported from the package root. All signatures are reproduced exactly from the source code; every example is complete, strict-mode TypeScript using ESM imports. For narrative guidance, see the Overview and Core Concepts.

---

## Public API Summary

| Symbol | Kind | Availability |
|--------|------|--------------|
| `LoggerProvider` | Abstract class | Root export (`src/index.ts`) — `abstract-logger-provider.ts` |
| `PinoLoggerProvider` | Class | Root export (`src/index.ts`) — `pino-logger-provider.ts` |
| `normalizeLevel` | Function | Root export (`src/index.ts`) — `pino-logger-provider.ts` |
| `createLoggerPlugin` | Function | Root export (`src/index.ts`) — `pino-plugin.ts` |
| `pinoLoggerPlugin` | Function | Root export (`src/index.ts`) — `pino-plugin.ts` |
| `LoggerProviderConfig` | Interface (type-only export) | Root export (`src/index.ts`) — `types.ts` |
| `PinoLoggerProviderConfig` | Interface (type-only export) | Root export (`src/index.ts`) — `types.ts` |
| `PinoLoggerPluginOptions` | Interface (type-only export) | Root export (`src/index.ts`) — `types.ts` |
| `CreateLoggerPluginOptions` | Interface (type-only) | Declared in `pino-plugin.ts`; appears in the `createLoggerPlugin()` signature; not re-exported from the package root |
| `DEFAULT_SERVICE_NAME` | Constant | Root export (`src/index.ts`) — `types.ts` |
| `DEFAULT_PLUGIN_PRIORITY` | Constant | Root export (`src/index.ts`) — `types.ts` |
| `DEFAULT_REDACT_PATHS` | Constant | Root export (`src/index.ts`) — `types.ts` |

---

## Classes

### LoggerProvider (abstract class)

> Abstract base class for logger providers. Implements the BlendSDK `Logger` interface and adds provider lifecycle methods (`health()`, `shutdown()`) and request-scoped logger creation (`createRequestLogger()`). Concrete providers translate `Logger` method calls to their underlying logging library. This class has **no runtime dependency** on `blendsdk/webafx` — only the `Logger` type is imported for interface compliance.

```typescript
export abstract class LoggerProvider implements Logger
```

**Implements**: `Logger` — from `blendsdk/webafx` (type-only import)

#### Constructor

```typescript
constructor(config?: LoggerProviderConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `LoggerProviderConfig` | No | — | Base provider configuration. The constructor reads `config.serviceName` and falls back to `DEFAULT_SERVICE_NAME` (`'logger'`) when it is omitted. |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string` (getter) | Service name used for WebAFX service container registration. Read-only; mirrors the protected `_serviceName` field. |
| `_serviceName` | `string` (protected) | Backing field storing the service name; initialized in the constructor. |

#### Methods

Every method below is declared `abstract` — subclasses are required by the compiler to implement all of them.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `info` | `abstract info(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Log an informational message. |
| `error` | `abstract error(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Log an error message. |
| `warn` | `abstract warn(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Log a warning message. |
| `debug` | `abstract debug(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Log a debug message. |
| `health` | `abstract health(): Promise<boolean>` | `Promise<boolean>` | Check the health status of the logger. Stateless loggers return `true`; override when external transports are used. |
| `shutdown` | `abstract shutdown(): Promise<void>` | `Promise<void>` | Gracefully shut down the logger; implementations should flush buffered log entries. |
| `createRequestLogger` | `abstract createRequestLogger(bindings: Record<string, unknown>): Logger` | `Logger` | Create a request-scoped logger that includes `bindings` (e.g., `requestId`) in every log entry. |

#### Example

A complete custom provider that implements every abstract member — the same surface `PinoLoggerProvider` fills with pino.

```typescript
import { LoggerProvider } from 'blendsdk/webafx-pino';
import type { Logger } from 'blendsdk/webafx';

class MemoryLogger extends LoggerProvider {
  private readonly lines: string[] = [];

  async info(message: string, data?: Record<string, unknown>): Promise<void> {
    this.lines.push(`[info] ${message} ${JSON.stringify(data ?? {})}`);
  }

  async error(message: string, data?: Record<string, unknown>): Promise<void> {
    this.lines.push(`[error] ${message} ${JSON.stringify(data ?? {})}`);
  }

  async warn(message: string, data?: Record<string, unknown>): Promise<void> {
    this.lines.push(`[warn] ${message} ${JSON.stringify(data ?? {})}`);
  }

  async debug(message: string, data?: Record<string, unknown>): Promise<void> {
    this.lines.push(`[debug] ${message} ${JSON.stringify(data ?? {})}`);
  }

  async health(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    this.lines.length = 0;
  }

  createRequestLogger(bindings: Record<string, unknown>): Logger {
    const lines = this.lines;
    return {
      async info(message: string, data?: Record<string, unknown>): Promise<void> {
        lines.push(`[info] ${message} ${JSON.stringify({ ...bindings, ...data })}`);
      },
      async error(message: string, data?: Record<string, unknown>): Promise<void> {
        lines.push(`[error] ${message} ${JSON.stringify({ ...bindings, ...data })}`);
      },
      async warn(message: string, data?: Record<string, unknown>): Promise<void> {
        lines.push(`[warn] ${message} ${JSON.stringify({ ...bindings, ...data })}`);
      },
      async debug(message: string, data?: Record<string, unknown>): Promise<void> {
        lines.push(`[debug] ${message} ${JSON.stringify({ ...bindings, ...data })}`);
      },
    };
  }
}

const logger = new MemoryLogger({ serviceName: 'audit-logger' });

await logger.info('provider ready', { serviceName: logger.serviceName });

const requestLogger = logger.createRequestLogger({ requestId: 'req-1' });
await requestLogger.warn('bound context', { attempt: 3 });

await logger.shutdown();
```

---

### PinoLoggerProvider

> Concrete `LoggerProvider` implementation backed by pino. Adapts pino's object-first, synchronous API to the BlendSDK message-first, async API. Supports structured JSON logging, log level normalization, redaction, pretty-printing, custom destinations, custom serializers, and request-scoped child loggers. Usable standalone (no WebAFX required) or as a WebAFX plugin via `createLoggerPlugin()` / `pinoLoggerPlugin()`.

```typescript
export class PinoLoggerProvider extends LoggerProvider
```

**Extends**: `LoggerProvider`
**Implements**: `Logger` (inherited from `LoggerProvider`)

#### Constructor

```typescript
constructor(config?: PinoLoggerProviderConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `PinoLoggerProviderConfig` | No | — | Full configuration: `level`, `serviceName`, `pretty`, `redact`, `serializers`, `pinoOptions`, `destination`. |

The constructor runs a fixed pipeline:

1. `super(config)` — initializes `serviceName` (default `'logger'`).
2. Normalizes the level: `normalizeLevel(config?.level ?? 'info')`.
3. Resolves redact paths: `config?.redact ?? DEFAULT_REDACT_PATHS`. The pino `redact` option is only attached when the resolved array is non-empty.
4. Builds pino options: `{ level, redact?, serializers?, ...config?.pinoOptions }`. `pinoOptions` is spread **last**, so it can override any named option.
5. If `pretty` is `true` **and** no `destination` is set, attaches the `pino-pretty` transport (`{ target: 'pino-pretty', options: { colorize: true } }`). When a destination is provided, `pretty` is ignored.
6. Creates the pino instance: `pino(pinoOpts, config.destination)` when a destination is given, otherwise `pino(pinoOpts)` (stdout).

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `serviceName` | `string` (getter; inherited) | Service-container registration name; default `'logger'`. |
| `pino` | pino `Logger` (private readonly) | The underlying pino logger instance. Not directly accessible — use `getPinoInstance()` or `createRequestLogger()`. |

#### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `info` | `(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Emits a pino record at level `30`. Calls `pino.info(data, message)` when `data` is supplied, otherwise `pino.info(message)`. |
| `error` | `(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Emits a pino record at level `50`. Object-first translation identical to `info`. |
| `warn` | `(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Emits a pino record at level `40`. Object-first translation identical to `info`. |
| `debug` | `(message: string, data?: Record<string, any>): Promise<void>` | `Promise<void>` | Emits a pino record at level `20`. Object-first translation identical to `info`. |
| `health` | `(): Promise<boolean>` | `Promise<boolean>` | Always resolves `true` — pino writes synchronously and has no meaningful failure state. |
| `shutdown` | `(): Promise<void>` | `Promise<void>` | Resolves after `pino.flush()` has drained buffered log entries. |
| `createRequestLogger` | `(bindings: Record<string, unknown>): Logger` | `Logger` | Creates `pino.child(bindings)` wrapped in the internal `PinoChildLoggerAdapter`. Child entries merge `bindings` with per-call data and inherit the parent's level. |
| `getPinoInstance` | `(): PinoLogger` | pino `Logger` | Returns the raw pino logger for advanced scenarios (e.g., creating pino-http middleware or using pino-specific features). |

`PinoLogger` in the tables above is pino's own `Logger` type, imported in the source as `import type { Logger as PinoLogger } from 'pino'`.

#### Example

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

const logger = new PinoLoggerProvider({
  level: 'INFO',              // normalized to 'info'
  serviceName: 'appLogger',
  redact: ['user.password'],  // replaces the default redact paths
  destination: capture,       // JSON goes to the stream instead of stdout
  pinoOptions: { name: 'orders-api' },
});

await logger.info('Server started', { port: 3000 });
// records[0]: { level: 30, msg: 'Server started', port: 3000, name: 'orders-api', ... }

const requestLogger = logger.createRequestLogger({ requestId: 'req-42' });
await requestLogger.warn('Slow query', { durationMs: 1500 });
// records[1]: { level: 40, requestId: 'req-42', msg: 'Slow query', durationMs: 1500, ... }

const raw = logger.getPinoInstance();
raw.info('Written via the raw pino instance');
// records[2]: { level: 30, msg: 'Written via the raw pino instance', ... }

await logger.shutdown();
```

---

## Functions

### normalizeLevel

```typescript
export function normalizeLevel(level: string): string
```

Normalizes a log level string to a valid pino level. Lowercases the input and validates it against the pino level set — `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. Unrecognized values fall back to `'info'` rather than throwing. Applied automatically inside the `PinoLoggerProvider` constructor.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `level` | `string` | Yes | — | Log level in any casing — `'INFO'`, `'Info'`, `'info'`. |

**Returns**: `string` — the lowercase pino level, or `'info'` when the input is not a recognized level.

Mapping behavior:

| Input | Returns | Reason |
|-------|---------|--------|
| `'info'` | `'info'` | Valid level passes through |
| `'INFO'` / `'Info'` | `'info'` | Lowercased, then matched |
| `'DEBUG'` | `'debug'` | Lowercased, then matched |
| `'warn'` | `'warn'` | Valid level passes through |
| `'silent'` | `'silent'` | Valid level passes through |
| `'verbose'` | `'info'` | Not a pino level — safe fallback |
| `'CRITICAL'` | `'info'` | Not a pino level — safe fallback |
| `''` | `'info'` | Not a pino level — safe fallback |

**Example**

```typescript
import { normalizeLevel } from 'blendsdk/webafx-pino';

const fromUppercase: string = normalizeLevel('INFO');  // 'info'
const fromMixed: string = normalizeLevel('Debug');     // 'debug'
const passthrough: string = normalizeLevel('warn');    // 'warn'
const fallback: string = normalizeLevel('verbose');    // 'info' — safe default

console.log(fromUppercase, fromMixed, passthrough, fallback);
```

---

### createLoggerPlugin

```typescript
export function createLoggerPlugin(
  provider: LoggerProvider,
  options?: CreateLoggerPluginOptions,
): PluginDefinition
```

Creates a WebAFX plugin definition from **any** `LoggerProvider`. Two-step API: construct the provider first, then wrap it in a plugin. Because it accepts any `LoggerProvider` subclass — not just the pino provider — it is the extensibility point for wiring custom providers into the identical WebAFX lifecycle.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `provider` | `LoggerProvider` | Yes | — | The provider instance to install (e.g., `PinoLoggerProvider`, or any custom `LoggerProvider` subclass). |
| `options` | `CreateLoggerPluginOptions` | No | — | Plugin-level options. Only `priority` is supported; defaults to `DEFAULT_PLUGIN_PRIORITY` (`20`). |

**Returns**: `PluginDefinition` (from `blendsdk/webafx`) — with the following members:

| Member | Type | Description |
|--------|------|-------------|
| `name` | `string` | Plugin identifier: `'pino-logger'`. |
| `priority` | `number` | `options?.priority ?? DEFAULT_PLUGIN_PRIORITY` — lower numbers install first. |
| `factory` | `(context) => Promise<{ health: () => Promise<boolean>; shutdown: () => Promise<void> }>` | Async installer. The context provides `app` (the WebAFX application), `express` (the underlying Express application), and `logger` (the current application logger); this factory consumes `app` and `express`. |

**Installation steps** — the `factory` performs these steps during plugin installation:

1. Calls `app.setLogger(provider)` to replace the application's default logger (e.g., `ConsoleLogger`).
2. Installs request-scoped `req.log` middleware on the Express application: it builds `bindings` from `req.id` (only when present, as `{ requestId: req.id }`), assigns `req.log = provider.createRequestLogger(bindings)`, and calls `next()`.
3. Registers the provider in the service container: `app.registerService({ name: provider.serviceName, type: 'singleton', factory: () => provider })`.
4. Returns lifecycle hooks: `{ health: () => provider.health(), shutdown: () => provider.shutdown() }`.

**Example**

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

// Step 1 — construct and configure any LoggerProvider yourself…
const provider = new PinoLoggerProvider({
  level: 'debug',
  serviceName: 'appLogger',
});

// Step 2 — wrap it in a plugin definition and install it.
app.use(createLoggerPlugin(provider, { priority: 10 }));
```

---

### pinoLoggerPlugin

```typescript
export function pinoLoggerPlugin(options?: PinoLoggerPluginOptions): PluginDefinition
```

One-call convenience function: constructs a `PinoLoggerProvider` from `options` and delegates to `createLoggerPlugin(provider, { priority: options?.priority })`. Every option other than `priority` is forwarded to the provider constructor.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options` | `PinoLoggerPluginOptions` | No | — | Combined provider options (`level`, `serviceName`, `pretty`, `redact`, `serializers`, `pinoOptions`, `destination`) plus the plugin-only `priority`. |

**Returns**: `PluginDefinition` — identical shape to the definition returned by `createLoggerPlugin()`: `name` is `'pino-logger'`, `priority` is `options?.priority ?? DEFAULT_PLUGIN_PRIORITY` (`20`), and the async `factory` performs `app.setLogger()`, `req.log` middleware installation, singleton service registration, and returns the `health` / `shutdown` lifecycle hooks.

**Example**

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

// One call: constructs a PinoLoggerProvider and installs it as a plugin.
app.use(
  pinoLoggerPlugin({
    level: 'info',
    pretty: true, // requires the optional pino-pretty peer dependency
    priority: 10, // install earlier than the default 20
  }),
);
```

---

## Types & Interfaces

All configuration interfaces are exported as **type-only** exports from the package root. Import them with `import type { ... }` or use inline `type` modifiers.

### LoggerProviderConfig

Base configuration shared by any logger provider. Concrete providers extend it with implementation-specific options.

```typescript
interface LoggerProviderConfig
```

| Property | Type | Description |
|----------|------|-------------|
| `level` | `string` (optional) | Log level — accepts both uppercase (`'INFO'`) and lowercase (`'info'`). Mapped internally to pino's lowercase format. Default: `'info'`. |
| `serviceName` | `string` (optional) | Service name for the WebAFX service container. Default: `'logger'`. |

### PinoLoggerProviderConfig

Extends `LoggerProviderConfig` with pino-specific options. Inherits `level` and `serviceName` from the base.

```typescript
interface PinoLoggerProviderConfig extends LoggerProviderConfig
```

| Property | Type | Description |
|----------|------|-------------|
| `pretty` | `boolean` (optional) | Enable pretty-printed output for development. Requires `pino-pretty` (optional peer dependency, `>=11.0.0`). Ignored when `destination` is set. Default: `false`. |
| `redact` | `string[]` (optional) | Paths to redact from log output; matched fields are replaced with `'[Redacted]'`. When provided, **replaces** `DEFAULT_REDACT_PATHS` entirely (arrays are not merged); `[]` disables redaction. Default: `DEFAULT_REDACT_PATHS`. |
| `serializers` | `{ req?: (req: unknown) => unknown; res?: (res: unknown) => unknown }` (optional) | Custom pino serializers for request and response objects. Controls what data from `req` / `res` is included in log entries. |
| `pinoOptions` | `Record<string, unknown>` (optional) | Additional pino options passed directly to the `pino()` constructor. Spread **last** in the options object, so it can override named options (`level`, `redact`, `serializers`, `transport`). |
| `destination` | `import('node:stream').Writable` (optional) | Custom destination stream for pino output. Replaces stdout and disables `pretty`. Useful for testing (capture output) and custom transports. |

### PinoLoggerPluginOptions

Extends `PinoLoggerProviderConfig` with the plugin priority. Used by `pinoLoggerPlugin()`. Inherits all properties of `PinoLoggerProviderConfig`.

```typescript
interface PinoLoggerPluginOptions extends PinoLoggerProviderConfig
```

| Property | Type | Description |
|----------|------|-------------|
| `priority` | `number` (optional) | Plugin priority override. Lower numbers install first. Default: `20` (`DEFAULT_PLUGIN_PRIORITY`) — installs before the cache and mailer plugins (priority `30`). |

### CreateLoggerPluginOptions

Used as the `options` parameter of `createLoggerPlugin()`.

> **Availability note**: This interface is declared and exported in `src/pino-plugin.ts` but is **not** re-exported from the package root, so it cannot be imported from `'blendsdk/webafx-pino'`. When you need to name it, obtain it via `Parameters<typeof createLoggerPlugin>[1]`.

```typescript
interface CreateLoggerPluginOptions
```

| Property | Type | Description |
|----------|------|-------------|
| `priority` | `number` (optional) | Plugin priority override. Lower numbers install first. Default: `20` (`DEFAULT_PLUGIN_PRIORITY`). |

**Example — all configuration types together**

```typescript
import {
  DEFAULT_REDACT_PATHS,
  type LoggerProviderConfig,
  type PinoLoggerProviderConfig,
  type PinoLoggerPluginOptions,
} from 'blendsdk/webafx-pino';

// Base configuration — accepted by any LoggerProvider.
const baseConfig: LoggerProviderConfig = {
  level: 'INFO',
  serviceName: 'appLogger',
};

// Pino-specific configuration — everything PinoLoggerProvider accepts.
const pinoConfig: PinoLoggerProviderConfig = {
  ...baseConfig,
  pretty: false,
  redact: DEFAULT_REDACT_PATHS,
  serializers: {
    req: (req: unknown) => req,
    res: (res: unknown) => res,
  },
  pinoOptions: { base: null }, // drop pid/hostname from every record
};

// Plugin configuration — provider options plus a priority override.
const pluginConfig: PinoLoggerPluginOptions = {
  ...pinoConfig,
  priority: 10,
};

console.log(pluginConfig.level, pluginConfig.priority);
```

---

## Constants

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| `DEFAULT_SERVICE_NAME` | `string` | `'logger'` | Default service name for the logger in the WebAFX service container. Used when no `serviceName` is provided. |
| `DEFAULT_PLUGIN_PRIORITY` | `number` | `20` | Default plugin priority. Set to `20` to install the logger **before** the cache and mailer plugins (priority `30`), so the logger is available to them. |
| `DEFAULT_REDACT_PATHS` | `string[]` | `['req.headers.authorization', 'req.headers.cookie']` | Default paths redacted from log output. Applied whenever `redact` is omitted; providing `redact` replaces this list entirely. |

All three constants are regular (value) exports available from the package root.

---

## Global Type Augmentation: Express.Request

The plugin module declares a global augmentation of the Express `Request` interface. Once the package's types are part of your TypeScript compilation (any import from `blendsdk/webafx-pino`), Express handlers see two additional optional members:

```typescript
declare global {
  namespace Express {
    interface Request {
      id?: string;
      log?: Logger;
    }
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string \| undefined` | Request ID set by upstream middleware (e.g., express-request-id). The plugin middleware binds it as the `requestId` field when present. |
| `log` | `Logger \| undefined` | Request-scoped logger assigned by the plugin middleware, with the request bindings attached to every entry. |

Because both members are optional, narrow or guard before use in handlers (e.g., `await req.log?.info('handled', { path: req.path });`).

---

## Internal Symbols (Not Exported)

These exist in the implementation but are not part of the public API. They are listed so the exported surface is unambiguous.

| Symbol | Module | Description |
|--------|--------|-------------|
| `PinoChildLoggerAdapter` | `pino-logger-provider.ts` | Internal class implementing `Logger` that wraps a pino child logger. Instances are returned by `createRequestLogger()`; the class itself is not exported. |
| `VALID_PINO_LEVELS` | `pino-logger-provider.ts` | Module-private `Set` of the seven valid pino levels (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) used by `normalizeLevel()`. |

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
