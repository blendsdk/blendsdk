> **Package**: `blendsdk/webafx-pino`

# webafx-pino Overview

---

## What It Is

`blendsdk/webafx-pino` is the structured logging package for the BlendSDK/WebAFX stack. It adapts **pino** — the fast, JSON-first Node.js logger — behind the BlendSDK `Logger` interface, translating the message-first, async Logger API (`await logger.info(message, data)`, `error()`, `warn()`, `debug()`) into pino's object-first, synchronous calls so that every log entry is a structured JSON record carrying both a message and its contextual fields. The package can be used two ways: **standalone**, by instantiating `PinoLoggerProvider` directly with no WebAFX runtime involvement (the `blendsdk/webafx` import is type-only), or **as a WebAFX plugin**, where `pinoLoggerPlugin()` or `createLoggerPlugin()` replaces the application's default logger via `app.setLogger()`, installs per-request `req.log` middleware on Express, registers the provider in the service container under `'logger'`, and joins the application's health/shutdown lifecycle.

---

## Key Features

- **Structured JSON logging** — every entry is a pino JSON record with `msg`, `level`, and any structured fields passed alongside the message
- **Full BlendSDK `Logger` implementation** — async `info()`, `error()`, `warn()`, `debug()`, each accepting `(message, data?)`
- **Log-level normalization** — accepts `'INFO'`, `'info'`, or mixed case; unrecognized values safely fall back to `'info'` (`normalizeLevel()`)
- **Sensitive data redaction** — `req.headers.authorization` and `req.headers.cookie` are redacted by default; custom `redact` paths override the defaults
- **Development pretty-printing** — colorized output via the optional `pino-pretty` peer when `pretty: true` (ignored when a custom destination is supplied)
- **Custom output destinations** — any `Writable` stream can replace stdout, which enables capturing and parsing entries in tests
- **Raw pino passthrough** — custom `serializers` and `pinoOptions` are forwarded to the pino constructor
- **Request-scoped child loggers** — `createRequestLogger(bindings)` returns a Logger whose every entry includes the given bindings (e.g., `requestId`)
- **WebAFX plugin wiring** — `pinoLoggerPlugin()` (one call) or `createLoggerPlugin(provider)` (provider-first, two-step); installs `req.log` middleware and registers a singleton `'logger'` service
- **Lifecycle participation** — `health()` check and `shutdown()` that flushes buffered entries, exposed as plugin lifecycle hooks
- **Predictable install order** — default plugin priority `20`, so the logger installs before cache and mailer plugins (priority `30`)
- **Escape hatch** — `getPinoInstance()` exposes the underlying pino logger for advanced scenarios (e.g., custom pino-http middleware)
- **Standalone capable** — no runtime dependency on `blendsdk/webafx`; all imports from it are type-only

---

## When To Use

Use `blendsdk/webafx-pino` when:

- **You are adding logging to a WebAFX application** — structured JSON is the right production default, and one call wires everything: `app.use(pinoLoggerPlugin({ level: 'info' }))`
- **You need request correlation** — upstream middleware (e.g., express-request-id) sets `req.id`; the plugin's middleware binds it to `req.log` so every entry of a request carries its `requestId`
- **Secrets must stay out of logs** — Authorization headers and cookies are redacted with zero configuration; additional paths can be added via `redact`
- **You want dev/prod parity** — `pretty: true` for colorized local output and plain JSON in production, from the same code path
- **You need to assert on log output in tests** — pass a `Writable` destination and inspect the parsed JSON entries
- **You are not using WebAFX** — use `PinoLoggerProvider` directly as a standalone, pino-backed implementation of the BlendSDK `Logger` interface

If you only need ad-hoc console output and never parse, ship, or inspect logs, WebAFX's default console logging (which this plugin replaces) may be sufficient.

---

## Architecture

The package is a thin, single-purpose adapter organized into four source modules. The two entry points — standalone construction and the WebAFX plugin — converge on the same provider, which wraps a single pino instance per `PinoLoggerProvider`:

```text
Standalone                       WebAFX plugin
new PinoLoggerProvider(config)   pinoLoggerPlugin(options)
                                 createLoggerPlugin(provider)
        │                                │
        │                                ├─ app.setLogger(provider)
        │                                ├─ req.log middleware (Express)
        │                                ├─ service 'logger' (singleton)
        │                                └─ health / shutdown hooks
        │                                │
        └───────────────┬────────────────┘
                        ▼
                PinoLoggerProvider
        (extends LoggerProvider, implements Logger)
                        │
                        ▼
              pino  →  stdout · pino-pretty · custom Writable
```

### Modules

| Module | Exports | Responsibility |
|--------|---------|----------------|
| `types.ts` | `LoggerProviderConfig`, `PinoLoggerProviderConfig`, `PinoLoggerPluginOptions`, `DEFAULT_SERVICE_NAME`, `DEFAULT_PLUGIN_PRIORITY`, `DEFAULT_REDACT_PATHS` | Configuration contracts and default constants |
| `abstract-logger-provider.ts` | `LoggerProvider` | Abstract base class — implements the `Logger` contract, stores `serviceName`, declares abstract `health()`, `shutdown()`, and `createRequestLogger()` |
| `pino-logger-provider.ts` | `PinoLoggerProvider`, `normalizeLevel` | Concrete pino provider — builds the pino instance, handles redaction/pretty/destination; contains the internal, non-exported `PinoChildLoggerAdapter` |
| `pino-plugin.ts` | `pinoLoggerPlugin`, `createLoggerPlugin` | Plugin factories; augments Express `Request` with optional `id` and `log` members |

### Plugin Installation Flow

When a plugin produced by the factories is installed, its `factory` performs these steps:

1. Calls `app.setLogger(provider)` to replace the application's default logger
2. Installs Express middleware that assigns `req.log = provider.createRequestLogger({ requestId: req.id })` (binding `req.id` only when present)
3. Registers the provider in the service container as a singleton named `'logger'` (or a custom `serviceName`)
4. Returns `health` and `shutdown` hooks for the application lifecycle

### Request-Scoped Loggers

`PinoLoggerProvider.createRequestLogger(bindings)` creates a pino child logger (`pino.child(bindings)`) and wraps it in `PinoChildLoggerAdapter`, an internal adapter that satisfies the `Logger` interface. The child inherits the parent's level, and its bindings merge with any per-call data. This is the mechanism the plugin middleware uses to attach `req.log` with a `requestId`.

### Key Design Patterns

| Pattern | Where | Purpose |
|---------|-------|---------|
| **Adapter** | `PinoLoggerProvider`, `PinoChildLoggerAdapter` | Bridge pino's object-first synchronous API (`logger.info(obj, msg)`) to the BlendSDK message-first async interface (`await logger.info(msg, data)`) |
| **Abstract base class** | `LoggerProvider` | Centralizes the `Logger` contract, `serviceName` handling, and abstract lifecycle methods for concrete providers |
| **Factory** | `pinoLoggerPlugin()`, `createLoggerPlugin()` | Produce `PluginDefinition` objects for `app.use()` — a convenience one-step variant and a provider-first two-step variant |
| **Facade** | Plugin factories | Hide the multi-step WebAFX wiring (setLogger, middleware, service registration, lifecycle hooks) behind a single call |

---

## Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `pino` | ^10.3.1 | Core JSON logging engine — each `PinoLoggerProvider` owns one pino instance plus child loggers |
| `pino-http` | ^11.0.0 | Declared runtime dependency for advanced HTTP-logging scenarios; it is not re-exported by the public API (use `getPinoInstance()` for pino-level access) |

### Peer Dependencies

| Package | Version | Required | Purpose |
|---------|---------|----------|---------|
| `blendsdk/webafx` | 5.x | Yes | Source of the `Logger` and `PluginDefinition` interfaces. Imported with `import type` only — there is no runtime dependency on WebAFX |
| `pino-pretty` | >=11.0.0 | No (optional) | Required only when `pretty: true` is enabled; ignored when a custom `destination` stream is supplied |

### Consumers

This is a leaf integration package — it depends on no other `blendsdk/*` package at runtime. It is consumed by:

- **WebAFX applications** that want structured logging, via `pinoLoggerPlugin()` or `createLoggerPlugin()`
- **Standalone TypeScript services** that want a pino-backed implementation of the BlendSDK `Logger` interface, via `PinoLoggerProvider` directly

### Runtime Requirements

- Node.js >= 22.0.0
- ESM only — `"type": "module"`, with exports providing `import` and `types` entries only (no CommonJS entry point)
- TypeScript 5.x, strict mode

---

## Minimum Example

The shortest complete demonstration: create a provider, log structured data, derive a request-scoped logger with bound context, and shut down cleanly. No WebAFX application is required.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// Works standalone — no WebAFX application required.
const logger = new PinoLoggerProvider({
  level: 'info',
  redact: ['user.password'],
});

// Message first, structured data second.
await logger.info('Server started', { port: 3000 });

// Bind context (e.g., a request ID) to every entry of a child logger.
const requestLogger = logger.createRequestLogger({ requestId: 'req-42' });
await requestLogger.warn('Slow database query', { durationMs: 1500 });

// Flush buffered log entries before exit.
await logger.shutdown();
```

To use the same provider as a WebAFX plugin instead, wrap it with `createLoggerPlugin(provider)` or use the `pinoLoggerPlugin(options)` one-liner — the plugin path is covered in a dedicated document in this training set.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
