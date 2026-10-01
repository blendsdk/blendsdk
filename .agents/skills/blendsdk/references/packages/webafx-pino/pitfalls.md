> **Package**: `blendsdk/webafx-pino`

# webafx-pino Best Practices

Rules of thumb for using `blendsdk/webafx-pino` in production: one provider per process, structured fields over string interpolation, explicit redaction, and a single flush at shutdown. Every recommendation below is tied to a concrete mechanism in the package source.

---

## Do / Don't Pairs

### 1. Keep one provider per application — scope context with child loggers

**❌ Wrong**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// ❌ Wrong: a new provider for every request means a new pino instance
// for every request — duplicated buffers, duplicated transports, and
// providers that are never flushed.
export async function handleRequest(requestId: string): Promise<void> {
  const logger = new PinoLoggerProvider({ level: 'info' });
  await logger.info('handling request', { requestId });
}
```

**✅ Correct**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// ✅ Correct: one provider for the process lifetime.
const logger = new PinoLoggerProvider({ level: 'info' });

export async function handleRequest(requestId: string): Promise<void> {
  // The child logger is the cheap per-request unit.
  const requestLogger = logger.createRequestLogger({ requestId });
  await requestLogger.info('handling request');
}

await handleRequest('req-1');
await logger.shutdown();
```

**Why**: `PinoLoggerProvider` owns exactly one root pino logger, which wraps the destination and — when `pretty: true` is set — the `pino-pretty` worker transport. Constructing a provider per request rebuilds all of that on every call, and those throwaway instances are never shut down, so buffered entries are lost. `createRequestLogger()` takes the opposite approach: it derives a pino child from the shared root, so per-request context such as `requestId` costs almost nothing.

---

### 2. Log structured fields, not interpolated messages

**❌ Wrong**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

const userId = 'user-7';
const itemCount = 3;

// ❌ Wrong: values are baked into the message string — log tooling
// cannot filter, aggregate, or alert on userId or itemCount.
await logger.info(`User ${userId} ordered ${itemCount} items`);

await logger.shutdown();
```

**✅ Correct**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

const userId = 'user-7';
const itemCount = 3;

// ✅ Correct: values become top-level JSON fields; 'Order placed'
// stays a stable, searchable event name.
await logger.info('Order placed', { userId, itemCount });

await logger.shutdown();
```

**Why**: Every entry is serialized as a JSON record with the message in `msg` and each data key as a top-level field. Interpolated strings force downstream tooling to parse free text to recover values, and they change shape whenever the wording changes — breaking dashboards and alerts. Structured fields keep the event name constant and the values machine-queryable.

---

### 3. Always flush with `await shutdown()` before the process exits

**❌ Wrong**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info', pretty: true });

await logger.info('import finished', { rows: 12000 });

// ❌ Wrong: the process exits without flushing — buffered entries can
// be lost before they reach the transport.
process.exit(0);
```

**✅ Correct**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info', pretty: true });

await logger.info('import finished', { rows: 12000 });

// ✅ Correct: shutdown resolves after pino.flush() has drained
// buffered entries.
await logger.shutdown();
process.exit(0);
```

**Why**: `shutdown()` wraps `pino.flush()` and only resolves once buffered log entries have been drained. This matters most with `pretty: true`, where output travels through a worker-thread transport that can still be in flight when the main thread exits. When the provider is installed as a plugin, you do not call `shutdown()` yourself — the plugin returns it as a lifecycle hook that the application invokes during graceful shutdown.

---

### 4. Extend `DEFAULT_REDACT_PATHS` instead of replacing them

**❌ Wrong**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// ❌ Wrong: providing `redact` REPLACES the defaults — the authorization
// and cookie headers are no longer masked.
const logger = new PinoLoggerProvider({
  level: 'info',
  redact: ['user.password'],
});

await logger.info('request received', {
  req: { headers: { authorization: 'Bearer secret-token' } },
});
// ⚠️ req.headers.authorization is written verbatim.

await logger.shutdown();
```

**✅ Correct**

```typescript
import { PinoLoggerProvider, DEFAULT_REDACT_PATHS } from 'blendsdk/webafx-pino';

// ✅ Correct: spread the defaults and append your own paths.
const logger = new PinoLoggerProvider({
  level: 'info',
  redact: [...DEFAULT_REDACT_PATHS, 'user.password', 'req.headers.x-api-key'],
});

await logger.info('request received', {
  req: { headers: { authorization: 'Bearer secret-token' } },
});
// ✅ req.headers.authorization === '[Redacted]', user.password is masked too.

await logger.shutdown();
```

**Why**: The `redact` arrays do not merge — passing `redact: ['user.password']` silently drops the built-in protection for `req.headers.authorization` and `req.headers.cookie`. Spreading `DEFAULT_REDACT_PATHS` keeps the secure-by-default behavior while adding service-specific paths.

---

### 5. Use `req.log` inside request handlers, not a module-level logger

**❌ Wrong**

```typescript
import type { Request, Response } from 'express';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const moduleLogger = new PinoLoggerProvider({ level: 'info' });

// ❌ Wrong: logs through a logger without request bindings — entries from
// concurrent requests cannot be correlated.
export async function handleOrders(req: Request, res: Response): Promise<void> {
  await moduleLogger.info('listing orders');
  res.status(200).json({ orders: [] });
}
```

**✅ Correct**

```typescript
import type { Request, Response } from 'express';

// ✅ Correct: req.log is installed by the plugin middleware with
// { requestId: req.id } bound, so every entry is correlated.
export async function handleOrders(req: Request, res: Response): Promise<void> {
  await req.log?.info('listing orders', { path: req.path });
  res.status(200).json({ orders: [] });
}
```

**Why**: The plugin's middleware assigns `req.log = provider.createRequestLogger({ requestId: req.id })` on every request. Logging through the request-scoped logger puts the `requestId` on every entry automatically; logging through a module-level logger produces entries that cannot be tied back to a specific request when traffic is concurrent.

---

### 6. Gate `pretty` on the environment — never in production

**❌ Wrong**

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

// ❌ Wrong: colorized, human-readable output in production — a worker-thread
// transport that costs throughput and emits lines log pipelines cannot parse.
app.use(pinoLoggerPlugin({ level: 'info', pretty: true }));
```

**✅ Correct**

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const isDevelopment = process.env.NODE_ENV === 'development';

const app = new WebApplication();

// ✅ Correct: colorized output locally, raw JSON everywhere else.
app.use(pinoLoggerPlugin({ level: 'info', pretty: isDevelopment }));
```

**Why**: `pretty: true` attaches the `pino-pretty` transport, which formats every record on a worker thread and requires the optional peer dependency to be installed. Production log aggregation, alerting, and audit pipelines consume JSON records; pretty lines break them. Keep pretty-printing a local development affordance.

---

### 7. Pass errors under the `err` key so stack traces survive

**❌ Wrong**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

try {
  JSON.parse('not-json');
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  // ❌ Wrong: flattening the error to its message discards the stack trace —
  // the most valuable part when debugging a production failure.
  await logger.error('Failed to parse payload', { detail });
}

await logger.shutdown();
```

**✅ Correct**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

try {
  JSON.parse('not-json');
} catch (error) {
  // ✅ Correct: pino recognizes an Error under the `err` key and serializes
  // it with message, type, and stack.
  await logger.error('Failed to parse payload', { err: error });
}

await logger.shutdown();
```

**Why**: Pino special-cases the `err` key and serializes an `Error` instance with its `message`, `type`, and `stack`. Reducing the error to `error.message` beforehand produces a log entry that tells you *what* failed but never *where* — turning every incident into a guessing game.

---

### 8. Keep security-relevant options out of `pinoOptions`

**❌ Wrong**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// ❌ Wrong: `pinoOptions` is spread AFTER the named options, so the
// `redact: []` entry here silently overrides the redaction configuration.
const logger = new PinoLoggerProvider({
  level: 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie'],
  pinoOptions: {
    redact: [],
    name: 'checkout',
  },
});

await logger.shutdown();
```

**✅ Correct**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// ✅ Correct: security-relevant settings stay in their named fields;
// `pinoOptions` only carries additive pino settings.
const logger = new PinoLoggerProvider({
  level: 'info',
  redact: ['req.headers.authorization', 'req.headers.cookie'],
  pinoOptions: {
    name: 'checkout',
    base: null,
  },
});

await logger.shutdown();
```

**Why**: The constructor builds `{ level, redact, serializers, ...pinoOptions }` — `pinoOptions` is spread last and therefore wins every collision. That precedence is convenient for additive settings like `name` or `base: null`, but it turns `pinoOptions` into a silent override channel for `redact` and `level`. Keep those in the named config fields where they are visible and reviewable.

---

## Anti-Patterns

### Anti-Pattern 1: Expecting pretty output when a destination is set

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const capture = new Writable({
  write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  },
});

// ⚠️ `pretty` is silently ignored because `destination` is set.
// The stream receives raw JSON, not colorized output.
const logger = new PinoLoggerProvider({ level: 'info', pretty: true, destination: capture });
```

**Why it bites**: A pino transport (`pino-pretty`) and a custom destination stream are mutually exclusive, so the constructor skips the transport whenever `destination` is present — no error, no warning. If you are capturing output in tests, drop `pretty` and parse the JSON records; if you want readable output locally, do not set a destination.

### Anti-Pattern 2: Treating `normalizeLevel()` as configuration validation

```typescript
import { normalizeLevel } from 'blendsdk/webafx-pino';

// ⚠️ Not validation: 'LOG_LEVEL=verbose' silently becomes 'info'.
const level = normalizeLevel(process.env.LOG_LEVEL ?? 'info');
```

`normalizeLevel()` lowercases and maps, and any unrecognized value — `'verbose'`, `'CRITICAL'`, `''` — falls back to `'info'` instead of throwing. A typo in an environment variable therefore degrades logging silently. Detect the fallback explicitly:

```typescript
import { normalizeLevel, PinoLoggerProvider } from 'blendsdk/webafx-pino';

const requested = process.env.LOG_LEVEL ?? 'info';
const effective = normalizeLevel(requested);

const logger = new PinoLoggerProvider({ level: effective });

if (effective !== requested.toLowerCase()) {
  await logger.warn('Unrecognized log level; falling back to info', { requested, effective });
}
```

### Anti-Pattern 3: Building a child logger per log entry

```typescript
// ⚠️ A child logger per log call — the binding prefix is rebuilt each time
// and the correlation pattern is defeated.
await provider.createRequestLogger({ requestId }).info('one');
await provider.createRequestLogger({ requestId }).info('two');
```

**Why it bites**: `createRequestLogger()` exists to be called once per unit of work. Pino serializes a child's bindings when the child is created; recreating the child for every entry discards that work and makes it easy to drift out of sync with the request's actual bindings. Create the child once and reuse it.

### Anti-Pattern 4: Using `health()` as a real pipeline probe

```typescript
// ⚠️ Always true for PinoLoggerProvider — it cannot detect a failing
// destination, a full disk, or a broken transport.
const healthy = await provider.health();
```

`PinoLoggerProvider.health()` unconditionally resolves `true` because pino writes synchronously and has no meaningful failure state. It participates in lifecycle wiring (the plugin exposes it as a health hook), but it is not evidence that logs are being shipped. Monitor the destination or transport itself for that.

### Anti-Pattern 5: Assuming redaction scans for secrets

```typescript
await logger.info('outbound call', {
  req: { headers: { 'x-api-key': 'live-key-abc123' } },
});
// ⚠️ The default redact paths cover authorization and cookie only —
// x-api-key is written verbatim.
```

**Why it bites**: Redaction masks the configured paths and nothing else — it is not secret detection. Every header, body field, or query parameter outside `DEFAULT_REDACT_PATHS` passes through untouched. Extend the list for each service (see [Security Considerations](#security-considerations)).

### Anti-Pattern 6: Copying the cast-based config overrides from the test helpers

The test suite casts config objects to layer in overrides — that is a test-side convenience, not a pattern for application code. Production configuration is fully typed via `PinoLoggerProviderConfig`:

```typescript
import { PinoLoggerProvider, DEFAULT_REDACT_PATHS, type PinoLoggerProviderConfig } from 'blendsdk/webafx-pino';

const config: PinoLoggerProviderConfig = {
  level: 'info',
  serviceName: 'payments-logger',
  redact: [...DEFAULT_REDACT_PATHS, 'user.password'],
};

const provider = new PinoLoggerProvider(config);
```

**Why it bites**: Casting suppresses exactly the type checking that catches typos like `prety` or a `redact` entry that should have been a named field. Build a typed config object and let the compiler verify it.

---

## Performance Tips

### 1. Guard expensive payloads with `isLevelEnabled()`

The Logger methods receive already-constructed `data` objects — pino's level filter runs *after* your arguments are evaluated. Before assembling a costly payload, check the level through the escape hatch:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });
const pino = logger.getPinoInstance();

function collectDiagnostics(): Record<string, unknown> {
  return { heapUsed: process.memoryUsage().heapUsed, uptime: process.uptime() };
}

// The snapshot is only built when debug output is actually enabled.
if (pino.isLevelEnabled('debug')) {
  await logger.debug('diagnostics snapshot', collectDiagnostics());
}

await logger.shutdown();
```

**Reasoning**: Suppressed entries are cheap inside pino, but the application code that builds their payload is not. `isLevelEnabled()` moves the cost behind the same threshold pino uses.

### 2. Create one child logger per request, not per entry

Pino serializes a child's bindings once, at child creation. Reusing the same child for every entry of a request pays that cost once and reuses the resulting binding prefix; recreating children per entry rebuilds it on every call. This is the performance counterpart of Anti-Pattern 3 — same mechanism, same fix.

### 3. Keep custom destinations lean

Pino hands each record to the destination with a synchronous `write()` call on the logging call path. A destination whose `write()` blocks or does heavy work adds that cost to every log call:

```typescript
import { Writable } from 'node:stream';
import { appendFileSync } from 'node:fs';

// Slow: blocking file I/O runs synchronously inside every log call.
const slowDestination = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    appendFileSync('/var/log/app.jsonl', chunk);
    callback();
  },
});
```

**Reasoning**: The test collector pattern — push the chunk into an array in `write()` — is the cheap end of the spectrum and shows what a destination should do: accept the chunk and return immediately. For production sinks, prefer the default stdout and let an external agent ship the JSON, rather than performing synchronous writes yourself.

### 4. Match the level to the environment

Production should run at `info` (the default). The cost of a level like `trace` is dominated by volume: every enabled entry pays serialization plus destination I/O, and debug-traffic verbosity multiplies that across every request. Keep `trace` and `debug` for diagnosis, and remember that suppressed calls still evaluate their arguments — combine a lower level with the `isLevelEnabled()` guard from Tip 1 when payloads are expensive.

### 5. Flush once — at shutdown, not per entry

`shutdown()` awaits `pino.flush()`, which is a drain operation. Calling it inline in request flow inserts teardown latency into the hot path and can serialize concurrent work behind the drain. Call it exactly once during process teardown — or, with the plugin installed, let the lifecycle hook do it.

---

## Security Considerations

Logs are data-exfiltration waiting to happen: whatever reaches a log file usually travels on to third-party aggregation. The package ships secure defaults, but they cover only the two most common paths — treat everything else as your responsibility.

### Know what the defaults cover

`DEFAULT_REDACT_PATHS` is exactly `['req.headers.authorization', 'req.headers.cookie']`. API keys in other headers, tokens in query strings, passwords in request bodies, and session identifiers are **not** redacted. Extend the list for every service:

```typescript
import { PinoLoggerProvider, DEFAULT_REDACT_PATHS } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({
  level: 'info',
  redact: [
    ...DEFAULT_REDACT_PATHS,
    'req.headers.x-api-key',
    'req.body.password',
    'req.query.token',
  ],
});

await logger.shutdown();
```

### Configure redaction defensively

A custom `redact` array replaces the defaults — always spread `DEFAULT_REDACT_PATHS` when extending it. Never pass `redact` through `pinoOptions`, which is spread after the named options and can silently override it. When redaction paths are composed from multiple configuration sources, verify the final array is non-empty before constructing the provider; an explicit `redact: []` disables redaction entirely.

### Custom serializers widen exposure

`serializers` control what of `req`/`res` reaches the record. A pass-through serializer such as `req: (req: unknown) => req` exposes every header, body field, and query parameter the object contains — and redaction then only masks whatever paths you remembered to list. Keep serializers minimal and confirm that their output fields are covered by your redaction paths.

### Redaction is not secret detection

The `redact` option masks configured paths; it does not recognize secrets. A token logged under an unlisted key ships verbatim. Treat every value you add to `data` as public output — never log credentials deliberately and rely on redaction only as a backstop for the paths you have enumerated.

### Keep JSON output in shared environments

Pretty output is a developer-terminal affordance; it is unstructured and breaks ingestion and audit pipelines that expect JSON records. Gate `pretty` on `NODE_ENV` as shown earlier and keep raw JSON in every shared environment. Since log stores often contain personal data, apply the same access controls to log destinations that you would apply to a database.

### Prefer static event messages

Keep the `msg` string a constant event name (`'Order placed'`) and put variables in structured fields. This keeps parsing stable and avoids handing raw user input to any downstream consumer — such as a `pretty` formatter or plain-text log viewer — that renders log content as text.

---

---

# webafx-pino Testing Patterns

This document describes how to test code built on `blendsdk/webafx-pino`. It mirrors the patterns used by the package's own test suite, which is the source of truth for everything shown here:

- `tests/pino-logger-provider.test.ts` — unit tests for `PinoLoggerProvider`, `normalizeLevel()`, and the exported defaults
- `tests/pino-plugin.test.ts` — unit tests for the shape of `pinoLoggerPlugin()` and `createLoggerPlugin()`
- `tests/pino-plugin.integration.test.ts` — plugin installation verified against a minimal mock of the WebAFX host application

The strategy in one paragraph: **run a real `PinoLoggerProvider` backed by real pino, capture its output through a custom `Writable` destination stream, and assert on the parsed JSON records.** Nothing about pino or the provider ever needs to be mocked. The only boundary that is mocked is the host application — and only when testing plugin *installation*. There are no Docker containers, databases, brokers, or network calls anywhere in this strategy; every test runs in-process.

---

## Test Setup

### Required Imports

| Import | From | Used for |
|--------|------|----------|
| `describe`, `it`, `expect` | `vitest` | Test structure and assertions |
| `afterEach` | `vitest` | Provider cleanup between tests |
| `vi` | `vitest` | Spies and stub loggers |
| `Writable` | `node:stream` | Capturing pino output as parsed JSON records |
| `PinoLoggerProvider` | `blendsdk/webafx-pino` | The provider under test |
| `LoggerProvider` | `blendsdk/webafx-pino` | Base-class `instanceof` checks |
| `normalizeLevel` | `blendsdk/webafx-pino` | Log-level utility tests |
| `createLoggerPlugin`, `pinoLoggerPlugin` | `blendsdk/webafx-pino` | Plugin factory tests |
| `DEFAULT_SERVICE_NAME`, `DEFAULT_PLUGIN_PRIORITY`, `DEFAULT_REDACT_PATHS` | `blendsdk/webafx-pino` | Default-value assertions |
| `type PinoLoggerProviderConfig` | `blendsdk/webafx-pino` | Typing test-helper override objects |
| `type Logger`, `type PluginDefinition` | `blendsdk/webafx` (type-only) | Typing stubs and plugin helpers |

### Test Framework and Scripts

The package runs Vitest with **explicit imports — no globals** — in ESM mode. Every test file imports `describe`, `it`, `expect`, and hooks directly from `vitest`.

| Script | Command | Purpose |
|--------|---------|---------|
| `npm test` | `vitest run --reporter=verbose` | Full single run |
| `npm run test:fast` | `vitest run --reporter=verbose` | Same as `test` — fast, no coverage |
| `npm run test:watch` | `vitest watch --reporter=verbose` | Watch mode during development |
| `npm run test:coverage` | `vitest run --coverage` | Coverage run |

There is no separate integration script — integration specs live in files named `*.integration.test.ts` and are discovered by Vitest's default include pattern alongside the unit specs. A consumer project rarely needs a custom config; if one is desired, a minimal setup looks like this:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

Two conventions to keep in mind:

1. **Inside the package repository**, tests import the source via relative ESM paths with the `.js` extension (`../src/index.js`, `./helpers.js`). **Consumer projects** import the published package (`blendsdk/webafx-pino`). All examples in this document use the consumer-style imports; the patterns are identical.
2. Tests that target logging behavior always supply a `destination` stream. Never rely on stdout.

### Core Test Helpers

These helpers capture pino output and wire up a provider in one call. They are the foundation of every unit test in this document.

```typescript
// tests/test-helpers.ts
import { Writable } from 'node:stream';
import {
  PinoLoggerProvider,
  type PinoLoggerProviderConfig,
} from 'blendsdk/webafx-pino';

/**
 * A parsed pino JSON record as captured from the destination stream.
 * Every entry carries at least `level`, `time`, and `msg`; any fields
 * passed as `data` (plus pino's `pid`/`hostname`) appear as extra keys.
 */
export interface CapturedLogEntry {
  level: number;
  msg: string;
  time: number;
  [key: string]: unknown;
}

/**
 * Writable stream that collects pino output as parsed JSON records.
 * Pass it as `destination` — this is how every log assertion in this
 * package's tests reads output.
 *
 * Supply `TEntry` when a test needs to drill into nested fields,
 * e.g. `entry.req.headers.authorization`.
 */
export function createLogCollector<TEntry = CapturedLogEntry>(): {
  stream: Writable;
  entries: TEntry[];
} {
  const entries: TEntry[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      entries.push(JSON.parse(chunk.toString()) as TEntry);
      callback();
    },
  });
  return { stream, entries };
}

/**
 * Creates a PinoLoggerProvider wired to a fresh log collector.
 * Defaults to level 'trace' so every severity is captured.
 *
 * Note: `destination` is intentionally excluded from the overrides —
 * the helper owns the wiring to the collector stream.
 */
export function createTestProvider<TEntry = CapturedLogEntry>(
  overrides?: Omit<Partial<PinoLoggerProviderConfig>, 'destination'>,
): { provider: PinoLoggerProvider; entries: TEntry[] } {
  const { stream, entries } = createLogCollector<TEntry>();
  const provider = new PinoLoggerProvider({
    level: 'trace',
    destination: stream,
    ...overrides,
  });
  return { provider, entries };
}
```

- `createLogCollector()` returns both the `Writable` (to pass as `destination`) and the live `entries` array (to assert on).
- `createTestProvider()` combines construction and capture. Overrides win over the defaults, so `createTestProvider({ level: 'warn' })` narrows the level while keeping the collector.
- Every example below assumes the imports and `afterEach` cleanup shown next.

### Provider Cleanup Discipline

Each test that creates a provider registers it for shutdown. The `afterEach` hook is **async** because `shutdown()` flushes buffered entries through `pino.flush()`.

```typescript
// In each test file — shared cleanup across all tests in the file
import { afterEach } from 'vitest';
import type { PinoLoggerProvider } from 'blendsdk/webafx-pino';

let activeProvider: PinoLoggerProvider | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
});
```

- Assign `activeProvider = provider;` immediately after creating a provider.
- If a test shuts the provider down itself (e.g. it asserts on `shutdown()` or on the plugin's shutdown hook), set `activeProvider = null;` afterwards to skip the redundant second shutdown.
- If a single test creates more than one provider, track them in an array and shut them all down in `afterEach`.

### Environment Notes

- **No Docker, no external services, no network.** The package has no database, broker, or HTTP dependencies in its tests. Everything is in-memory and synchronous once captured.
- **Raw JSON only.** Tests never enable `pretty: true` — pretty output goes through a worker-thread transport and is not assertable. Always assert against a raw `Writable` destination, which receives one JSON document per log call.
- **Writes are effectively synchronous.** For a raw `Writable` destination, pino writes the JSON line synchronously inside the logging call. After `await provider.info(...)`, the entry is already in the collector — no flush is needed before asserting.
- **`shutdown()` is still mandatory** in `afterEach`: it drains buffered state via `pino.flush()` and prevents stream state from leaking between tests.
- **Level conventions:** `'trace'` captures everything (the `createTestProvider` default); `'silent'` is used when a provider is installed but its output is irrelevant (plugin wiring tests).
- **Fully asynchronous API.** All four Logger methods return `Promise<void>`; there are no synchronous logging calls to test. The synchronous aspect — pino's internal write — is exactly why captured entries are ready right after the awaited call.

---

## Unit Testing

Unit tests exercise the provider through its public `Logger` interface using a real pino instance. Because output is captured as parsed JSON, assertions are plain object checks — no console interception, no mocks.

### Testing the Provider Through the Logger Interface

The canonical unit test: arrange a collector-backed provider, act through the `Logger` API, assert on the parsed record.

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';
import { createTestProvider } from './test-helpers.js';

let activeProvider: PinoLoggerProvider | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
});

describe('PinoLoggerProvider', () => {
  it('writes message, numeric level, and data fields into one JSON record', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    await provider.info('server started', { port: 3000, host: 'localhost' });

    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('server started');
    expect(entries[0].level).toBe(30); // pino numeric level for info
    expect(entries[0].port).toBe(3000);
    expect(entries[0].host).toBe('localhost');
  });
});
```

Numeric levels asserted by the package's tests:

| Logger method | pino level name | Numeric value |
|---------------|-----------------|---------------|
| `debug()` | `debug` | `20` |
| `info()` | `info` | `30` |
| `warn()` | `warn` | `40` |
| `error()` | `error` | `50` |

### Testing Consumer Code That Injects a Logger

Consumer code should depend on the BlendSDK `Logger` interface, not on `PinoLoggerProvider`. That makes the real provider a drop-in test double for production wiring:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import type { Logger } from 'blendsdk/webafx';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';
import { createTestProvider } from './test-helpers.js';

/** Code under test — takes any Logger, so tests can inject the real provider. */
class OrderService {
  constructor(private readonly logger: Logger) {}

  async placeOrder(orderId: string, total: number): Promise<void> {
    await this.logger.info('order placed', { orderId, total });
  }
}

let activeProvider: PinoLoggerProvider | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
});

describe('OrderService', () => {
  it('records placed orders as structured log entries', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    const service = new OrderService(provider);
    await service.placeOrder('order-1', 99);

    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('order placed');
    expect(entries[0].orderId).toBe('order-1');
    expect(entries[0].total).toBe(99);
  });
});
```

### Async Discipline

- **Always `await` Logger calls.** Skipping the `await` still produces output in most cases, but rejects ordering guarantees and hides write errors (e.g. a broken destination).
- **Assertions follow the `await` directly.** With a raw stream destination no flush is required — the captured entry is present as soon as the awaited call resolves.
- **Keep hooks async.** `afterEach` must be `async` and `await provider.shutdown()`.
- **Prefer `async`/`await` over raw promises** in tests, exactly as in the package's own suite.

---

## Integration Testing

Plugin integration tests verify the full installation flow: real `PinoLoggerProvider`, real plugin factories, and a minimal mock of the WebAFX host application. No HTTP server is started — the `req.log` middleware is captured during installation and invoked directly with mock request objects.

### What Is Real vs. Mocked

| Layer | In integration tests |
|-------|----------------------|
| pino engine | **Real** |
| `PinoLoggerProvider` | **Real** (destination = log collector) |
| `createLoggerPlugin()` / `pinoLoggerPlugin()` | **Real** |
| WebAFX `WebApplication` | **Mocked** — `setLogger()`, `registerService()`, `logger` getter |
| Express application | **Mocked** — `use()` records installed middleware |
| HTTP server / network | **Not used** — middleware invoked directly |
| Docker / external services | **None** |

### Integration Helpers

The plugin factory only touches three host members: `app.setLogger()`, `app.registerService()`, and `express.use()`. The mock implements exactly those and records everything the tests assert on.

```typescript
// tests/plugin-helpers.ts
import type { Logger, PluginDefinition } from 'blendsdk/webafx';

// ── Request / response mocks ─────────────────────────────────────────────

export interface MockRequest {
  /** Set by upstream middleware (e.g. express-request-id) before the plugin middleware runs */
  id?: string;
  /** Assigned by the plugin's req.log middleware */
  log?: Logger;
}

export type MockResponse = Record<string, unknown>;

export type MockNextFunction = () => void;

export type Middleware = (
  request: MockRequest,
  response: MockResponse,
  next: MockNextFunction,
) => void;

// ── Host application mock ────────────────────────────────────────────────

export interface RegisteredService {
  name: string;
  type: string;
  factory: () => unknown;
}

export interface MockApplication {
  readonly logger: Logger | null;
  readonly registeredServices: Map<string, RegisteredService>;
  readonly installedMiddlewares: Middleware[];
  setLogger(logger: Logger): void;
  registerService(definition: RegisteredService): void;
}

export interface MockExpress {
  use(middleware: Middleware): void;
}

/**
 * Minimal stand-in for the WebAFX application surface the plugin factory
 * touches: setLogger(), registerService(), and express.use().
 * Everything the integration tests assert on is observable through it.
 */
export function createMockApp(): { mockApp: MockApplication; mockExpress: MockExpress } {
  let currentLogger: Logger | null = null;
  const registeredServices = new Map<string, RegisteredService>();
  const installedMiddlewares: Middleware[] = [];

  const mockExpress: MockExpress = {
    use(middleware: Middleware): void {
      installedMiddlewares.push(middleware);
    },
  };

  const mockApp: MockApplication = {
    get logger(): Logger | null {
      return currentLogger;
    },
    registeredServices,
    installedMiddlewares,
    setLogger(logger: Logger): void {
      currentLogger = logger;
    },
    registerService(definition: RegisteredService): void {
      registeredServices.set(definition.name, definition);
    },
  };

  return { mockApp, mockExpress };
}

// ── Assertion & installation helpers ─────────────────────────────────────

/** Returns the request-scoped logger the plugin middleware must have assigned. */
export function expectRequestLogger(request: MockRequest): Logger {
  if (!request.log) {
    throw new Error('Expected the plugin middleware to assign req.log');
  }
  return request.log;
}

/** Lifecycle hooks that every logger plugin factory returns. */
export interface PluginHooks {
  health(): Promise<boolean>;
  shutdown(): Promise<void>;
}

type PluginFactory = NonNullable<PluginDefinition['factory']>;
type PluginContext = Parameters<PluginFactory>[0];

/**
 * Installs a plugin against the mock host application and returns the
 * lifecycle hooks produced by the factory.
 *
 * The mock implements exactly the members the factory touches, so a
 * single assertion bridges it to the factory's full context type —
 * every test case itself stays fully typed.
 */
export async function installPlugin(
  plugin: PluginDefinition,
  mockApp: MockApplication,
  mockExpress: MockExpress,
): Promise<PluginHooks> {
  const factory = plugin.factory;
  if (!factory) {
    throw new Error('Expected plugin.factory to be defined');
  }

  const context = { app: mockApp, express: mockExpress } as unknown as PluginContext;
  const result = await factory(context);

  if (result && result.health && result.shutdown) {
    return { health: result.health, shutdown: result.shutdown };
  }
  throw new Error('Expected the plugin factory to return health and shutdown hooks');
}
```

Two details worth calling out:

1. The single `as unknown as PluginContext` inside `installPlugin()` is the **only** type assertion in the whole strategy. It exists because the mock intentionally implements a subset of the real host application. Centralizing it here keeps every test case free of casts.
2. `installPlugin()` fails loudly if the factory does not return `health` and `shutdown` hooks — the installation contract is asserted once, not in every test.

### Verifying setLogger, Service Registration, and Lifecycle Hooks

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';
import { createLogCollector } from './test-helpers.js';
import { createMockApp, installPlugin } from './plugin-helpers.js';

describe('plugin installation', () => {
  let activeProvider: PinoLoggerProvider | null = null;

  afterEach(async () => {
    if (activeProvider) {
      await activeProvider.shutdown();
      activeProvider = null;
    }
  });

  it('replaces the application logger via setLogger', async () => {
    const { stream } = createLogCollector();
    const provider = new PinoLoggerProvider({ level: 'silent', destination: stream });
    activeProvider = provider;

    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    await installPlugin(plugin, mockApp, mockExpress);

    expect(mockApp.logger).toBe(provider);
  });

  it('registers the provider as a singleton service named logger', async () => {
    const { stream } = createLogCollector();
    const provider = new PinoLoggerProvider({ level: 'silent', destination: stream });
    activeProvider = provider;

    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    await installPlugin(plugin, mockApp, mockExpress);

    const service = mockApp.registeredServices.get('logger');
    expect(service).toBeDefined();
    expect(service?.type).toBe('singleton');
    expect(service?.factory()).toBe(provider);
  });

  it('registers under the configured serviceName', async () => {
    const { stream } = createLogCollector();
    const provider = new PinoLoggerProvider({
      level: 'silent',
      serviceName: 'appLogger',
      destination: stream,
    });
    activeProvider = provider;

    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    await installPlugin(plugin, mockApp, mockExpress);

    expect(mockApp.registeredServices.get('appLogger')).toBeDefined();
    expect(mockApp.registeredServices.get('logger')).toBeUndefined();
  });

  it('provides lifecycle hooks that delegate to the provider', async () => {
    const { stream } = createLogCollector();
    const provider = new PinoLoggerProvider({ level: 'trace', destination: stream });
    activeProvider = provider;

    const plugin = createLoggerPlugin(provider);
    const { mockApp, mockExpress } = createMockApp();

    const hooks = await installPlugin(plugin, mockApp, mockExpress);

    await expect(hooks.health()).resolves.toBe(true);
    await expect(hooks.shutdown()).resolves.toBeUndefined();

    activeProvider = null; // hook already flushed the provider
  });
});
```

### Verifying the req.log Middleware

The middleware installed during plugin setup is invoked directly with mock request/response objects — the same technique the package's own integration tests use.

```typescript
// Continuing the same test file / describe block
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';
import { expectRequestLogger, type MockRequest, type MockResponse } from './plugin-helpers.js';

it('assigns req.log with a requestId binding and calls next()', async () => {
  const { stream, entries } = createLogCollector();
  const provider = new PinoLoggerProvider({ level: 'trace', destination: stream });
  activeProvider = provider;

  const plugin = createLoggerPlugin(provider);
  const { mockApp, mockExpress } = createMockApp();

  await installPlugin(plugin, mockApp, mockExpress);

  expect(mockApp.installedMiddlewares).toHaveLength(1);

  const request: MockRequest = { id: 'req-abc-123' };
  const response: MockResponse = {};
  let nextCalled = false;

  mockApp.installedMiddlewares[0](request, response, () => {
    nextCalled = true;
  });

  expect(nextCalled).toBe(true);

  const requestLogger = expectRequestLogger(request);
  await requestLogger.info('handling request');

  expect(entries).toHaveLength(1);
  expect(entries[0].msg).toBe('handling request');
  expect(entries[0].requestId).toBe('req-abc-123');
});

it('still assigns req.log when req.id is missing', async () => {
  const { stream, entries } = createLogCollector();
  const provider = new PinoLoggerProvider({ level: 'trace', destination: stream });
  activeProvider = provider;

  const plugin = createLoggerPlugin(provider);
  const { mockApp, mockExpress } = createMockApp();

  await installPlugin(plugin, mockApp, mockExpress);

  const request: MockRequest = {};
  const response: MockResponse = {};
  let nextCalled = false;

  mockApp.installedMiddlewares[0](request, response, () => {
    nextCalled = true;
  });

  expect(nextCalled).toBe(true);

  const requestLogger = expectRequestLogger(request);
  await requestLogger.info('no request id');

  expect(entries).toHaveLength(1);
  expect(entries[0].msg).toBe('no request id');
  expect(entries[0].requestId).toBeUndefined();
});

it('installs through the pinoLoggerPlugin one-liner', async () => {
  const plugin = pinoLoggerPlugin({ level: 'silent' });
  const { mockApp, mockExpress } = createMockApp();

  const hooks = await installPlugin(plugin, mockApp, mockExpress);

  expect(mockApp.logger).toBeInstanceOf(PinoLoggerProvider);

  await expect(hooks.shutdown()).resolves.toBeUndefined();
});
```

Why this level of integration is sufficient: everything below the plugin boundary (pino, the provider, the factory) is real, while everything above it (the host application) is exercised exclusively through `setLogger`, `registerService`, and `express.use` — all fully covered by the mock. Booting a real WebAFX application would add startup complexity without covering an additional branch of this package.

---

## Mocking & Stubbing

### What Not to Mock

- **Don't mock pino or the provider** when the subject under test is logging. The real thing is fast, synchronous, and fully controllable through `destination`; mocking it would only assert your mock.
- **Never module-mock `blendsdk/webafx`.** The package imports it with `import type` only — none of WebAFX executes inside these tests, so there is nothing to replace.
- **Avoid `vi.mock('blendsdk/webafx-pino', ...)`.** Both the provider and the plugin factories are cheap to construct for real. Module mocking hides real behavior (redaction, level filtering, child bindings) that the destination stream exposes for free.

The only legitimate mock boundaries are the **host application** (integration tests) and the **`Logger` interface itself** (consumer code that merely *calls* a logger).

### Stubbing the Logger for Consumer Tests

When consumer code takes a `Logger` and you only care *that* it was called — not about JSON output — a `vi.fn()`-based stub is the right tool. The inferred return type preserves Vitest's mock metadata, so call assertions stay fully typed:

```typescript
// tests/mock-logger.ts
import { vi } from 'vitest';
import type { Logger } from 'blendsdk/webafx';

/**
 * A vi.fn()-based Logger stub. The inferred return type keeps the mock
 * metadata, so assertions like `toHaveBeenCalledWith` are fully typed.
 */
export function createMockLogger() {
  const logger = {
    info: vi.fn(async (_message: string, _data?: Record<string, unknown>): Promise<void> => undefined),
    error: vi.fn(async (_message: string, _data?: Record<string, unknown>): Promise<void> => undefined),
    warn: vi.fn(async (_message: string, _data?: Record<string, unknown>): Promise<void> => undefined),
    debug: vi.fn(async (_message: string, _data?: Record<string, unknown>): Promise<void> => undefined),
  };
  return logger satisfies Logger;
}
```

Using the stub with the same `OrderService` from the Unit Testing section:

```typescript
import { describe, expect, it } from 'vitest';
import type { Logger } from 'blendsdk/webafx';
import { createMockLogger } from './mock-logger.js';

class OrderService {
  constructor(private readonly logger: Logger) {}

  async placeOrder(orderId: string, total: number): Promise<void> {
    await this.logger.info('order placed', { orderId, total });
  }
}

describe('OrderService', () => {
  it('notifies the logger when an order is placed', async () => {
    const logger = createMockLogger();
    const service = new OrderService(logger);

    await service.placeOrder('order-1', 99);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('order placed', { orderId: 'order-1', total: 99 });
  });
});
```

### Spying on a Real Provider

When you want *both* call verification and real captured output, spy on a collector-backed provider. `vi.spyOn` calls through to the original by default, so entries still reach the destination:

```typescript
import { describe, expect, it, afterEach, vi } from 'vitest';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';
import { createTestProvider } from './test-helpers.js';

let activeProvider: PinoLoggerProvider | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
});

describe('OrderService with a real provider', () => {
  it('verifies the call and the emitted entry at the same time', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    const infoSpy = vi.spyOn(provider, 'info');

    const service = new OrderService(provider);
    await service.placeOrder('order-1', 99);

    expect(infoSpy).toHaveBeenCalledWith('order placed', { orderId: 'order-1', total: 99 });
    expect(entries[0].orderId).toBe('order-1'); // real output still captured

    infoSpy.mockRestore();
  });
});
```

Choose between the two approaches deliberately:

| Approach | Use when |
|----------|----------|
| `createMockLogger()` stub | The test is about *whether* the code logs; output shape is irrelevant |
| `vi.spyOn(provider, method)` | You want call verification *and* real JSON output/capture |
| No spy at all | Assertions on `entries` alone already prove the call happened |

### The One Boundary Assertion, Explained

`installPlugin()` in the integration helpers contains the strategy's only type assertion:

```typescript
const context = { app: mockApp, express: mockExpress } as unknown as PluginContext;
```

This is intentional and contained: the mock host implements exactly the members the plugin factory reads (`setLogger`, `registerService`, `express.use`), but not the full `WebApplication` surface. Asserting at this single boundary keeps every test case cast-free — no `any` anywhere — while still invoking the real factory against the real provider.

---

## Test Patterns by Feature

Every example in this section uses the helpers and cleanup conventions introduced in **Test Setup** and tracks `activeProvider` for the shared `afterEach` hook.

### Level Normalization (`normalizeLevel`)

Pure-function tests: valid levels pass through, casing is normalized, unknown values fall back to `'info'`.

```typescript
import { describe, expect, it } from 'vitest';
import { normalizeLevel } from 'blendsdk/webafx-pino';

describe('normalizeLevel', () => {
  it('passes valid lowercase levels through unchanged', () => {
    const validLevels: readonly string[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

    for (const level of validLevels) {
      expect(normalizeLevel(level)).toBe(level);
    }
  });

  it('converts uppercase and mixed-case levels to lowercase', () => {
    expect(normalizeLevel('INFO')).toBe('info');
    expect(normalizeLevel('Debug')).toBe('debug');
    expect(normalizeLevel('ERROR')).toBe('error');
    expect(normalizeLevel('WARN')).toBe('warn');
  });

  it('falls back to info for unrecognized values', () => {
    expect(normalizeLevel('verbose')).toBe('info');
    expect(normalizeLevel('CRITICAL')).toBe('info');
    expect(normalizeLevel('')).toBe('info');
    expect(normalizeLevel('garbage')).toBe('info');
  });
});
```

Normalization also applies at construction time — verify it through behavior, not just construction:

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';
import { createTestProvider } from './test-helpers.js';

let activeProvider: PinoLoggerProvider | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
});

describe('PinoLoggerProvider level handling', () => {
  it('accepts uppercase level configuration', async () => {
    const { provider, entries } = createTestProvider({ level: 'WARN' });
    activeProvider = provider;

    await provider.info('suppressed');
    await provider.warn('visible');

    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('visible');
  });
});
```

### Structured JSON Output

Each Logger call produces exactly one JSON record; `msg` and a numeric `level` are always present, and `data` fields merge at the top level.

```typescript
describe('structured output', () => {
  it('a call without data produces msg and level only', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    await provider.info('hello world');

    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('hello world');
    expect(entries[0].level).toBe(30);
  });

  it('error entries carry numeric level 50 and merged data', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    await provider.error('query failed', { table: 'users', duration: 150 });

    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe(50);
    expect(entries[0].table).toBe('users');
    expect(entries[0].duration).toBe(150);
  });

  it('emits one entry per Logger method with matching numeric levels', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    await provider.debug('d');
    await provider.info('i');
    await provider.warn('w');
    await provider.error('e');

    expect(entries.map((entry) => entry.level)).toEqual([20, 30, 40, 50]);
    expect(entries.map((entry) => entry.msg)).toEqual(['d', 'i', 'w', 'e']);
  });
});
```

### Level Filtering at Runtime

Configure a level, log above and below it, assert on what survived.

```typescript
describe('level filtering', () => {
  it('suppresses everything below the configured level', async () => {
    const { provider, entries } = createTestProvider({ level: 'warn' });
    activeProvider = provider;

    await provider.debug('suppressed');
    await provider.info('suppressed');
    await provider.warn('visible');
    await provider.error('visible');

    expect(entries.map((entry) => entry.msg)).toEqual(['visible', 'visible']);
  });

  it('trace captures every Logger method', async () => {
    const { provider, entries } = createTestProvider({ level: 'trace' });
    activeProvider = provider;

    await provider.debug('d');
    await provider.info('i');
    await provider.warn('w');
    await provider.error('e');

    expect(entries).toHaveLength(4);
  });
});
```

### Sensitive Data Redaction

Redaction assertions are the one place where captured entries need **nested** types. Parameterize the collector via `createTestProvider<TEntry>()` so that `entry.req.headers.authorization` is fully typed without casts.

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';
import { createTestProvider } from './test-helpers.js';

let activeProvider: PinoLoggerProvider | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
});

type DefaultRedactionEntry = {
  req: {
    headers: {
      authorization: string;
      cookie: string;
      'content-type': string;
    };
  };
};

type CustomRedactionEntry = {
  user: { name: string; password: string };
  req: { headers: { authorization: string } };
};

describe('redaction', () => {
  it('redacts authorization and cookie headers by default', async () => {
    const { provider, entries } = createTestProvider<DefaultRedactionEntry>();
    activeProvider = provider;

    await provider.info('request received', {
      req: {
        headers: {
          authorization: 'Bearer super-secret-token',
          cookie: 'session=abc123',
          'content-type': 'application/json',
        },
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].req.headers.authorization).toBe('[Redacted]');
    expect(entries[0].req.headers.cookie).toBe('[Redacted]');
    expect(entries[0].req.headers['content-type']).toBe('application/json');
  });

  it('custom redact paths replace the defaults instead of extending them', async () => {
    const { provider, entries } = createTestProvider<CustomRedactionEntry>({
      redact: ['user.password'],
    });
    activeProvider = provider;

    await provider.info('login attempt', {
      user: { name: 'admin', password: 'secret123' },
      req: { headers: { authorization: 'Bearer visible-now' } },
    });

    expect(entries[0].user.password).toBe('[Redacted]');
    expect(entries[0].user.name).toBe('admin');
    // Authorization is only redacted by the DEFAULT paths — a custom array replaces them.
    expect(entries[0].req.headers.authorization).toBe('Bearer visible-now');
  });

  it('an empty redact array disables redaction entirely', async () => {
    const { provider, entries } = createTestProvider<CustomRedactionEntry>({ redact: [] });
    activeProvider = provider;

    await provider.info('login attempt', {
      user: { name: 'admin', password: 'secret123' },
      req: { headers: { authorization: 'Bearer visible' } },
    });

    expect(entries[0].user.password).toBe('secret123');
    expect(entries[0].req.headers.authorization).toBe('Bearer visible');
  });
});
```

### Request-Scoped Child Loggers

Four behaviors to cover: bindings appear on **every** entry, bindings merge with per-call data, children inherit the parent's level, and children are independent of each other.

```typescript
describe('createRequestLogger', () => {
  it('includes bindings in every entry and merges per-call data', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    const requestLogger = provider.createRequestLogger({
      requestId: 'req-42',
      userId: 'user-7',
    });

    await requestLogger.info('fetching profile', { durationMs: 12 });
    await requestLogger.warn('cache miss');

    expect(entries).toHaveLength(2);
    expect(entries[0].requestId).toBe('req-42');
    expect(entries[0].userId).toBe('user-7');
    expect(entries[0].durationMs).toBe(12);
    expect(entries[0].msg).toBe('fetching profile');
    expect(entries[1].requestId).toBe('req-42');
    expect(entries[1].msg).toBe('cache miss');
  });

  it('children inherit the parent level', async () => {
    const { provider, entries } = createTestProvider({ level: 'warn' });
    activeProvider = provider;

    const requestLogger = provider.createRequestLogger({ requestId: 'test' });
    await requestLogger.debug('suppressed');
    await requestLogger.info('suppressed');
    await requestLogger.warn('visible');

    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('visible');
  });

  it('children are independent of each other', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    const first = provider.createRequestLogger({ requestId: 'req-1' });
    const second = provider.createRequestLogger({ requestId: 'req-2' });
    await first.info('from first');
    await second.info('from second');

    expect(entries).toHaveLength(2);
    expect(entries[0].requestId).toBe('req-1');
    expect(entries[1].requestId).toBe('req-2');
  });

  it('exposes all four Logger methods on children', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    const requestLogger = provider.createRequestLogger({ requestId: 'req-9' });
    await requestLogger.info('i');
    await requestLogger.error('e');
    await requestLogger.warn('w');
    await requestLogger.debug('d');

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.level)).toEqual([30, 50, 40, 20]);
  });
});
```

### Provider Lifecycle (`health`, `shutdown`)

```typescript
describe('lifecycle', () => {
  it('reports healthy', async () => {
    const { provider } = createTestProvider();
    activeProvider = provider;

    await expect(provider.health()).resolves.toBe(true);
  });

  it('shutdown resolves once buffered entries are flushed', async () => {
    const { provider } = createTestProvider();
    activeProvider = provider;

    await expect(provider.shutdown()).resolves.toBeUndefined();

    activeProvider = null; // already shut down — skip the afterEach cleanup
  });
});
```

### Configuration, Defaults, and the pino Escape Hatch

```typescript
import { describe, expect, it, afterEach } from 'vitest';
import {
  PinoLoggerProvider,
  LoggerProvider,
  DEFAULT_SERVICE_NAME,
  DEFAULT_PLUGIN_PRIORITY,
  DEFAULT_REDACT_PATHS,
} from 'blendsdk/webafx-pino';
import { createTestProvider } from './test-helpers.js';

let activeProvider: PinoLoggerProvider | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
});

describe('configuration', () => {
  it('is a LoggerProvider with the default service name', () => {
    const { provider } = createTestProvider();
    activeProvider = provider;

    expect(provider).toBeInstanceOf(LoggerProvider);
    expect(provider.serviceName).toBe(DEFAULT_SERVICE_NAME);
  });

  it('accepts a custom service name', () => {
    const { provider } = createTestProvider({ serviceName: 'audit-logger' });
    activeProvider = provider;

    expect(provider.serviceName).toBe('audit-logger');
  });

  it('exposes the underlying pino instance', () => {
    const { provider } = createTestProvider();
    activeProvider = provider;

    const pinoInstance = provider.getPinoInstance();

    expect(pinoInstance.info).toBeInstanceOf(Function);
    expect(pinoInstance.child).toBeInstanceOf(Function);
  });
});

describe('exported defaults', () => {
  it('DEFAULT_SERVICE_NAME is logger', () => {
    expect(DEFAULT_SERVICE_NAME).toBe('logger');
  });

  it('DEFAULT_PLUGIN_PRIORITY installs before cache and mailer plugins (30)', () => {
    expect(DEFAULT_PLUGIN_PRIORITY).toBe(20);
  });

  it('DEFAULT_REDACT_PATHS covers the authorization and cookie headers', () => {
    expect(DEFAULT_REDACT_PATHS).toContain('req.headers.authorization');
    expect(DEFAULT_REDACT_PATHS).toContain('req.headers.cookie');
  });
});
```

### Plugin Factories (`pinoLoggerPlugin`, `createLoggerPlugin`)

Factory-shape tests never emit output, so no destination or shutdown is needed — a `'silent'` provider is enough to wrap:

```typescript
import { describe, expect, it } from 'vitest';
import {
  PinoLoggerProvider,
  createLoggerPlugin,
  pinoLoggerPlugin,
  DEFAULT_PLUGIN_PRIORITY,
} from 'blendsdk/webafx-pino';

describe('plugin factories', () => {
  it('pinoLoggerPlugin returns the pino-logger definition at the default priority', () => {
    const plugin = pinoLoggerPlugin();

    expect(plugin.name).toBe('pino-logger');
    expect(plugin.factory).toBeInstanceOf(Function);
    expect(plugin.priority).toBe(DEFAULT_PLUGIN_PRIORITY);
  });

  it('createLoggerPlugin wraps an existing provider', () => {
    const provider = new PinoLoggerProvider({ level: 'silent' });
    const plugin = createLoggerPlugin(provider);

    expect(plugin.name).toBe('pino-logger');
    expect(plugin.factory).toBeInstanceOf(Function);
    expect(plugin.priority).toBe(DEFAULT_PLUGIN_PRIORITY);
  });

  it('both factories accept a priority override', () => {
    const provider = new PinoLoggerProvider({ level: 'silent' });

    expect(pinoLoggerPlugin({ priority: 10 }).priority).toBe(10);
    expect(createLoggerPlugin(provider, { priority: 5 }).priority).toBe(5);
  });
});
```

### Plugin Installation and `req.log`

Full installation coverage lives in **Integration Testing** (mock host app + `installPlugin`). When planning that suite, the package's own tests assert exactly these outcomes:

| Scenario | Key assertion |
|----------|---------------|
| Logger replacement | `mockApp.logger` is the provider instance |
| Service registration | `registeredServices.get('logger')` is a singleton whose factory returns the provider |
| Custom `serviceName` | Registered under the custom name, not `'logger'` |
| Middleware installation | Exactly one middleware was passed to `express.use` |
| `req.log` with a request ID | Entry includes `requestId` binding; `next()` was called |
| `req.log` without a request ID | `req.log` is set; no `requestId` field on entries |
| Lifecycle hooks | `health()` resolves `true`; `shutdown()` resolves `undefined` |
| One-liner parity | `pinoLoggerPlugin()` installs a `PinoLoggerProvider` with identical wiring |

---

## Summary

| Testing goal | Pattern | Helper | Key assertion |
|--------------|---------|--------|---------------|
| Log output shape | Real provider + collector | `createTestProvider()` | `entries[0].msg`, `entries[0].level` |
| Level filtering | Configure level, log below/above | `createTestProvider({ level })` | `entries.map((entry) => entry.msg)` |
| Redaction (nested fields) | Generic entry type parameter | `createTestProvider<TEntry>({ redact })` | `entries[0].req.headers.authorization` |
| Child loggers | `createRequestLogger(bindings)` | — | `entries[0].requestId` |
| Consumer calls a logger | Stub the `Logger` interface | `createMockLogger()` | `logger.info` `toHaveBeenCalledWith` |
| Consumer calls + real output | Spy on a real provider | `vi.spyOn(provider, 'info')` | spy called **and** `entries` captured |
| Plugin wiring | Mock host application | `createMockApp()` + `installPlugin()` | `mockApp.logger`, `registeredServices` |
| `req.log` behavior | Invoke captured middleware directly | `expectRequestLogger(req)` | `req.log` set + `requestId` binding |

Pitfalls to avoid:

- Forgetting `await provider.shutdown()` in `afterEach` — flushes and stream state leak between tests otherwise.
- Enabling `pretty: true` in tests — pretty output is a worker-thread transport and is not captured by a destination; always assert raw JSON.
- Asserting against stdout instead of the destination stream — output becomes invisible to the test runner's assertions.
- Using length assertions without controlling the level — the `'trace'` default in `createTestProvider` captures everything by design; pass `level` when counting matters.
- Introducing `any` or module-level mocks — the destination stream and the four-method `Logger` stub cover every real scenario with fully typed code.

---

# webafx-pino Troubleshooting

This document covers the errors, symptoms, and subtle behaviors you are most likely to hit when using `blendsdk/webafx-pino`. Every issue follows the same structure: **Error Message / Symptom → Cause → Fix**, with a complete, runnable code example for each fix. Error texts are quoted as produced by the TypeScript compiler, Node.js, npm, and pino.

---

## Common Errors

Use this table to jump to the right group:

| Error or symptom | Most likely cause |
|------------------|-------------------|
| `TS2307: Cannot find module 'blendsdk/webafx-pino'` | Package not installed, or `moduleResolution` cannot read the `exports` map |
| `ERR_PACKAGE_PATH_NOT_EXPORTED` | Deep import that bypasses the package's `exports` entry (`"."`) |
| `ERR_REQUIRE_ESM` | `require()` from a CommonJS file against an ESM-only package |
| `npm error ERESOLVE` | `blendsdk/webafx` version does not match the exact `5.x` peer pin |
| `Property 'log' does not exist on type 'Request<...>'` | Express `Request` augmentation not loaded, or duplicate `@types/express` |
| `'req.log' is possibly 'undefined'` | Optional member under `strict` null checks |
| `Non-abstract class ... does not implement inherited abstract member` | Subclassing `LoggerProvider` without implementing all abstract members |
| `unable to determine transport target for "pino-pretty"` | Optional peer `pino-pretty` not installed while `pretty: true` is set |
| No output at all | Level filtering (`silent`/`warn`+), lost flush, or wrong output sink |
| Secrets visible in JSON | `redact` replaced the defaults, or the object shape does not match the path |
| `"err":{}` in JSON | `Error` passed under a key other than top-level `err` |
| Raw JSON despite `pretty: true` | A `destination` stream was supplied — the destination wins |

### Module Resolution and Installation Errors

#### `Cannot find module 'blendsdk/webafx-pino' or its corresponding type declarations.` (TS2307)

**Error Message**

```text
error TS2307: Cannot find module 'blendsdk/webafx-pino' or its corresponding type declarations.
```

**Cause**

Two possible causes, often combined:

1. The package (or the `blendsdk/webafx` peer) is not installed.
2. Your `tsconfig.json` uses legacy `"moduleResolution": "node"` (node10). This package publishes **only** an `exports` map (with `types` and `import` entries) and has no root-level `types`/`main` field, so legacy resolution cannot find the type declarations even though the package is installed.

**Fix**

1. Install the package together with its peer.
2. Switch `moduleResolution` to `bundler`, `node16`, or `nodenext` so TypeScript reads the `exports` map.
3. Restart the TypeScript server (`tsc --watch` or your editor's TS integration) after changing `tsconfig.json`.

```bash
npm install blendsdk/webafx-pino@5.x blendsdk/webafx@5.x
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });
await logger.info('package resolved and logger constructed');
await logger.shutdown();
```

---

#### `Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/index.js' is not defined by "exports"` 

**Error Message**

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/index.js' is not defined by "exports"
in /app/node_modules/blendsdk/webafx-pino/package.json
```

**Cause**

The import targets a path that is not listed in the package's `exports` map. `blendsdk/webafx-pino` exports exactly one entry point — `"."` — so any deep path (`./dist/...`, `./src/...`) is rejected by Node's resolver.

**Fix**

Import everything from the package root. The complete public API (`PinoLoggerProvider`, `LoggerProvider`, `normalizeLevel`, `pinoLoggerPlugin`, `createLoggerPlugin`, the config types, and the default constants) is re-exported there.

```typescript
// ✗ Deep path — blocked by the exports map
// import { PinoLoggerProvider } from 'blendsdk/webafx-pino/dist/pino-logger-provider.js';

// ✓ Package root — the only public entry point
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });
await logger.info('imported from the package root');
await logger.shutdown();
```

---

#### `Error [ERR_REQUIRE_ESM]: require() of ES Module ... not supported`

**Error Message**

```text
Error [ERR_REQUIRE_ESM]: require() of ES Module /app/node_modules/blendsdk/webafx-pino/dist/index.js
from /app/server.cjs not supported.
Instead change the require of index.js in /app/server.cjs to a dynamic import() which is available in
all CommonJS modules.
```

**Cause**

`blendsdk/webafx-pino` is **ESM-only**: `"type": "module"` and an `exports` map with only a `types`/`import` condition (no `require` condition). A CommonJS file calling `require('blendsdk/webafx-pino')` cannot load it on Node.js versions that do not support `require(ESM)`.

**Fix**

The clean fix is to consume the package from ESM (`"type": "module"` in your own `package.json`, `import` syntax). When your process must stay CommonJS, load the package with a dynamic `import()` inside an async function — the error message itself recommends this path. Dynamic import is also the portable option across Node.js 22.x versions (recent 22.x releases add `require(ESM)` support, but dynamic import works everywhere this package runs).

```typescript
import type { PinoLoggerProvider } from 'blendsdk/webafx-pino';

export async function createLogger(): Promise<PinoLoggerProvider> {
  // Dynamic import() works from CommonJS; the package itself is ESM-only.
  const { PinoLoggerProvider: Provider } = await import('blendsdk/webafx-pino');
  return new Provider({ level: 'info' });
}
```

---

#### `npm error ERESOLVE unable to resolve dependency tree` (peer `blendsdk/webafx@5.x`)

**Error Message**

```text
npm error ERESOLVE unable to resolve dependency tree
npm error While resolving: checkout-service@1.0.0
npm error Found: blendsdk/webafx@5.x
npm error Could not resolve dependency:
npm error peer blendsdk/webafx@"5.x" from blendsdk/webafx-pino@5.x
```

**Cause**

`blendsdk/webafx-pino` declares an **exact** peer on `blendsdk/webafx@"5.x"` (not a caret range). If your application has a different WebAFX version installed, npm cannot satisfy the peer and aborts the install.

**Fix**

Align both packages to the exact same version. Do **not** paper over the conflict with `--force` or `--legacy-peer-deps`: the `Logger` and `PluginDefinition` interfaces are shared between the two packages and are only guaranteed compatible within the same release.

```bash
npm install blendsdk/webafx@5.x blendsdk/webafx-pino@5.x
# Only if you enable pretty output:
npm install --save-dev pino-pretty
```

```typescript
import { PinoLoggerProvider, DEFAULT_PLUGIN_PRIORITY } from 'blendsdk/webafx-pino';

// Reaching this line means the 5.x peer set resolved correctly.
const logger = new PinoLoggerProvider({ level: 'info' });
await logger.info('dependency tree resolved', { pluginPriority: DEFAULT_PLUGIN_PRIORITY });
await logger.shutdown();
```

---

#### Importing internals: `PinoChildLoggerAdapter` or `CreateLoggerPluginOptions`

**Symptom**

Runtime error when importing a value that is not part of the public API:

```text
SyntaxError: The requested module 'blendsdk/webafx-pino' does not provide an export named 'PinoChildLoggerAdapter'.
```

TypeScript error when importing a type that is not re-exported from the root:

```text
error TS2305: Module '"blendsdk/webafx-pino"' has no exported member 'CreateLoggerPluginOptions'.
```

**Cause**

- `PinoChildLoggerAdapter` is an internal, deliberately unexported class. Request-scoped loggers are only created through `provider.createRequestLogger()`.
- `CreateLoggerPluginOptions` exists in the source, but the package root re-exports only `createLoggerPlugin` and `pinoLoggerPlugin` from the plugin module — not that options interface.
- `pino` and `pino-http` are runtime dependencies that are **not** re-exported at all.

**Fix**

- Type child loggers as the WebAFX `Logger` interface and create them via `createRequestLogger()`.
- Plugin options are structural (`{ priority?: number }`) — pass an object literal; no type import is required.
- For pino-level access (including anything you would want from `pino`/`pino-http`), use `provider.getPinoInstance()`.

```typescript
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';
import type { Logger } from 'blendsdk/webafx';

const provider = new PinoLoggerProvider({ level: 'info' });

// Child loggers come from the factory and are typed as the WebAFX Logger.
// PinoChildLoggerAdapter is internal and must not be imported.
const requestLogger: Logger = provider.createRequestLogger({ requestId: 'req-1' });
await requestLogger.info('request handled');

// Plugin options are structural — pass an object literal, no type import needed.
const plugin = createLoggerPlugin(provider, { priority: 10 });
await provider.info('plugin definition prepared', { name: plugin.name, priority: plugin.priority });

await provider.shutdown();
```

---

### TypeScript Compiler Errors

#### `Property 'log' does not exist on type 'Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>'.` (TS2339)

**Error Message**

```text
error TS2339: Property 'log' does not exist on type 'Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>'.
```

**Cause**

`req.log` (and `req.id`) are contributed by a global Express `Request` augmentation declared inside this package's declaration files. The augmentation only applies when `blendsdk/webafx-pino` is part of the current TypeScript compilation. It is missing when no file in the program imports the package, or when two copies of `@types/express` are installed and the augmentation lands on a different `Request` interface than the one your handler uses.

**Fix**

1. Make sure at least one file in the compilation imports the package — a side-effect import is enough.
2. Verify there is only one copy of the Express typings: `npm ls @types/express`. If duplicates exist, deduplicate (hoist or align versions).

```typescript
import 'blendsdk/webafx-pino'; // loads the Express Request augmentation (req.id, req.log)
import type { Request, Response } from 'express';
import type { Logger } from 'blendsdk/webafx';

export async function handlePing(req: Request, res: Response): Promise<void> {
  const requestLogger: Logger | undefined = req.log;
  await requestLogger?.info('ping received', { path: req.path });
  res.status(200).json({ pong: true });
}
```

---

#### `'req.log' is possibly 'undefined'.` (TS18048)

**Error Message**

```text
error TS18048: 'req.log' is possibly 'undefined'.
```

**Cause**

The augmentation declares `log?: Logger` — optional on purpose, because a route can execute on a request that never passed through the plugin middleware, and the compiler cannot know the middleware ordering of your application.

**Fix**

Use a guard or optional chaining. Both are correct; a guard lets you log unconditionally within the block, optional chaining skips the call entirely.

```typescript
import 'blendsdk/webafx-pino';
import type { Request, Response } from 'express';

export async function handleOrder(req: Request, res: Response): Promise<void> {
  // Guard form: only log when the middleware attached a request logger.
  if (req.log) {
    await req.log.info('order received', { id: req.params.id });
  }

  // Optional-chaining form: skipped entirely when req.log is absent.
  await req.log?.info('order accepted', { status: 202 });

  res.status(202).json({ accepted: true });
}
```

---

#### `Non-abstract class 'X' does not implement inherited abstract member ... from class 'LoggerProvider'.` (TS2515)

**Error Message**

One diagnostic is produced for **each** missing member, for example:

```text
error TS2515: Non-abstract class 'MemoryLogger' does not implement inherited abstract member 'health' from class 'LoggerProvider'.
error TS2515: Non-abstract class 'MemoryLogger' does not implement inherited abstract member 'shutdown' from class 'LoggerProvider'.
error TS2515: Non-abstract class 'MemoryLogger' does not implement inherited abstract member 'createRequestLogger' from class 'LoggerProvider'.
```

**Cause**

`LoggerProvider` declares seven abstract members that every concrete subclass must implement: `info`, `error`, `warn`, `debug`, `health`, `shutdown`, and `createRequestLogger`. Subclassing is only necessary for **custom** providers — for pino logging, instantiate `PinoLoggerProvider` directly instead of subclassing.

**Fix**

Implement all seven members. The example below is a complete, compilable custom provider:

```typescript
import { LoggerProvider, type LoggerProviderConfig } from 'blendsdk/webafx-pino';
import type { Logger } from 'blendsdk/webafx';

export class MemoryLogger extends LoggerProvider {
  private readonly lines: string[] = [];

  constructor(config?: LoggerProviderConfig) {
    super(config);
  }

  async info(message: string, data?: Record<string, unknown>): Promise<void> {
    this.lines.push(`INFO ${message} ${JSON.stringify(data ?? {})}`);
  }

  async error(message: string, data?: Record<string, unknown>): Promise<void> {
    this.lines.push(`ERROR ${message} ${JSON.stringify(data ?? {})}`);
  }

  async warn(message: string, data?: Record<string, unknown>): Promise<void> {
    this.lines.push(`WARN ${message} ${JSON.stringify(data ?? {})}`);
  }

  async debug(message: string, data?: Record<string, unknown>): Promise<void> {
    this.lines.push(`DEBUG ${message} ${JSON.stringify(data ?? {})}`);
  }

  async health(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    this.lines.length = 0;
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

const logger = new MemoryLogger({ serviceName: 'memory' });
await logger.info('no abstract members missing');
await logger.shutdown();
```

---

#### `Object literal may only specify known properties, and 'pretty' does not exist in type 'CreateLoggerPluginOptions'.` (TS2353)

**Error Message**

```text
error TS2353: Object literal may only specify known properties, and 'pretty' does not exist in type 'CreateLoggerPluginOptions'.
```

**Cause**

The second parameter of `createLoggerPlugin(provider, options?)` accepts only `{ priority?: number }`. Provider options such as `pretty`, `level`, `redact`, or `destination` must be given to the **provider** constructor — the plugin factory does not forward them.

**Fix**

Configure the provider first, then pass only plugin-level options to the factory.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

// Provider options belong to the provider…
const provider = new PinoLoggerProvider({ level: 'debug', pretty: true });

// …while the plugin factory accepts only { priority?: number }.
app.use(createLoggerPlugin(provider, { priority: 10 }));
```

---

#### `Types of parameters 'req' and 'req' are incompatible. Type 'unknown' is not assignable to type 'IncomingMessage'.` (TS2322)

**Error Message**

```text
Type '(req: IncomingMessage) => { method: string; url: string; }' is not assignable to type '(req: unknown) => unknown'.
  Types of parameters 'req' and 'req' are incompatible.
    Type 'unknown' is not assignable to type 'IncomingMessage'.
```

**Cause**

The `serializers` option types `req`/`res` callbacks as `(value: unknown) => unknown` so the public API does not leak pino or Express types. Under `strict` (which enables `strictFunctionTypes`), a callback with a **narrower** parameter type (`IncomingMessage`) is not assignable to one that promises to accept `unknown`.

**Fix**

Declare the parameter as `unknown` and narrow it inside the serializer with `typeof`/`in` checks — no casts required.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({
  level: 'info',
  serializers: {
    // Params are typed as unknown by the config type; narrow before using them.
    req: (req: unknown) => {
      if (typeof req === 'object' && req !== null && 'method' in req && 'url' in req) {
        return { method: String(req.method), url: String(req.url) };
      }
      return req;
    },
    res: (res: unknown) => {
      if (typeof res === 'object' && res !== null && 'statusCode' in res) {
        return { statusCode: String(res.statusCode) };
      }
      return res;
    },
  },
});

await logger.info('request completed', { req: { method: 'GET', url: '/orders' } });
await logger.shutdown();
```

---

### Runtime Errors

#### `Error: unable to determine transport target for "pino-pretty"`

**Error Message**

```text
Error: unable to determine transport target for "pino-pretty"
```

The message is printed with a worker-thread stack trace when the pino transport starts (at construction or on the first log call). Log output produced with `pretty: true` is missing.

**Cause**

`pretty: true` makes the provider attach a pino transport with `target: 'pino-pretty'`, which pino loads in a worker thread. `pino-pretty` is an **optional peer dependency** — it is not installed with the package and, under strict package managers (pnpm, some yarn/npm configurations), optional peers are never auto-installed. The worker cannot resolve the target and fails.

**Fix**

1. Install `pino-pretty` (version `>= 11.0.0`; the current major is v13) wherever pretty output is actually used. For development-only prettiness, a dev dependency is enough.
2. If the error appears in production, do the opposite: remove `pretty: true` or route output through a `destination` instead — production pipelines should consume raw JSON.

```bash
npm install --save-dev pino-pretty
```

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// pino-pretty must be resolvable from the application — it is an optional peer dependency.
const logger = new PinoLoggerProvider({ level: 'info', pretty: true });

await logger.info('pretty transport is working', { port: 3000 });
await logger.shutdown();
```

---

#### `TypeError: Cannot read properties of undefined (reading 'info')`

**Error Message**

```text
TypeError: Cannot read properties of undefined (reading 'info')
    at handleHealth (/app/src/routes.ts:12:14)
```

**Cause**

A handler called `req.log.info(...)` but nothing assigned `req.log` for that request. Common reasons:

- The application is plain Express — the `req.log` middleware is installed by the **WebAFX plugin**, so it does not exist unless you add it yourself.
- The plugin was never installed (`app.use(pinoLoggerPlugin(...))` / `app.use(createLoggerPlugin(provider))` is missing).
- In Express, routes and middleware share one stack in registration order: a route registered **before** the logger middleware runs before `req.log` is assigned.

**Fix**

- In a WebAFX application, install the plugin before route-bearing code.
- In plain Express, attach the request-scoped logger yourself, before any route that uses `req.log`.
- Defensively, `req.log?.info(...)` never throws — but optional chaining hides wiring bugs, so fix the ordering first.

```typescript
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const app = express();
const provider = new PinoLoggerProvider({ level: 'info' });

// Plain Express: attach a request-scoped logger before any route that uses req.log.
app.use((req: Request, _res: Response, next: NextFunction) => {
  const bindings: Record<string, unknown> = {};
  if (req.id) {
    bindings.requestId = req.id;
  }
  req.log = provider.createRequestLogger(bindings);
  next();
});

app.get('/health', async (req: Request, res: Response) => {
  await req.log?.info('health check served');
  res.status(200).json({ ok: true });
});
```

---

#### `SyntaxError: Unexpected non-whitespace character after JSON ...` / `SyntaxError: Unexpected end of JSON input`

**Error Message**

```text
SyntaxError: Unexpected non-whitespace character after JSON at position 47
SyntaxError: Unexpected end of JSON input
```

**Cause**

A test or log collector does `JSON.parse(chunk.toString())` per stream write. Stream chunks are **byte boundaries, not record boundaries**: one write may contain several JSON lines concatenated (first error), and a single line may be split across two writes (second error). Per-chunk parsing only works while writes and records happen to align.

**Fix**

Buffer incoming bytes and parse line by line, keeping the trailing partial line until the next chunk (or shutdown) completes it.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const records: Array<Record<string, unknown>> = [];
let pending = '';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function ingest(line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (isRecord(parsed)) {
    records.push(parsed);
  }
}

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? ''; // keep the trailing partial line
    for (const line of lines) {
      ingest(line);
    }
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: 'info', destination: capture });
await logger.info('first record', { n: 1 });
await logger.info('second record', { n: 2 });
await logger.shutdown();

// Flush any trailing partial line after shutdown
if (pending.trim().length > 0) {
  ingest(pending);
}

// records.length === 2
```

---

### Logging Output Problems

#### No output at all (or expected entries missing)

**Symptom**

Logging calls execute without error, but nothing appears — stdout stays empty, or your capture stream receives no records. This is usually observed as "my `debug()` calls never show up".

**Cause**

One or more of the following:

- **Level filtering** — `level: 'warn'`, `'error'`, or `'silent'` suppresses everything below the threshold; `'silent'` suppresses everything.
- **Invalid level string silently falling back to `'info'`** — `normalizeLevel()` maps unrecognized values (including typos like `'verbose'` and whitespace like `'warn '`) to `'info'`, which suppresses `debug`/`trace` output you expected.
- **Missing flush** — in short-lived processes, buffered entries (especially through the `pino-pretty` worker transport) can be lost unless `await logger.shutdown()` runs before the process exits.
- **Wrong sink** — without a `destination`, records go to stdout; if you are tailing a file or watching a collector, you will see nothing.

**Fix**

1. Prove the pipeline end-to-end with the widest level (`trace`) and an in-process capture stream.
2. Resolve the level string you actually configure and check the result before trusting it.
3. Await `shutdown()` in every short-lived process.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider, normalizeLevel } from 'blendsdk/webafx-pino';

// Step 1 — prove that records reach a destination at the widest level.
const captured: string[] = [];
const probe = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    captured.push(chunk.toString());
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: 'trace', destination: probe });

await logger.debug('debug visible');
await logger.info('info visible');
await logger.warn('warn visible');
await logger.error('error visible');
await logger.shutdown();

// captured.length === 4 → the pipeline works; the problem is configuration or flushing.

// Step 2 — check what your configured level string actually resolves to.
normalizeLevel('verbose'); // 'info' — debug and trace output are suppressed
normalizeLevel('SILENT');  // 'silent' — every log call is suppressed
normalizeLevel('warn ');   // 'info' — trailing whitespace defeats the match
```

---

#### Redaction not applied — secrets appear in the JSON output

**Symptom**

Authorization headers, cookies, or passwords appear verbatim in log records even though `redact` was configured (or you expected the defaults to apply).

**Cause**

- **`redact` replaces, never merges** — providing `redact: ['user.password']` removes the default paths (`req.headers.authorization`, `req.headers.cookie`) from protection.
- **Shape mismatch** — `redact: ['req.headers.authorization']` only matches when the logged object nests the secret at exactly `req.headers.authorization`. Logging `{ headers: { ... } }` without the `req` wrapper matches nothing.
- **Message strings are not scanned** — redaction walks object properties only; a secret interpolated into the message is not masked.
- **Misspelled paths** — an incorrect path (wrong casing, wrong key) silently matches nothing and raises no error.
- **`redact: []` disables redaction** — an empty array skips the pino `redact` option entirely.

**Fix**

When adding paths, merge the defaults explicitly:

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider, DEFAULT_REDACT_PATHS } from 'blendsdk/webafx-pino';

const captured: string[] = [];
const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    captured.push(chunk.toString());
    callback();
  },
});

const logger = new PinoLoggerProvider({
  level: 'info',
  destination: capture,
  // ✗ redact: ['user.password'] would REPLACE the defaults and leak headers again.
  // ✓ Merge the built-in paths with your own:
  redact: [...DEFAULT_REDACT_PATHS, 'user.password', 'req.headers.x-api-key'],
});

await logger.info('login', {
  req: { headers: { authorization: 'Bearer secret', cookie: 'session=abc' } },
  user: { name: 'admin', password: 'hunter2' },
});
await logger.shutdown();

// Every sensitive path above is serialized as '[Redacted]'.
```

---

#### Error objects appear as `"err":{}` (message and stack missing)

**Symptom**

```json
{"level":50,"time":1730000000000,"msg":"query failed","error":{}}
```

**Cause**

`Error` instances keep `message`, `stack`, and `name` as **non-enumerable** properties, so JSON serialization emits an empty object for them. Pino only applies its built-in error serializer to a top-level `err` key in the record — an `Error` under any other key (or nested deeper) is serialized as `{}`.

**Fix**

Pass the error under the top-level `err` key of the data object. Because the provider forwards your `data` as pino's merging object, `{ err: failure }` becomes the top-level `err` field and is serialized with `type`, `message`, and `stack`.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    process.stdout.write(chunk);
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: 'info', destination: capture });

const failure = new Error('database unreachable');

// ✗ Error under an arbitrary key → "error":{} in the output
await logger.error('query failed', { error: failure });

// ✓ Error under the top-level 'err' key → { type, message, stack } in the output
await logger.error('query failed', { err: failure, table: 'users' });

await logger.shutdown();
```

---

#### `pretty: true` ignored — output is still raw JSON

**Symptom**

The provider was constructed with `pretty: true`, but the output on the destination (file, capture stream, pipe) is single-line raw JSON instead of colorized text.

**Cause**

When a `destination` is provided, `pretty` is **silently ignored** by design: `pino-pretty` is wired as a pino transport, and a transport cannot be combined with a custom destination stream. The destination wins, and pino writes raw JSON to it. No error or warning is emitted.

**Fix**

Pick one output mode per provider: pretty for human-facing stdout in development, `destination` for programmatic capture or custom sinks in tests and production.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// Human-readable development output: pretty only, no destination.
const devLogger = new PinoLoggerProvider({ level: 'debug', pretty: true });
await devLogger.debug('colorized output on stdout');
await devLogger.shutdown();

// Programmatic capture: a destination is present → raw JSON, pretty ignored.
const lines: string[] = [];
const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    lines.push(chunk.toString().trim());
    callback();
  },
});

const testLogger = new PinoLoggerProvider({ level: 'debug', pretty: true, destination: capture });
await testLogger.debug('captured as JSON');
await testLogger.shutdown();

// lines[0] starts with '{"level":20' — raw JSON, not pretty output.
```

---

## Debugging Strategies

### 1. Capture and inspect raw records

The fastest way to diagnose any logging problem is to make the output inspectable in-process. This is the same technique the package's own test suite uses.

1. Create a `Writable` collector that buffers bytes and parses **line by line** (never per chunk — chunks are not record boundaries).
2. Construct a `PinoLoggerProvider` with `level: 'trace'` and `destination: <collector>` — `trace` guarantees level filtering cannot hide the problem.
3. Exercise the code path under investigation.
4. `await logger.shutdown()` **before** reading the collected records, so buffered entries are flushed.
5. Inspect each record for the expected `msg`, numeric `level`, and structured fields.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const records: Array<Record<string, unknown>> = [];
let pending = '';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function ingest(line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (isRecord(parsed)) {
    records.push(parsed);
  }
}

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      ingest(line);
    }
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: 'trace', destination: capture });

await logger.info('probe', { port: 3000 });
await logger.shutdown();

if (pending.trim().length > 0) {
  ingest(pending);
}

// records[0].msg === 'probe' and records[0].port === 3000
```

### 2. Verify the effective log level

1. Resolve every level string you configure with `normalizeLevel()` and log the resolved value at startup — this surfaces silent fallbacks to `'info'` immediately.
2. If entries are missing, re-run with `level: 'trace'` and the collector from Strategy 1; if all four levels appear there, the loss is caused by level filtering, not by the pipeline.
3. Compare the emitted sequence against the numeric levels you expect (`debug` 20, `info` 30, `warn` 40, `error` 50) to confirm the threshold.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider, normalizeLevel } from 'blendsdk/webafx-pino';

const requestedLevel: string = 'WARNING';
const effectiveLevel: string = normalizeLevel(requestedLevel); // 'info' — typo fell back

const captured: string[] = [];
const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    captured.push(chunk.toString().trim());
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: effectiveLevel, destination: capture });

await logger.debug('debug');
await logger.info('info');
await logger.warn('warn');
await logger.error('error');
await logger.shutdown();

// captured.length === 3 — the typo silently raised verbosity instead of warn-only.
```

### 3. Verify plugin installation end-to-end

1. Boot the application with the plugin installed **once** and `level: 'trace'`.
2. Keep a reference to the provider by using `createLoggerPlugin(provider)` rather than the one-liner `pinoLoggerPlugin()` — then you can log through it and call `getPinoInstance()` while diagnosing.
3. Add a temporary route that logs through `req.log` and echoes whether `req.id` was present.
4. Call the endpoint and check the output: entries must exist, and `requestId` must be bound when upstream middleware set `req.id`.
5. If entries are missing, check (a) the plugin is installed before route-bearing code, (b) the request passed through the logger middleware (`req.log` defined in the handler), (c) request-ID middleware runs **before** the logger middleware.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

// Keep the provider reference: createLoggerPlugin() accepts any LoggerProvider,
// and the reference lets you call getPinoInstance() and shutdown() directly.
const provider = new PinoLoggerProvider({ level: 'trace' });
app.use(createLoggerPlugin(provider));

async function diagnosticHandler(req: Request, res: Response): Promise<void> {
  const hasRequestId: boolean = typeof req.id === 'string';
  await req.log?.info('diagnostic probe', { hasRequestId, path: req.path });
  res.status(200).json({ hasRequestId });
}

// Register diagnosticHandler on a temporary route, call the endpoint,
// then inspect the captured output. During application shutdown, the
// plugin's lifecycle hooks call provider.shutdown() for you.
void diagnosticHandler;
```

### 4. Validate redaction with a probe object

1. Construct a probe object whose **shape matches your real payload** exactly, including the nesting of every sensitive path.
2. Log it with the same `redact` configuration the application uses.
3. Capture the single record and confirm each sensitive path serialized as `'[Redacted]'`.
4. If a path is not masked, check in this order: spelling, object nesting, and whether a custom `redact` array accidentally replaced `DEFAULT_REDACT_PATHS`.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider, DEFAULT_REDACT_PATHS } from 'blendsdk/webafx-pino';

let lastRecord: string = '';
const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    lastRecord = chunk.toString().trim();
    callback();
  },
});

const logger = new PinoLoggerProvider({
  level: 'info',
  destination: capture,
  redact: [...DEFAULT_REDACT_PATHS, 'user.password'],
});

await logger.info('redaction probe', {
  req: { headers: { authorization: 'Bearer secret', cookie: 'session=abc' } },
  user: { password: 'hunter2' },
});
await logger.shutdown();

// lastRecord contains "[Redacted]" for authorization, cookie, and password.
```

### 5. Confirm flushing before exit

1. In every short-lived process (CLI tools, scripts, tests, serverless handlers), ensure `await logger.shutdown()` runs before the process exits — it resolves only after `pino.flush()` drains buffered entries.
2. With the WebAFX plugin, confirm the application actually runs its shutdown phase; the plugin registers `shutdown: () => provider.shutdown()` as a lifecycle hook.
3. To verify the failure mode, run a scratch script with the `shutdown()` call removed and observe that trailing entries can go missing — then restore it.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

await logger.info('this line must reach the destination before the process exits');

// shutdown() resolves after pino.flush() drains buffered entries.
await logger.shutdown();
```

### 6. Isolate TypeScript configuration problems

1. Run `npx tsc --noEmit` to surface the exact diagnostic (TS2307, TS2305, TS2339, TS2353, TS2515 — all documented above).
2. Check that `moduleResolution` understands `exports`: use `bundler`, `node16`, or `nodenext`.
3. Check for duplicate Express typings with `npm ls @types/express`. More than one copy can leave the `req.log`/`req.id` augmentation attached to a different `Request` interface than the one your handlers use — the TS2339 error then persists even though the package is imported.
4. Keep `strict` enabled; the diagnostics in this document assume it, and the package's published types are written for strict consumers.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

```bash
npx tsc --noEmit
npm ls @types/express
```

---

## Known Pitfalls

### `redact` replaces `DEFAULT_REDACT_PATHS` — it does not merge

The moment you pass `redact: ['user.password']`, the built-in protection for `req.headers.authorization` and `req.headers.cookie` is gone. Always spread the defaults explicitly: `redact: [...DEFAULT_REDACT_PATHS, 'user.password']`. An empty array (`redact: []`) disables redaction entirely, because the pino `redact` option is only attached for non-empty arrays.

### Unknown level strings silently fall back to `'info'`

`normalizeLevel()` never throws — `'verbose'`, `'WARNING'`, and even `'warn '` (a stray trailing space from an environment variable) all resolve to `'info'`. A typo therefore changes your effective threshold without any warning: you either see more output than intended or lose `debug`/`trace` output you expected. Validate level strings at boot by echoing `normalizeLevel(input)`.

### `pinoOptions` is spread last and can override any named option

The pino options object is built as `{ level, redact?, serializers?, ...pinoOptions }`. Anything you place in `pinoOptions` — including `level` — silently wins over the named configuration options:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({
  level: 'warn',
  // pinoOptions is spread last: this silently overrides level: 'warn' back to 'debug'
  pinoOptions: { level: 'debug' },
});

await logger.debug('this is emitted because pinoOptions won');
await logger.shutdown();
```

`pinoOptions` is typed as `Record<string, unknown>` on purpose (pino's option types are not part of the public API), so typos inside it are not caught by the compiler either.

### Message strings are never redacted

Redaction walks structured object fields that match configured paths. Secrets interpolated into the message itself — `await logger.info(\`token=${token}\`)` — are written verbatim. Put sensitive values only in structured fields that have a matching `redact` path.

### `req.id` must be set before the logger middleware runs

The plugin middleware reads `req.id` **at request time** and binds `requestId` only when it is present; a missing ID produces no error, just entries without correlation. If your request-ID middleware (e.g., express-request-id) runs after the logger middleware in the Express stack, every request will lack the binding. Register the ID middleware first, then the logger plugin.

### The level is resolved once at construction — there is no runtime setter

`PinoLoggerProvider` normalizes and applies the level in its constructor, and the class exposes no method to change it later. Child loggers created via `createRequestLogger()` inherit the level of the provider that created them. To change verbosity at runtime you must construct a new provider; to change it per environment, drive the config from environment variables resolved at startup.

### `health()` always returns `true`

`PinoLoggerProvider.health()` unconditionally resolves `true` — it is a liveness placeholder for the WebAFX lifecycle, not a probe of the output pipeline. A closed destination stream, a full disk, or a blocklisted pretty transport will not be reported. Monitor your log sink separately if delivery guarantees matter.

### Install the plugin once — and keep the provider reference when you need it

Each call to `pinoLoggerPlugin()` or `createLoggerPlugin()` creates a plugin that, when installed, calls `app.setLogger()`, installs its own `req.log` middleware, and registers a service under the same `'logger'` name. Installing twice means two providers, two middleware layers, and two registrations — the last one wins per request. Also note that `pinoLoggerPlugin()` hides the provider it builds: if you need `getPinoInstance()`, a custom provider, or direct `shutdown()` access, use the provider-first form `createLoggerPlugin(provider)` and keep the variable. And remember that `createLoggerPlugin()` expects a `LoggerProvider` — the raw pino instance from `getPinoInstance()` does not qualify because it lacks `health()`, `shutdown()`, and `createRequestLogger()`.

### Destination streams need error handling and line-aware parsing

A custom `Writable` sink is ordinary Node.js I/O. If it emits `'error'` with no listener, the event goes unhandled and can crash the process; and its `write()` calls receive byte chunks, not log records, so parsers must buffer by line. Handle both:

```typescript
import { Writable } from 'node:stream';

const sink = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    process.stdout.write(chunk);
    callback();
  },
});

// Without an 'error' listener, an I/O failure on the destination becomes
// an unhandled 'error' event and can crash the process.
sink.on('error', (error: Error) => {
  console.error('log destination failed:', error.message);
});
```

### Always `await shutdown()` — and keep `pretty` out of production

Because `shutdown()` is the only flush point (`pino.flush()`), skipping it risks losing trailing entries — especially with the `pino-pretty` worker transport, where buffering is asynchronous. Separately, remember that `pretty: true` produces **non-JSON, colorized** output on stdout: log shippers and aggregation pipelines cannot parse it. Use `pretty` for local development only, and let production run the default raw-JSON path (or a custom `destination`) with an explicit `await logger.shutdown()` before every process exit.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
