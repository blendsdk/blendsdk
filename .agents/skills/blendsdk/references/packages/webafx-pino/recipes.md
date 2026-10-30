> **Package**: `blendsdk/webafx-pino`

# webafx-pino Advanced Patterns

This document covers composition patterns for `blendsdk/webafx-pino` — ways to combine the provider, plugin factories, request-scoped loggers, redaction, custom streams, and lifecycle hooks to solve production problems. Each pattern states when to use it, shows a complete TypeScript example, explains the value, and lists caveats. For first steps see Basic Usage; for the underlying abstractions see Core Concepts and the Overview.

| # | Pattern | Use it when you need to… | Combines |
|---|---------|--------------------------|----------|
| 1 | Two-step plugin wiring | keep a provider reference for the whole app, or control service name and install order | `PinoLoggerProvider` + `createLoggerPlugin` |
| 2 | End-to-end request correlation | trace every log line back to the request that produced it | plugin `req.log` middleware + `createRequestLogger` + Express augmentation |
| 3 | Logger injection into services | decouple domain code from pino and make it testable | `Logger` interface + request-scoped children |
| 4 | Environment-driven configuration | run one codebase as pretty dev output and JSON in production | `normalizeLevel` + `pretty` + `pinoOptions` + `destination` |
| 5 | Test harness capture | assert on structured log output in unit and integration tests | `destination` + `Writable` collector + `shutdown()` |
| 6 | Application-level redaction | keep secrets out of records beyond the default headers | `DEFAULT_REDACT_PATHS` + `redact` + `serializers` |
| 7 | Custom provider via plugin | add audit, sampling, or buffering around every log line | `LoggerProvider` + `PinoLoggerProvider` + `createLoggerPlugin` |
| 8 | Graceful shutdown and health | flush buffered entries on `SIGTERM` in standalone processes | `health()` + `shutdown()` + flush semantics |
| 9 | Raw pino escape hatch | share one pino instance with pino-native libraries | `getPinoInstance()` + `child()` |

---

## Pattern 1: Two-Step Plugin Wiring for Full Control

### When to Use It

Use the two-step form — construct a `PinoLoggerProvider` first, then wrap it with `createLoggerPlugin(provider, options?)` — whenever you need the provider instance to outlive the `app.use(...)` call: to log during bootstrap, to register it under a custom service name, to share it with code constructed outside WebAFX, or to install it earlier than the default priority. The `pinoLoggerPlugin(options)` one-liner is the right choice only when none of those apply.

### Before and After

**Before — one-liner, no handle on the provider:**

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();
app.use(pinoLoggerPlugin({ level: 'info' }));

// Limitation: the provider was constructed inside pinoLoggerPlugin().
// There is no reference to log with during bootstrap, to share with
// non-WebAFX code, or to register under a custom service name.
```

**After — provider first, then the plugin:**

```typescript
import { WebApplication } from 'blendsdk/webafx';
import {
  PinoLoggerProvider,
  createLoggerPlugin,
  normalizeLevel,
} from 'blendsdk/webafx-pino';

/**
 * Bootstrap with full control over logger identity, level, and install order.
 * Returns both the app and the provider so callers can keep logging during
 * startup and pass the provider to non-WebAFX code.
 */
function createApp(): { app: WebApplication; logger: PinoLoggerProvider } {
  const app = new WebApplication();

  const logger = new PinoLoggerProvider({
    level: normalizeLevel(process.env.LOG_LEVEL ?? 'info'),
    serviceName: 'appLogger',
  });

  // priority 5 → installs before the default (20) and before cache/mailer (30)
  app.use(createLoggerPlugin(logger, { priority: 5 }));

  return { app, logger };
}

const { logger } = createApp();

// Log during bootstrap, before any plugin runs.
await logger.info('application created', { serviceName: logger.serviceName });

// Other BlendSDK plugins (cache and mailer, priority 30) install after the
// logger, so their initialization can already use the pino-backed logger.
// WebAFX invokes the plugin's shutdown hook on termination, which flushes
// this same provider — no manual shutdown call needed here.
```

During installation, the plugin performs the same four steps regardless of which factory produced it: `app.setLogger(provider)`, install the `req.log` Express middleware, register the provider as a singleton under `provider.serviceName`, and return `{ health, shutdown }` hooks for the application lifecycle.

### Why It Matters

The two-step form turns the logger into a first-class application dependency instead of an install-time side effect:

- You can log **before** the application finishes wiring and **after** it shuts down, which matters for startup diagnostics.
- The `serviceName` option becomes usable — the provider is registered in the service container under that name, so container-managed services can depend on it.
- The `priority` override (default `DEFAULT_PLUGIN_PRIORITY`, `20`) makes the install order relative to other plugins explicit. Cache and mailer plugins sit at priority `30`; the logger must come first so their initialization can log.
- Keeping the provider reference is also what enables Pattern 9 (sharing the raw pino instance).

### Caveats and Performance Considerations

- The plugin produced by either factory is always named `'pino-logger'` — identity of the wrapped provider does not change that.
- Lower numbers install first. Raise or lower the priority deliberately; an unnecessary override just obscures the ordering.
- Wire exactly one logger plugin per application. Two plugins (or two providers with the same `serviceName`) would fight over `app.setLogger()` and the container registration.
- Keep the provider at the composition root. Passing it deep into modules recreates the pino coupling that the `Logger` interface exists to avoid — prefer Pattern 3 for that.

---

## Pattern 2: End-to-End Request Correlation

### When to Use It

Use this pattern when every log line must be attributable to the request that produced it. The plugin's middleware already does the hard part: for every request it builds bindings from `req.id` (when upstream middleware such as express-request-id has set it) and assigns `req.log = provider.createRequestLogger(bindings)`. Handlers, services, and error paths then log through `req.log` and inherit the `requestId` automatically.

### Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Logger } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';

// ── Application setup ────────────────────────────────────────────────────
const app = new WebApplication();
const logger = new PinoLoggerProvider({ level: 'info' });
app.use(createLoggerPlugin(logger));

// Upstream request-id middleware (e.g., express-request-id) must run before
// the plugin's middleware and set `req.id`; the plugin binds it as
// `requestId`. When `req.id` is absent, `req.log` is still installed —
// just without the binding.

// ── Handler helper ───────────────────────────────────────────────────────
/**
 * This package augments the Express Request type with an optional `log`.
 * Fail fast in handlers instead of scattering `req.log?.` everywhere.
 */
function requestLogger(req: Request): Logger {
  if (!req.log) {
    throw new Error('req.log is not available — is the pino logger plugin installed?');
  }
  return req.log;
}

// ── Handler ──────────────────────────────────────────────────────────────
interface User {
  readonly id: string;
  readonly email: string;
}

async function findUser(userId: string): Promise<User | null> {
  return userId === 'u-1' ? { id: 'u-1', email: 'user@example.com' } : null;
}

async function getUser(req: Request, res: Response): Promise<void> {
  const log = requestLogger(req);
  const userId = req.params.userId;

  try {
    await log.info('fetching user', { userId });
    const user = await findUser(userId);

    if (!user) {
      await log.warn('user not found', { userId });
      res.status(404).json({ error: 'not found' });
      return;
    }

    await log.info('user fetched', { userId: user.id });
    res.status(200).json(user);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await log.error('get user failed', { userId, error: message });
    res.status(500).json({ error: 'internal error' });
  }
}

void getUser;

// ── Background work without a request ────────────────────────────────────
// Same mechanism, different bindings: the requestId slot is filled by jobId.
const jobLog = logger.createRequestLogger({ jobId: 'nightly-cleanup' });
await jobLog.info('cleanup started');

await logger.shutdown();
```

Every entry produced through `req.log` in this example carries the correlation context:

```json
{"level":30,"time":1730000000000,"pid":12345,"hostname":"app-01","requestId":"req-abc-123","userId":"u-1","msg":"fetching user"}
```

**What this replaces** — manual threading of the request ID through every call site, where a single omission breaks tracing:

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

async function onUserMissing(requestId: string, userId: string): Promise<void> {
  // requestId must be passed through every function signature and every call.
  await logger.warn('user not found', { requestId, userId });
}

await onUserMissing('req-abc-123', 'u-99');
await logger.shutdown();
```

### Why It Matters

- **One child logger per request** is cheap (a pino `child()` call) and gives you grep-able correlation across every entry of a request — including `warn` and `error` paths — without prop-drilling a logger through your call graph.
- **Graceful degradation**: the middleware checks `if (req.id)` before adding the binding, so requests without an upstream ID still get a working `req.log`, just uncorrelated.
- **The same mechanism serves background work**: `createRequestLogger({ jobId })` reuses the child-logger machinery for jobs, which keeps log-processing queries uniform across request and job traffic.

### Caveats and Performance Considerations

- **Order matters**: whatever sets `req.id` must run before the plugin's middleware. If the ID arrives later, the binding is silently absent — this is by design, not an error.
- **One child per request, not per log call.** Creating a child logger for every `info()` call would add merge overhead and defeat the correlation model. The plugin already creates exactly one child per request.
- **Do not store `req.log` beyond the request** — in a global, a cache, or a long-lived singleton. Bindings are snapshotted at creation; holding a reference pins stale request context (see Pattern 3).
- Log volume per request is now proportional to your handler logging — keep `debug`-level chatter in hot paths behind a level check or accept that production runs at `info`.

---

## Pattern 3: Injecting the Logger Interface into Services

### When to Use It

Use this pattern when domain services — order processing, repositories, background processors — need to log but should not know about pino, Express, or WebAFX. The services depend on the BlendSDK `Logger` interface; the composition root decides which implementation they receive: the application provider for ambient logging, or `req.log` for correlated request logging.

### Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Logger } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';

interface Order {
  readonly id: string;
  readonly total: number;
}

/**
 * Domain service that depends only on the Logger interface.
 * No pino import, no Express import — swap the logger freely in tests.
 */
class OrderService {
  constructor(private readonly logger: Logger) {}

  async placeOrder(order: Order, logger?: Logger): Promise<void> {
    // Request-scoped logger wins when provided; otherwise use the
    // application-level logger injected at construction.
    const log = logger ?? this.logger;
    await log.info('order placed', { orderId: order.id, total: order.total });
  }
}

// ── Composition root ─────────────────────────────────────────────────────
const app = new WebApplication();
const logger = new PinoLoggerProvider({ level: 'info' });
app.use(createLoggerPlugin(logger));

const orderService = new OrderService(logger);

// ── Inside a request handler ─────────────────────────────────────────────
async function postOrder(req: Request, res: Response): Promise<void> {
  const order: Order = { id: 'o-1', total: 42.5 };

  // Passing req.log threads the requestId binding through the service
  // without the service importing anything Express-related.
  await orderService.placeOrder(order, req.log);

  res.status(201).json({ id: order.id });
}

void postOrder;

await logger.shutdown();
```

With `req.log` passed in, the service's entry is correlated; without it (background call sites), the service falls back to the application-level logger and still emits a complete structured record.

### Why It Matters

- **Interface segregation**: services compile against four async methods, not against pino's object-first API, its options, or its types. Swapping the logger implementation — including a lightweight in-memory `Logger` in unit tests (see Core Concepts) — requires no changes to the service.
- **Correlation without coupling**: the optional second parameter is the seam where request context enters the service. The service logs normally; the caller decides whether the entry carries a `requestId`.
- **Testability**: construct the service with any `Logger`, assert on recorded calls, and never spin up pino in unit tests.

### Caveats and Performance Considerations

- **Never capture `req.log` in long-lived state.** Assigning it to a field of a singleton service or a module-level variable pins that request's bindings (and the request's memory) for the process lifetime. Pass it per call, as shown.
- The fallback pattern (`logger ?? this.logger`) keeps call sites simple, but be consistent: mixing correlated and uncorrelated entries for the same operation makes log queries ambiguous.
- There is exactly one performance hop per call (the extra `await` into the two-argument overload) — negligible compared to pino's serialization, and it keeps the service testable.

---

## Pattern 4: Environment-Driven Dev/Prod Configuration

### When to Use It

Use this pattern when the same codebase must produce colorized, human-readable output in development and raw structured JSON in production, with the level coming from an environment variable that is conventionally uppercase. The provider's `normalizeLevel()` handles the casing (`ApplicationSettings.LOG_LEVEL` → `'INFO'` works out of the box), but the rest of the configuration — `pretty`, `destination`, `pinoOptions` — needs one source of truth.

### Before and After

**Before — ad-hoc options with a silent conflict:**

```typescript
import { createWriteStream } from 'node:fs';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// Problems:
// - `pretty: true` is ignored because a destination is set — development
//   gets neither colorized stdout nor a clearly intended file.
// - 'DEBUG' works only because the provider normalizes levels silently.
// - Configuration is scattered; nothing single-handedly describes the policy.
const logger = new PinoLoggerProvider({
  level: process.env.LOG_LEVEL,
  pretty: true, // ignored — a destination is set
  destination: createWriteStream('./app.log'),
});
```

**After — one factory that owns the policy:**

```typescript
import { createWriteStream, type WriteStream } from 'node:fs';
import {
  PinoLoggerProvider,
  normalizeLevel,
  type PinoLoggerProviderConfig,
} from 'blendsdk/webafx-pino';

interface LoggerEnvironment {
  readonly LOG_LEVEL?: string;
  readonly NODE_ENV?: string;
  readonly LOG_FILE?: string;
}

/**
 * Single source of truth for logger configuration.
 * normalizeLevel() is applied here so the effective level can be reported
 * at boot and compared before the provider re-normalizes it internally.
 */
function buildLoggerConfig(env: LoggerEnvironment): PinoLoggerProviderConfig {
  const level = normalizeLevel(env.LOG_LEVEL ?? 'info');
  const isProduction = env.NODE_ENV === 'production';

  if (!isProduction) {
    // Development: colorized stdout. No destination, so `pretty` is honored.
    // Requires the optional pino-pretty peer dependency.
    return { level, pretty: true };
  }

  // Production: raw JSON lines to a file, without pid/hostname boilerplate.
  // Default redaction (authorization and cookie headers) stays in effect.
  const destination: WriteStream = createWriteStream(
    env.LOG_FILE ?? '/var/log/checkout-service/app.log',
    { flags: 'a' },
  );

  return {
    level,
    pinoOptions: { base: null }, // spread last → drops pid/hostname
    destination,
  };
}

const logger = new PinoLoggerProvider(
  buildLoggerConfig({
    LOG_LEVEL: process.env.LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
    LOG_FILE: process.env.LOG_FILE,
  }),
);

await logger.info('logger configured');

// File streams are asynchronous — flush buffered JSON lines on exit.
await logger.shutdown();
```

### Why It Matters

- **One policy, two deployments**: the dev/prod difference is expressed once, in a pure function that takes the environment as a parameter — which also makes it unit-testable without touching `process.env` globally.
- **Explicit, not accidental**: the `pretty`/`destination` conflict is resolved by construction — the factory never returns both.
- **The provider normalizes anyway** (`normalizeLevel(config?.level ?? 'info')`), so calling `normalizeLevel()` in the factory is about observability: you can log the effective configuration at boot rather than discovering a typo'd level silently degrading to `'info'` weeks later.
- **`pinoOptions` is the documented extension point** for pino features the typed config does not enumerate — `base: null` here, custom timestamps or formatters in other deployments.

### Caveats and Performance Considerations

- `pretty: true` requires the optional `pino-pretty` peer (`>=11.0.0`) and is **ignored whenever a `destination` is set** — a pino transport and a custom stream are mutually exclusive. Never branch on `pretty` when a destination is configured.
- `pinoOptions` is spread **last** in the pino constructor options, so it can override named options. Use it intentionally (`base: null`); avoid duplicating `level` or `redact` inside it, because values passed there bypass the provider's normalization and default handling.
- Omit `redact` to keep the secure defaults; when you do provide it, remember it *replaces* `DEFAULT_REDACT_PATHS` (Pattern 6 shows the extend-don't-replace idiom).
- File destinations are asynchronous: without `await logger.shutdown()` on exit, buffered lines can be lost (Pattern 8).

---

## Pattern 5: Test Harness — Capturing and Asserting on Log Output

### When to Use It

Use this pattern whenever tests need to assert on log behavior: that a service logs the right message and fields, that levels are filtered correctly, or that request-scoped bindings reach the record. It is the same strategy the package's own integration tests use — route pino output into a `Writable` collector instead of stdout, then assert on parsed JSON entries.

### Example

```typescript
import { Writable } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

interface CapturedLog {
  /** Parsed JSON entries, in emission order */
  readonly entries: Array<Record<string, unknown>>;
  /** The destination to hand to PinoLoggerProvider */
  readonly stream: Writable;
  /** Raw JSON lines, for assertions on serialization itself */
  readonly lines: string[];
  /** The `msg` field of every captured entry */
  messages(): string[];
}

function createLogCapture(): CapturedLog {
  const entries: Array<Record<string, unknown>> = [];
  const lines: string[] = [];

  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      const line = chunk.toString().trim();
      lines.push(line);
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Non-JSON output stays available through `lines` only.
      }
      callback();
    },
  });

  return {
    entries,
    lines,
    stream,
    messages(): string[] {
      return entries.map((entry) => String(entry.msg));
    },
  };
}

describe('OrderService logging', () => {
  let capture: CapturedLog;
  let logger: PinoLoggerProvider;

  beforeEach(() => {
    capture = createLogCapture();
    logger = new PinoLoggerProvider({
      level: 'trace',              // capture every level by default
      destination: capture.stream, // stdout replaced by the collector
    });
  });

  afterEach(async () => {
    await logger.shutdown(); // flush before teardown completes
  });

  it('logs order placement with structured fields', async () => {
    await logger.info('order placed', { orderId: 'o-1', total: 42 });

    expect(capture.entries).toHaveLength(1);
    expect(capture.entries[0].msg).toBe('order placed');
    expect(capture.entries[0].orderId).toBe('o-1');
    expect(capture.entries[0].level).toBe(30); // numeric pino info level
  });

  it('filters levels below the configured level', async () => {
    const quietCapture = createLogCapture();
    const quietLogger = new PinoLoggerProvider({ level: 'warn', destination: quietCapture.stream });

    await quietLogger.warn('visible');
    await quietLogger.debug('suppressed');

    expect(quietCapture.messages()).toEqual(['visible']);
    await quietLogger.shutdown();
  });

  it('binds request context to every child entry', async () => {
    const requestLog = logger.createRequestLogger({ requestId: 'req-77' });

    await requestLog.info('handled', { durationMs: 5 });

    expect(capture.entries[0].requestId).toBe('req-77');
    expect(capture.entries[0].durationMs).toBe(5);
    expect(capture.entries[0].msg).toBe('handled');
  });
});
```

### Why It Matters

- **Deterministic assertions on structured output**: because each entry is one JSON line, `JSON.parse` gives you exact fields (`msg`, numeric `level`, bindings, data) — no substring matching against console formatting.
- **No pollution**: captured output never reaches the test runner's stdout, so failures stay readable.
- **The collector is reusable**: one helper covers provider tests, service tests, and plugin wiring tests; for wiring-only tests, construct the provider at `level: 'silent'` (as the package's plugin tests do) when emitted output is irrelevant.

### Caveats and Performance Considerations

- Pino writes synchronously to the destination, so entries are present immediately after `await logger.info(...)`. Keep the `afterEach(() => logger.shutdown())` anyway: it matches the lifecycle contract and future-proofs tests that switch to transport-based output.
- `pretty` cannot be combined with a destination — pretty output always goes to stdout, never to your collector. Test the JSON path, not the pretty renderer.
- One collector per provider. Sharing one stream across providers interleaves entries and makes index-based assertions fragile; if you must share, assert on `messages()` content rather than positions.
- Constructing a provider per test is cheap — pino instances and redact paths are compiled at construction, and `level: 'trace'` gives you full visibility without touching global configuration.

---

## Pattern 6: Application-Level Redaction Strategy

### When to Use It

Use this pattern when the default redaction (`req.headers.authorization`, `req.headers.cookie`) is not enough: you log request bodies, user records, or API payloads that contain credentials, tokens, or personal data. It combines two complementary mechanisms — `redact` to mask sensitive fields and `serializers` to keep whole subtrees out of the record — plus the extend-don't-replace idiom for `DEFAULT_REDACT_PATHS`.

### Example

```typescript
import { Writable } from 'node:stream';
import type { Request } from 'express';
import {
  PinoLoggerProvider,
  DEFAULT_REDACT_PATHS,
} from 'blendsdk/webafx-pino';

const records: Array<Record<string, unknown>> = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

/**
 * Extend — never replace — the package security defaults.
 * Spreading DEFAULT_REDACT_PATHS keeps authorization/cookie redaction AND
 * inherits any paths added to the constant by future package versions.
 */
const redactPaths: string[] = [
  ...DEFAULT_REDACT_PATHS,
  'user.password',
  'user.passwordHash',
  'body.creditCard',
  "req.headers['x-api-key']",
];

interface LoggedRequest {
  readonly method: string;
  readonly url: string;
  readonly contentType?: string;
}

/**
 * Serializer for `{ req }` payloads: emit only method, URL, and content type.
 * Redaction masks values that must never be logged; a serializer goes one
 * step further and keeps whole fields out of the record entirely.
 */
function requestSerializer(req: unknown): LoggedRequest {
  const request = req as Request;
  const contentType = request.headers['content-type'];
  return {
    method: request.method,
    url: request.url,
    contentType: Array.isArray(contentType) ? contentType.join(', ') : contentType,
  };
}

const logger = new PinoLoggerProvider({
  level: 'info',
  destination: capture,
  redact: redactPaths,
  serializers: { req: requestSerializer },
});

// 1. Masked by redaction — the field stays, the value is replaced.
await logger.info('login attempt', {
  user: { name: 'admin', password: 'secret123' },
});

// 2. Dropped by the serializer — headers never reach the record at all.
await logger.info('incoming request', {
  req: {
    method: 'GET',
    url: '/orders/42',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer secret-token',
      'x-api-key': 'key-42',
    },
  },
});

// records[0].user.name === 'admin'
// records[0].user.password === '[Redacted]'

// records[1].req === { method: 'GET', url: '/orders/42', contentType: 'application/json' }
// records[1].req.headers === undefined — secrets are absent, not masked

await logger.shutdown();
```

**Before and after, at the record level:**

```json
{"level":30,"msg":"login attempt","user":{"name":"admin","password":"secret123"}}
```

```json
{"level":30,"msg":"login attempt","user":{"name":"admin","password":"[Redacted]"}}
```

### Why It Matters

- **Defense in depth**: serializers narrow what *can* be logged from request-shaped objects; redaction catches sensitive values that arrive through ad-hoc `data` fields. Between the two, a leaked credential requires two independent mistakes.
- **Auditability**: the redact list is one reviewed constant. Security review happens in one place instead of across every call site.
- **Future-proof defaults**: spreading `DEFAULT_REDACT_PATHS` means upgrading the package inherits new default paths automatically, rather than silently forking from them.

### Caveats and Performance Considerations

- **`redact` replaces, never merges.** Writing `redact: ['user.password']` silently disables authorization and cookie redaction. Always spread `DEFAULT_REDACT_PATHS` unless you are intentionally opting out. An explicit `redact: []` disables redaction entirely (the pino `redact` option is skipped for empty arrays).
- **Serializers run before redaction.** Redaction paths are applied to the serializer's *output*, so a custom `req` serializer must keep the fields you list in `redact` if you still want them masked — and if it drops them, they never reach the record and the path simply never matches.
- **Redaction protects the record, not the process.** The original values are still passed through your code; it is the serialized entry that is masked. Do not rely on redaction where the value must not be handled at all.
- Fast-redact compiles paths once at construction, so matching is cheap per entry — but keep the list focused on fields that actually appear in your logs rather than enumerating dozens of speculative paths; prefer serializers that drop entire subtrees.

---

## Pattern 7: A Custom Provider Wired into the WebAFX Lifecycle

### When to Use It

Use this pattern when a cross-cutting concern must run around *every* log line: an audit ring buffer for a diagnostics endpoint, log sampling, dual-shipping to an external system, or counters. The key fact that makes it clean is that `createLoggerPlugin(provider)` accepts **any** `LoggerProvider` — so you compose a `PinoLoggerProvider` inside a subclass of the abstract base and wire the subclass into the identical lifecycle: `setLogger`, `req.log` middleware, singleton service registration, and health/shutdown hooks.

### Example

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Logger } from 'blendsdk/webafx';
import {
  LoggerProvider,
  PinoLoggerProvider,
  createLoggerPlugin,
  type PinoLoggerProviderConfig,
} from 'blendsdk/webafx-pino';

interface ErrorSnapshot {
  readonly message: string;
  readonly at: number;
}

/**
 * Delegates to pino and keeps a bounded ring buffer of recent error
 * messages for an admin/diagnostics endpoint.
 *
 * Composition (instead of subclassing PinoLoggerProvider) keeps the pino
 * specifics contained in `inner` — swap in any other provider without
 * touching the audit logic.
 */
class AuditedLogger extends LoggerProvider {
  private static readonly MAX_ERRORS = 50;

  private readonly inner: PinoLoggerProvider;
  private readonly recentErrors: ErrorSnapshot[] = [];

  constructor(config?: PinoLoggerProviderConfig) {
    super(config);
    this.inner = new PinoLoggerProvider(config);
  }

  async info(message: string, data?: Record<string, unknown>): Promise<void> {
    await this.inner.info(message, data);
  }

  async error(message: string, data?: Record<string, unknown>): Promise<void> {
    this.remember(message);
    await this.inner.error(message, data);
  }

  async warn(message: string, data?: Record<string, unknown>): Promise<void> {
    await this.inner.warn(message, data);
  }

  async debug(message: string, data?: Record<string, unknown>): Promise<void> {
    await this.inner.debug(message, data);
  }

  async health(): Promise<boolean> {
    return this.inner.health();
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }

  createRequestLogger(bindings: Record<string, unknown>): Logger {
    const child = this.inner.createRequestLogger(bindings);

    // Wrap the child too — otherwise req.log entries bypass the audit buffer.
    return {
      info: async (message: string, data?: Record<string, unknown>): Promise<void> => {
        await child.info(message, data);
      },
      error: async (message: string, data?: Record<string, unknown>): Promise<void> => {
        this.remember(message);
        await child.error(message, data);
      },
      warn: async (message: string, data?: Record<string, unknown>): Promise<void> => {
        await child.warn(message, data);
      },
      debug: async (message: string, data?: Record<string, unknown>): Promise<void> => {
        await child.debug(message, data);
      },
    };
  }

  /** Snapshot for the diagnostics endpoint — newest entries last. */
  getRecentErrors(): ReadonlyArray<ErrorSnapshot> {
    return this.recentErrors;
  }

  private remember(message: string): void {
    this.recentErrors.push({ message, at: Date.now() });
    if (this.recentErrors.length > AuditedLogger.MAX_ERRORS) {
      this.recentErrors.shift();
    }
  }
}

// ── Wiring — createLoggerPlugin accepts ANY LoggerProvider ───────────────
const app = new WebApplication();
const audited = new AuditedLogger({ level: 'info', serviceName: 'logger' });
app.use(createLoggerPlugin(audited));

await audited.info('application started');
await audited.error('payment gateway timeout', { gateway: 'stripe' });

// Request-scoped errors are audited too, thanks to the wrapped child logger:
const requestLog = audited.createRequestLogger({ requestId: 'req-9' });
await requestLog.error('handler crashed');

// recent[0].message === 'payment gateway timeout'
// recent[1].message === 'handler crashed'
const recent = audited.getRecentErrors();
await audited.info('diagnostics snapshot ready', { errorCount: recent.length });

await audited.shutdown();
```

### Why It Matters

- **The plugin factory is the extensibility point.** Because `createLoggerPlugin` is typed against the abstract `LoggerProvider`, the application's logger can gain behavior (auditing, sampling, shipping) without any change to how it is installed, registered, or shut down.
- **The lifecycle contract is honored by delegation.** `health()` and `shutdown()` forward to pino, so the hooks the plugin returns to WebAFX still perform the real flush.
- **Child loggers can be intercepted too.** The wrapped `createRequestLogger` shows how request-scoped logging stays inside the cross-cutting concern instead of silently bypassing it.

### Caveats and Performance Considerations

- **Wrap `createRequestLogger` or accept the gap.** If you return `this.inner.createRequestLogger(bindings)` directly, everything logged through `req.log` bypasses your overrides — usually the opposite of what an audit or sampling provider wants.
- **Keep overrides fast.** Every call now awaits your code before pino writes. A synchronous `push` into a bounded array is fine; an `await fetch(...)` inside `error()` adds latency to every error path — queue or batch side effects instead.
- **Bound every buffer.** The ring buffer caps at `MAX_ERRORS`; an unbounded array in a log wrapper is a memory leak with a schedule.
- If you only need an extra side effect on `error()` for the pino provider specifically, subclassing `PinoLoggerProvider` and calling `super.error(...)` is also valid — but composition keeps the provider underneath swappable, which is why it is the recommended shape here.

---

## Pattern 8: Graceful Shutdown and Health for Long-Running Processes

### When to Use It

Use this pattern when the provider runs **standalone** — workers, CLI daemons, queue consumers, non-HTTP services — and you must not lose buffered entries when the process receives `SIGTERM` or `SIGINT`. `shutdown()` resolves after `pino.flush()` completes, which drains entries held by transports and asynchronous destinations. When the provider is installed as a WebAFX plugin, the plugin's lifecycle hooks do this for you — the manual wiring is only needed outside WebAFX.

### Before and After

**Before — exiting immediately drops buffered entries:**

```typescript
// Entries sitting in a transport or async destination are lost.
process.on('SIGTERM', () => process.exit(0));
```

**After — explicit, idempotent shutdown with health reporting:**

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return; // idempotent: repeated signals must not double-flush
  }
  isShuttingDown = true;

  await logger.info('shutting down', { signal });
  await logger.shutdown(); // resolves after pino.flush() drains buffered entries
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Treat the provider as terminal after shutdown() — do not log again.

const healthy: boolean = await logger.health();
await logger.info('worker started', { healthy });
```

**Plugin path — no signal handling required in application code:**

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();
const provider = new PinoLoggerProvider({ level: 'info' });

// The plugin factory returns { health, shutdown } hooks:
//   health:   () => provider.health()
//   shutdown: () => provider.shutdown()
// WebAFX invokes them during its own health checks and graceful shutdown.
app.use(createLoggerPlugin(provider));
```

### Why It Matters

- **Flush semantics**: `PinoLoggerProvider.shutdown()` wraps `pino.flush()` in a promise, so awaiting it guarantees buffered entries have been handed to the destination before you exit. This is the difference between a clean audit trail and a truncated one on every deploy.
- **Uniform lifecycle**: the plugin path and the standalone path expose the identical `health()`/`shutdown()` pair, so operational tooling (readiness endpoints, orchestrator pre-stop hooks) is written once.
- **Signal safety**: a shutdown guard makes repeated signals (common during rolling restarts) harmless instead of racing two flushes and two `process.exit` calls.

### Caveats and Performance Considerations

- Register signal handlers **before** the process is likely to receive them, and always `await` the async shutdown — a fire-and-forget handler that exits synchronously skips the flush.
- `health()` exists for lifecycle uniformity. For this provider it always returns `true` (pino writes synchronously and has no meaningful failure state) — do not treat it as a dependency health proxy.
- After `shutdown()` resolves, treat the provider as terminal: the lifecycle contract ends there, and further logging is not guaranteed to be flushed.
- In the plugin path, never call `provider.shutdown()` yourself *and* let WebAFX run its shutdown hook; pick one owner. The plugin is the owner when it is installed.

---

## Pattern 9: The Escape Hatch — Sharing the Underlying Pino Instance

### When to Use It

Use this pattern when code outside the BlendSDK `Logger` interface needs a pino logger: a third-party library whose options type is pino's `Logger`, a module that wants a component-scoped child with its own bindings, or pino features the adapter intentionally does not surface. `getPinoInstance()` exposes the provider's pino instance, so every consumer shares the same level, redaction, and destination — instead of constructing a second `pino()` instance that drifts from your configuration.

### Example

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';
import type { Logger as PinoLogger } from 'pino';

const provider = new PinoLoggerProvider({ level: 'debug' });

// The raw instance shares level, redaction, and destination with the provider.
const raw: PinoLogger = provider.getPinoInstance();

// A library that is typed against pino's Logger interface.
interface DataLayerOptions {
  readonly logger: PinoLogger;
}

class DataLayer {
  constructor(private readonly options: DataLayerOptions) {}

  async query(sql: string): Promise<void> {
    this.options.logger.debug({ sql }, 'executing query');
  }
}

// Hand the library a module-scoped child: every entry carries component: 'database'
// and inherits the provider's configuration.
const dataLayer = new DataLayer({
  logger: raw.child({ component: 'database' }),
});

await dataLayer.query('SELECT 1 FROM orders');

// Emitted (abridged):
// {"level":20,"component":"database","sql":"SELECT 1 FROM orders","msg":"executing query"}

await provider.shutdown();
```

Which API to reach for, by context:

| Where the log is produced | Recommended API | Why |
|---------------------------|-----------------|-----|
| Application code, request handlers, services | `Logger` interface (`provider`, `req.log`, `createRequestLogger`) | Uniform message-first API, automatic bindings, swappable in tests |
| A library typed against pino | `provider.getPinoInstance()` (or a `child()` of it) | Satisfies the library's own `PinoLogger` type; one shared instance |
| pino-native features not exposed by the adapter (custom child levels, module bindings) | `getPinoInstance()` | Full pino surface — use sparingly and at the composition root |

### Why It Matters

- **One instance, one configuration**: level filtering, redaction, and the destination are configured once on the provider. Handing out children of its pino instance keeps third-party logging consistent with application logging — a second `pino()` call elsewhere would silently bypass redaction and the destination.
- **No back-pressure on the adapter**: libraries that already speak pino's object-first, synchronous API do not need wrapping; they plug into the same stream.
- **It gives the two-step plugin form (Pattern 1) a second purpose**: the provider reference you keep for priority control is also the single place where `getPinoInstance()` is called.

### Caveats and Performance Considerations

- Raw pino calls step outside the adapter: they are **synchronous and object-first** (`logger.debug(obj, msg)`). The `await`/message-first conventions of the `Logger` interface no longer apply — do not mix the two styles in the same module.
- Records emitted through the raw instance still honor level and redaction, because it is the same instance; but `createRequestLogger` bindings do not exist on the raw path — manage context yourself with `child(bindings)`.
- Keep `getPinoInstance()` calls at the composition root and hand out narrow children. Spreading raw pino access throughout the codebase recreates the coupling that the adapter exists to remove.
- Creating children is cheap but not free; create one per component or per request, never per log line.

---

## Cross-Cutting Caveats and Performance Notes

A condensed checklist of the considerations that recur across all patterns:

- **One provider per process.** Each `PinoLoggerProvider` owns exactly one pino instance; all child loggers share its level, redaction, and destination. Two providers mean two configurations that will drift.
- **Child loggers: one per request or component**, created via `createRequestLogger()` or `pino.child()` — never per log line.
- **`redact` replaces, it never merges.** Extend the defaults with `[...DEFAULT_REDACT_PATHS, ...]`; `redact: []` disables redaction entirely. Remember serializers run before redaction.
- **`pretty` and `destination` are mutually exclusive** — the destination wins, and `pino-pretty` is only needed (and only installable work) when pretty output is actually enabled with no destination.
- **`pinoOptions` is spread last** and can override named options; use it for extras like `base: null` rather than duplicating `level` or `redact`.
- **Always reach `shutdown()` on exit.** It resolves after `pino.flush()`; without it, transport- and file-buffered entries can be lost on `SIGTERM`.
- **Misconfigured levels degrade silently** to `'info'` via `normalizeLevel()`. That is the intended safe fallback — compensate by logging the effective configuration at boot (Pattern 4).
- **Wrapper providers add an `await` hop per line.** Keep custom provider overrides synchronous and bounded (Pattern 7), and rely on pino's own level filtering for cheap suppression of below-level calls.

Related documentation: Overview · Core Concepts · Basic Usage

---

# webafx-pino Common Scenarios

This document answers the most common "How do I...?" questions about `blendsdk/webafx-pino`, each with a complete, runnable TypeScript example. The scenarios start with standalone usage and progress to full WebAFX plugin integration, ending with edge cases and advanced escape hatches.

---

## How do I create a logger and write my first log entry?

**Solution** — Create a `PinoLoggerProvider` and await its asynchronous methods. The provider works standalone — no WebAFX application is required — and each entry is emitted as a structured JSON record. Call `shutdown()` before exit to flush buffered entries.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// Standalone — no WebAFX application required.
const logger = new PinoLoggerProvider({ level: 'info' });

// Every method is async and takes a message plus optional structured data.
await logger.info('Server started', { port: 3000 });
await logger.warn('Deprecated endpoint called', { path: '/v1/orders' });
await logger.error('Payment provider timeout', { provider: 'stripe' });
await logger.debug('Suppressed — the configured level is info');

// Flush buffered entries before the process exits.
await logger.shutdown();
```

---

## How do I set the log level, including uppercase values from environment variables?

**Solution** — Pass `level` to the constructor; casing is normalized automatically (`'INFO'`, `'Info'`, and `'info'` are all valid). Unrecognized values such as `'verbose'` or `'CRITICAL'` fall back to `'info'`, and `normalizeLevel()` is exported for reuse with environment variables. Entries below the configured level are filtered out by pino.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider, normalizeLevel } from 'blendsdk/webafx-pino';

const records: Array<Record<string, unknown>> = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

// Environment values are typically uppercase — 'WARN' becomes 'warn'.
// Unrecognized values (e.g. 'verbose') safely fall back to 'info'.
// In real code the value often comes from: normalizeLevel(process.env.LOG_LEVEL ?? 'info')
const level: string = normalizeLevel('WARN');

const logger = new PinoLoggerProvider({ level, destination: capture });

await logger.debug('Suppressed — below warn');
await logger.info('Suppressed — below warn');
await logger.warn('Visible');
await logger.error('Visible');

// records.length === 2 — only warn and error passed the filter

await logger.shutdown();
```

---

## How do I attach structured context to log entries?

**Solution** — Pass an object as the second argument; its keys become top-level properties of the JSON record next to `msg` and `level`. Any JSON-serializable value — strings, numbers, booleans, nested objects — can be logged this way.

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

// The second argument's keys become top-level properties of the record.
await logger.info('Order created', { orderId: 'ord-1', total: 42.5, currency: 'EUR' });

// records[0] looks like this:
// {
//   "level": 30,
//   "time": 1730000000000,
//   "pid": 1234,
//   "hostname": "dev-box",
//   "msg": "Order created",
//   "orderId": "ord-1",
//   "total": 42.5,
//   "currency": "EUR"
// }

await logger.shutdown();
```

---

## How do I keep secrets such as tokens and cookies out of my logs?

**Solution** — Sensitive fields are redacted automatically: `req.headers.authorization` and `req.headers.cookie` are masked as `'[Redacted]'` by default. A custom `redact` array replaces the defaults entirely — spread `DEFAULT_REDACT_PATHS` to extend them — and `redact: []` disables redaction.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider, DEFAULT_REDACT_PATHS } from 'blendsdk/webafx-pino';

const records: Array<Record<string, unknown>> = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    records.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

// Spreading keeps the defaults AND adds custom paths — a custom redact
// array otherwise REPLACES the defaults instead of merging with them.
const logger = new PinoLoggerProvider({
  level: 'info',
  destination: capture,
  redact: [...DEFAULT_REDACT_PATHS, 'user.password', 'req.headers.x-api-key'],
});

await logger.info('Login attempt', {
  user: { name: 'admin', password: 'secret123' },
  req: {
    headers: {
      authorization: 'Bearer secret-token',
      cookie: 'session=abc123',
      'content-type': 'application/json',
    },
  },
});

// records[0].user.password === '[Redacted]'
// records[0].req.headers.authorization === '[Redacted]'
// records[0].req.headers.cookie === '[Redacted]'
// records[0].req.headers['content-type'] === 'application/json'
// records[0].user.name === 'admin'

await logger.shutdown();
```

---

## How do I create a request-scoped logger bound to a request ID?

**Solution** — Call `createRequestLogger(bindings)`; it returns a `Logger` whose every entry includes the given bindings. Child loggers inherit the parent's level, merge their bindings with each call's data, and are independent — create one per in-flight request.

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

// One child per request — the bindings appear on every entry it emits.
const requestLogger = logger.createRequestLogger({
  requestId: 'req-42',
  userId: 'user-7',
});

await requestLogger.info('Fetching profile');
await requestLogger.warn('Cache miss', { durationMs: 12 });

// records[0].msg === 'Fetching profile'
// records[0].requestId === 'req-42'
// records[0].userId === 'user-7'
// records[1].requestId === 'req-42'
// records[1].durationMs === 12

await logger.shutdown();
```

---

## How do I pass extra pino options such as a logger name?

**Solution** — Use `pinoOptions`, which is forwarded to the pino constructor and spread last, so it can override any named option — for example `name` to label the logger, or `base: null` to drop the default `pid`/`hostname` fields.

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
  level: 'info',
  destination: capture,
  pinoOptions: {
    name: 'checkout-service', // adds a "name" field to every record
    base: null,               // drops the default pid and hostname fields
  },
});

await logger.info('Order processed', { orderId: 'ord-9' });

// records[0].name === 'checkout-service'
// records[0].msg === 'Order processed'
// records[0].orderId === 'ord-9'
// records[0].pid === undefined

await logger.shutdown();
```

---

## How do I enable pretty-printed logs in development?

**Solution** — Set `pretty: true` to attach the `pino-pretty` transport with colorized output; the optional peer dependency `pino-pretty` must be installed. When a custom `destination` is configured, `pretty` is ignored — a pino transport and a destination stream cannot be combined.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// Colorized, human-readable output on stdout — requires pino-pretty.
const isProduction = process.env.NODE_ENV === 'production';

const logger = new PinoLoggerProvider({
  level: 'debug',
  pretty: !isProduction,
});

await logger.debug('Colorized locally, raw JSON in production');

// Always flush the transport before exit.
await logger.shutdown();
```

---

## How do I capture and assert on log output in tests?

**Solution** — Pass a `Writable` stream as `destination` and parse each chunk as JSON to assert on the resulting records. This is also the pattern for any scenario where log output must be inspected programmatically.

```typescript
import { Writable } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

function createLogCollector(): { stream: Writable; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      entries.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { stream, entries };
}

describe('order service logging', () => {
  let logger: PinoLoggerProvider | null = null;

  afterEach(async () => {
    if (logger !== null) {
      await logger.shutdown();
      logger = null;
    }
  });

  it('writes structured entries to the destination', async () => {
    const { stream, entries } = createLogCollector();
    logger = new PinoLoggerProvider({ level: 'trace', destination: stream });

    await logger.info('server started', { port: 3000, host: 'localhost' });

    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('server started');
    expect(entries[0].port).toBe(3000);
    expect(entries[0].host).toBe('localhost');
    expect(entries[0].level).toBe(30);
  });

  it('redacts authorization headers by default', async () => {
    const { stream, entries } = createLogCollector();
    logger = new PinoLoggerProvider({ level: 'trace', destination: stream });

    await logger.info('request', {
      req: { headers: { authorization: 'Bearer secret-token' } },
    });

    expect(entries[0].req).toEqual({ headers: { authorization: '[Redacted]' } });
  });
});
```

---

## How do I add the logger to a WebAFX application with a single call?

**Solution** — Use `pinoLoggerPlugin(options)`; it constructs the provider and performs the full wiring: `app.setLogger()`, the request-scoped `req.log` middleware, singleton service registration, and the health/shutdown lifecycle hooks.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

// One call performs the full wiring:
// 1. app.setLogger() replaces the default console logger
// 2. Express middleware attaches req.log to every request
// 3. The provider is registered as a singleton service named 'logger'
// 4. health() and shutdown() hooks join the application lifecycle
app.use(pinoLoggerPlugin({
  level: 'info',
  pretty: process.env.NODE_ENV !== 'production',
}));
```

---

## How do I wrap an already-configured provider as a WebAFX plugin?

**Solution** — Construct the `PinoLoggerProvider` yourself — for shared configuration, a dynamic service name, or custom redaction — then pass it to `createLoggerPlugin(provider)`. The two-step API performs the same installation steps as the one-liner.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import {
  PinoLoggerProvider,
  createLoggerPlugin,
  DEFAULT_SERVICE_NAME,
} from 'blendsdk/webafx-pino';

// Two-step API — build the provider yourself when you need a
// pre-configured instance (shared config, dynamic name, custom redaction).
const serviceName: string = process.env.LOGGER_SERVICE_NAME ?? DEFAULT_SERVICE_NAME;

const provider = new PinoLoggerProvider({
  level: 'DEBUG',
  serviceName, // registered as a singleton under this name; 'logger' by default
  redact: ['req.headers.authorization', 'req.headers.cookie', 'user.password'],
});

const app = new WebApplication();
app.use(createLoggerPlugin(provider));
```

---

## How do I log from an Express route handler using req.log?

**Solution** — The plugin's middleware assigns a request-scoped logger to `req.log` before your handlers run, bound to `{ requestId: req.id }` when upstream middleware set `req.id`. Use `req.log?.info(...)` inside handlers to emit entries that automatically carry the request context.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();
app.use(pinoLoggerPlugin({ level: 'info' }));

// The plugin's middleware runs before your handlers and sets req.log.
// Every entry automatically carries { requestId: req.id } when upstream
// middleware (e.g., express-request-id) has set req.id.
async function listOrders(req: Request, res: Response): Promise<void> {
  await req.log?.info('Listing orders', { path: req.path });
  res.status(200).json({ orders: [] });
}

// Keep the handler referenced so the example compiles as a unit.
void listOrders;
```

---

## How do I control when the logger plugin installs relative to other plugins?

**Solution** — Pass `priority`; lower numbers install first. The default is `DEFAULT_PLUGIN_PRIORITY` (`20`), which places the logger before the cache and mailer plugins (priority `30`). Both `pinoLoggerPlugin` options and `createLoggerPlugin` options accept the override.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import {
  PinoLoggerProvider,
  createLoggerPlugin,
  pinoLoggerPlugin,
  DEFAULT_PLUGIN_PRIORITY,
} from 'blendsdk/webafx-pino';

// Default priority is DEFAULT_PLUGIN_PRIORITY (20) — before cache/mailer (30).
const app = new WebApplication();

// One-liner form — install even earlier by lowering the number:
app.use(pinoLoggerPlugin({ level: 'info', priority: DEFAULT_PLUGIN_PRIORITY - 10 }));

// Provider-first form — the same override through createLoggerPlugin:
const provider = new PinoLoggerProvider({ level: 'info' });
app.use(createLoggerPlugin(provider, { priority: 10 }));
```

---

## How do I handle requests when no upstream middleware sets req.id?

**Solution** — Nothing breaks: the plugin's middleware guards the binding, so `req.log` is always created and the `requestId` field is simply omitted from entries. The code below mirrors the exact middleware logic — bindings are populated only when `req.id` is present.

```typescript
import type { NextFunction, Request, Response } from 'express';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const provider = new PinoLoggerProvider({ level: 'info' });

// Mirrors the middleware the plugin installs: bindings are built from
// req.id only when it exists — no error when the upstream middleware
// (express-request-id and friends) is not in the stack.
function requestLoggerMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const bindings: Record<string, unknown> = {};
  if (req.id) {
    bindings.requestId = req.id;
  }
  req.log = provider.createRequestLogger(bindings);
  next();
}

// A request without req.id still gets a fully functional req.log:
const requestLogger = provider.createRequestLogger({});
await requestLogger.info('No request id — the entry has no requestId field');

await provider.shutdown();

// Keep the middleware referenced so the example compiles as a unit.
void requestLoggerMiddleware;
```

---

## How do I access the underlying pino instance?

**Solution** — Call `getPinoInstance()` for an escape hatch to the raw pino logger. Use it for pino-specific features the `Logger` interface does not expose, such as custom child loggers or advanced integrations.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

// Escape hatch: the raw pino logger powering the provider.
const pinoInstance = logger.getPinoInstance();

// Use pino's own API directly, e.g. a child logger with extra bindings
const billing = pinoInstance.child({ component: 'billing' });
billing.info('Direct pino call from the billing component');

await logger.shutdown();
```

---

## How do I flush buffered logs and check the logger's health before shutdown?

**Solution** — `shutdown()` resolves only after `pino.flush()` has drained buffered entries, which matters for transports such as `pino-pretty` and custom destination streams. `health()` always resolves `true` for the pino provider, so it integrates uniformly with application lifecycle checks.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info', pretty: true });

await logger.info('Processing complete');

// Health check — the pino provider is stateless and always reports true.
const healthy: boolean = await logger.health();
if (!healthy) {
  await logger.error('Logger reported unhealthy');
}

// shutdown() resolves only after pino.flush() has drained buffered entries.
await logger.shutdown();
```

---

## Related Documentation

- Overview — purpose, features, and architecture
- Core Concepts — deep dive into providers, redaction, child loggers, and plugin wiring
- Basic Usage — quick-start guide

---

# webafx-pino Examples Library

A categorized collection of copy-paste-ready examples for `blendsdk/webafx-pino`. Every example is self-contained — all imports, configuration, and expected output are included — and the behavior shown mirrors the package's test suite, so it reflects verified runtime behavior.

**Categories:**

| Category | Covers |
|----------|--------|
| Basic Logging | `info`, `error`, `warn`, `debug` with and without structured data |
| Levels & Configuration | Case-insensitive levels, `normalizeLevel()`, `serviceName`, extra pino options |
| Redaction | Default redaction, extending defaults, disabling redaction |
| Output Routing | `pretty` output, custom `Writable` destinations |
| Request-Scoped Loggers | `createRequestLogger()` bindings, inheritance, isolation |
| Lifecycle | `health()` and `shutdown()` |
| WebAFX Plugin Integration | `pinoLoggerPlugin()`, `createLoggerPlugin()`, `req.log`, priorities |
| Custom Providers | Subclassing `LoggerProvider` |
| Testing Patterns | Capturing and asserting on output with Vitest |
| Advanced | `getPinoInstance()`, custom serializers |

---

## Basic Logging

The four `Logger` methods, from a bare message to fully structured entries.

### Log Your First Message

Create a provider and write a single entry. With no configuration, the level defaults to `'info'` and entries are written as JSON lines to stdout.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// Level defaults to 'info'; output goes to stdout as one JSON line per entry.
const logger = new PinoLoggerProvider();

await logger.info('Server started');

// stdout:
// {"level":30,"time":1730000000000,"pid":1234,"hostname":"devbox","msg":"Server started"}

// Flush buffered entries before the process exits.
await logger.shutdown();
```

### Attach Structured Data to an Entry

The second argument of every log method becomes top-level fields of the JSON record — no string interpolation required.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

await logger.info('server started', { port: 3000, host: 'localhost' });

// stdout:
// {"level":30,"time":1730000000000,"pid":1234,"hostname":"devbox","port":3000,"host":"localhost","msg":"server started"}

await logger.shutdown();
```

### Log Errors with Context

Attach diagnostic fields to errors so failures are grep-able and structured instead of buried in prose.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

async function queryUsers(): Promise<string[]> {
  throw new Error('connection refused');
}

try {
  const users = await queryUsers();
  await logger.info('users fetched', { count: users.length });
} catch (error) {
  await logger.error('database query failed', {
    table: 'users',
    duration: 150,
    reason: error instanceof Error ? error.message : String(error),
  });
}

// stdout:
// {"level":50,"time":1730000000000,"pid":1234,"hostname":"devbox","table":"users","duration":150,"reason":"connection refused","msg":"database query failed"}

await logger.shutdown();
```

### Emit Warning and Debug Entries

Every method maps to a numeric pino level: `trace` 10, `debug` 20, `info` 30, `warn` 40, `error` 50, `fatal` 60. The configured level acts as a threshold.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// 'debug' (20) lets both warn (40) and debug (20) entries through.
const logger = new PinoLoggerProvider({ level: 'debug' });

await logger.warn('cache nearing capacity', { usedPercent: 92 });
await logger.debug('cache statistics', { hits: 1042, misses: 7 });

// stdout:
// {"level":40,"time":1730000000000,"pid":1234,"hostname":"devbox","usedPercent":92,"msg":"cache nearing capacity"}
// {"level":20,"time":1730000000000,"pid":1234,"hostname":"devbox","hits":1042,"misses":7,"msg":"cache statistics"}

await logger.shutdown();
```

### Use the Provider Through the Logger Interface

`PinoLoggerProvider` structurally implements the BlendSDK `Logger` interface, so it can be injected anywhere that expects a `Logger` — application code never needs to know pino exists.

```typescript
import type { Logger } from 'blendsdk/webafx';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

async function useLogger(logger: Logger): Promise<void> {
  await logger.info('called through the Logger interface', { source: 'useLogger' });
}

// PinoLoggerProvider is assignable to the Logger interface.
const provider = new PinoLoggerProvider({ level: 'info' });

await useLogger(provider);

// stdout:
// {"level":30,...,"source":"useLogger","msg":"called through the Logger interface"}

await provider.shutdown();
```

---

## Levels & Configuration

Control verbosity, provider identity, and the underlying pino instance.

### Set the Log Level Case-Insensitively

Log levels are normalized at construction — `'DEBUG'`, `'debug'`, and `'Debug'` are all accepted and mapped to pino's lowercase format.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

interface LogEntry {
  level: number;
  msg: string;
}

const entries: LogEntry[] = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    entries.push(JSON.parse(chunk.toString()) as LogEntry);
    callback();
  },
});

// 'DEBUG' (uppercase) is normalized internally to pino's lowercase 'debug'.
const logger = new PinoLoggerProvider({ level: 'DEBUG', destination: capture });

await logger.debug('debug details included'); // level 20 — emitted
await logger.info('info also emitted');        // level 30 — emitted

await logger.shutdown();

console.log(entries.length); // 2
```

### Normalize Levels from Environment Variables with normalizeLevel()

`normalizeLevel()` is exported for reuse whenever a level string comes from an untrusted source (environment variables, config files, database settings). Unrecognized values fall back to `'info'` instead of throwing.

```typescript
import { PinoLoggerProvider, normalizeLevel } from 'blendsdk/webafx-pino';

// Environment configuration is conventionally uppercase.
// normalizeLevel() lowercases the value and guards against typos:
//   normalizeLevel('INFO')    -> 'info'
//   normalizeLevel('Debug')   -> 'debug'
//   normalizeLevel('WARN')    -> 'warn'
//   normalizeLevel('verbose') -> 'info'  (unrecognized — safe fallback)
//   normalizeLevel('')        -> 'info'  (unrecognized — safe fallback)
const level: string = normalizeLevel(process.env.LOG_LEVEL ?? 'info');

const logger = new PinoLoggerProvider({ level });

await logger.info('logger configured from environment', { level });

await logger.shutdown();
```

### Set a Custom Service Name

The service name identifies the provider when a plugin registers it in the WebAFX service container. The default is `'logger'`.

```typescript
import { PinoLoggerProvider, DEFAULT_SERVICE_NAME } from 'blendsdk/webafx-pino';

// Default registration name in the WebAFX service container.
console.log(DEFAULT_SERVICE_NAME); // 'logger'

const logger = new PinoLoggerProvider({ serviceName: 'auditLogger' });

// When installed as a plugin, the provider is registered under this name.
console.log(logger.serviceName); // 'auditLogger'

await logger.shutdown();
```

### Pass Additional Pino Options

`pinoOptions` is forwarded to the pino constructor and spread last, so it can tweak anything — for example adding a `name` field or dropping the default `pid`/`hostname` base fields.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({
  level: 'info',
  pinoOptions: {
    name: 'checkout-service', // adds a "name" field to every entry
    base: null,               // drops the default pid/hostname fields
  },
});

await logger.info('payment captured', { orderId: 'ord-9' });

// stdout:
// {"level":30,"time":1730000000000,"name":"checkout-service","orderId":"ord-9","msg":"payment captured"}

await logger.shutdown();
```

---

## Redaction

Keep credentials out of log output. Matched paths are replaced with pino's default censor string `'[Redacted]'`.

### Default Redaction of Sensitive Headers

When `redact` is omitted, `DEFAULT_REDACT_PATHS` applies automatically — `req.headers.authorization` and `req.headers.cookie` are masked with zero configuration.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

interface LogEntry {
  msg: string;
  req: {
    headers: Record<string, string>;
  };
}

const entries: LogEntry[] = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    entries.push(JSON.parse(chunk.toString()) as LogEntry);
    callback();
  },
});

// No redact option -> DEFAULT_REDACT_PATHS apply:
// ['req.headers.authorization', 'req.headers.cookie']
const logger = new PinoLoggerProvider({ level: 'info', destination: capture });

await logger.info('request received', {
  req: {
    headers: {
      authorization: 'Bearer super-secret-token',
      cookie: 'session=abc123',
      'content-type': 'application/json',
    },
  },
});

await logger.shutdown();

console.log(entries[0].req.headers.authorization);   // '[Redacted]'
console.log(entries[0].req.headers.cookie);          // '[Redacted]'
console.log(entries[0].req.headers['content-type']); // 'application/json'
```

### Extend the Default Redact Paths

A custom `redact` array **replaces** the defaults — it does not merge with them. Spread `DEFAULT_REDACT_PATHS` to keep header redaction and add your own paths.

```typescript
import { PinoLoggerProvider, DEFAULT_REDACT_PATHS } from 'blendsdk/webafx-pino';

// Spreading the defaults keeps authorization/cookie redaction active.
const logger = new PinoLoggerProvider({
  level: 'info',
  redact: [...DEFAULT_REDACT_PATHS, 'user.password', 'payment.cardNumber'],
});

await logger.info('login attempt', {
  user: { name: 'admin', password: 'secret123' },
  payment: { cardNumber: '4111111111111111', amount: 42 },
  req: { headers: { authorization: 'Bearer token' } },
});

// stdout (fields abridged):
// {...
//   "user":{"name":"admin","password":"[Redacted]"},
//   "payment":{"cardNumber":"[Redacted]","amount":42},
//   "req":{"headers":{"authorization":"[Redacted]"}},
//   "msg":"login attempt"}

await logger.shutdown();
```

### Disable Redaction Entirely

An explicit empty array disables redaction — the pino `redact` option is skipped entirely for empty arrays.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

// Empty array -> the redact option is skipped; nothing is masked.
const logger = new PinoLoggerProvider({ level: 'info', redact: [] });

await logger.info('request received', {
  req: { headers: { authorization: 'Bearer now-visible' } },
});

// stdout (excerpt) — the header is emitted in plain text:
// {...,"req":{"headers":{"authorization":"Bearer now-visible"}},"msg":"request received"}

await logger.shutdown();
```

---

## Output Routing

Send entries to a pretty printer for local development or to any `Writable` stream for capture and custom transports.

### Pretty-Print Logs for Development

Setting `pretty: true` attaches the `pino-pretty` transport with colorized, human-readable output. It requires the optional `pino-pretty` peer dependency.

```typescript
// Requires the optional peer dependency:
// npm install --save-dev pino-pretty
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'debug', pretty: true });

await logger.info('server started', { port: 3000 });

// stdout (colorized, human-readable — not JSON):
// [12:00:00.000] INFO (1234): server started
//     port: 3000

// pino-pretty runs as a worker-thread transport — flush before exit.
await logger.shutdown();
```

### Capture Log Output with a Writable Stream

Passing a custom `destination` replaces stdout with any Node.js `Writable`. This is the primary testing technique: every entry can be parsed and asserted on.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

/** One JSON object per log entry, parsed out of the stream. */
interface LogEntry {
  level: number;
  msg: string;
  [key: string]: unknown;
}

function createLogCollector(): { stream: Writable; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      entries.push(JSON.parse(chunk.toString()) as LogEntry);
      callback();
    },
  });
  return { stream, entries };
}

const { stream, entries } = createLogCollector();

// 'trace' captures every level; the destination replaces stdout.
const logger = new PinoLoggerProvider({ level: 'trace', destination: stream });

await logger.info('captured', { requestId: 'req-1' });
await logger.shutdown();

console.log(entries[0].msg);       // 'captured'
console.log(entries[0].level);     // 30
console.log(entries[0].requestId); // 'req-1'
```

### A Custom Destination Overrides pretty

`pretty` and `destination` are mutually exclusive — a pino transport and a custom stream cannot be combined. When both are set, the destination wins and `pretty` is silently ignored.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

let captured = '';

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    captured += chunk.toString();
    callback();
  },
});

// pretty is ignored because a custom destination is provided —
// pino-pretty is never invoked here (works even without it installed).
const logger = new PinoLoggerProvider({
  level: 'info',
  pretty: true,
  destination: capture,
});

await logger.info('captured as raw JSON');
await logger.shutdown();

console.log(captured.startsWith('{"level":30,')); // true
```

---

## Request-Scoped Loggers

`createRequestLogger(bindings)` returns a child Logger whose every entry carries the given bindings — the mechanism the WebAFX plugin uses for `req.log` with a `requestId`.

### Bind a requestId to a Child Logger

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

// createRequestLogger() returns a Logger whose every entry carries the bindings.
const requestLogger = logger.createRequestLogger({ requestId: 'abc-123' });

await requestLogger.info('handling request');

// stdout — requestId is merged into the entry:
// {"level":30,"time":1730000000000,"pid":1234,"hostname":"devbox","requestId":"abc-123","msg":"handling request"}

await logger.shutdown();
```

### Merge Bindings with Per-Call Data

Child-logger bindings and per-call `data` land side by side in the same JSON record.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

interface LogEntry {
  msg: string;
  requestId?: string;
  duration?: number;
}

const entries: LogEntry[] = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    entries.push(JSON.parse(chunk.toString()) as LogEntry);
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: 'trace', destination: capture });

const requestLogger = logger.createRequestLogger({ requestId: 'req-456' });
await requestLogger.info('processed', { duration: 42 });

await logger.shutdown();

console.log(entries[0].requestId); // 'req-456'
console.log(entries[0].duration);  // 42
console.log(entries[0].msg);       // 'processed'
```

### Child Loggers Inherit the Parent Level

A child logger inherits the parent's configured level — suppression behaves identically at every level of the hierarchy.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

interface LogEntry {
  msg: string;
}

const entries: LogEntry[] = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    entries.push(JSON.parse(chunk.toString()) as LogEntry);
    callback();
  },
});

// The parent level is 'warn' — child loggers inherit it.
const logger = new PinoLoggerProvider({ level: 'warn', destination: capture });
const child = logger.createRequestLogger({ requestId: 'test' });

await child.debug('suppressed');
await child.info('suppressed');
await child.warn('visible');

await logger.shutdown();

console.log(entries.length); // 1
console.log(entries[0].msg); // 'visible'
```

### Create One Child Logger per Request

Child loggers snapshot their bindings at creation time and are fully independent of each other — one provider can serve any number of concurrent requests without interference.

```typescript
import { Writable } from 'node:stream';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

interface LogEntry {
  msg: string;
  requestId?: string;
}

const entries: LogEntry[] = [];

const capture = new Writable({
  write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    entries.push(JSON.parse(chunk.toString()) as LogEntry);
    callback();
  },
});

const logger = new PinoLoggerProvider({ level: 'trace', destination: capture });

// Independent children — snapshot their bindings at creation time.
const child1 = logger.createRequestLogger({ requestId: 'req-1' });
const child2 = logger.createRequestLogger({ requestId: 'req-2' });

await child1.info('from child 1');
await child2.info('from child 2');

await logger.shutdown();

console.log(entries[0].requestId); // 'req-1'
console.log(entries[1].requestId); // 'req-2'
```

---

## Lifecycle

Health checks and graceful flushes — the same hooks the WebAFX plugin exposes to the application lifecycle.

### Check Health and Shut Down Gracefully

Loggers are stateless, so `health()` always resolves `true` for the pino provider. `shutdown()` resolves once `pino.flush()` has drained buffered entries.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

await logger.info('service starting');

// Pino writes synchronously and has no meaningful failure state.
const healthy: boolean = await logger.health();
console.log(healthy); // true

// Resolves once pino.flush() has drained buffered entries.
await logger.shutdown();
```

### Flush Logs with try/catch/finally

Always call `shutdown()` in a `finally` block so buffered entries are flushed even when business logic throws.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'info' });

async function processBatch(size: number): Promise<void> {
  await logger.info('processing batch', { size });
  await logger.info('batch complete', { size, processed: size });
}

try {
  await processBatch(100);
} catch (error) {
  await logger.error('batch failed', {
    reason: error instanceof Error ? error.message : String(error),
  });
} finally {
  // Guaranteed flush — even when processing throws.
  await logger.shutdown();
}

// stdout:
// {...,"size":100,"msg":"processing batch"}
// {...,"size":100,"processed":100,"msg":"batch complete"}
```

---

## WebAFX Plugin Integration

Wire the provider into a WebAFX application — a one-liner or a provider-first two-step, both installing the same four pieces of wiring.

### Install with the pinoLoggerPlugin() One-Liner

`pinoLoggerPlugin()` constructs the provider from its options and registers everything in a single call.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

// One call constructs the provider and wires everything into WebAFX.
app.use(pinoLoggerPlugin({ level: 'info' }));

// Installing the plugin performs four steps:
// 1. app.setLogger(provider) — replaces the application's default logger
// 2. Express middleware assigns req.log per request
//    (bound to { requestId: req.id } when req.id is present)
// 3. The provider is registered as a singleton service under 'logger'
// 4. health/shutdown hooks join the application lifecycle
```

### Install a Pre-Built Provider with createLoggerPlugin()

The two-step form lets you configure the provider yourself (including a custom `serviceName`) and wrap it in a plugin definition.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import { PinoLoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();

// Two-step form: build and configure the provider first,
// then wrap it in a plugin definition.
const provider = new PinoLoggerProvider({
  level: 'debug',
  serviceName: 'appLogger',
});

app.use(createLoggerPlugin(provider));

// Because the provider declares serviceName 'appLogger', the plugin
// registers it in the service container under that name ('logger' is default).
```

### Override the Plugin Priority

Plugins install in ascending priority order. The logger defaults to priority `20` (`DEFAULT_PLUGIN_PRIORITY`) — before the cache and mailer plugins at `30`. Both factories accept an override.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import {
  pinoLoggerPlugin,
  createLoggerPlugin,
  PinoLoggerProvider,
  DEFAULT_PLUGIN_PRIORITY,
} from 'blendsdk/webafx-pino';

// The logger installs at priority 20 by default — before cache/mailer (30).
console.log(DEFAULT_PLUGIN_PRIORITY); // 20

// One-liner form: priority travels in the same options object (lower installs first).
const app = new WebApplication();
app.use(pinoLoggerPlugin({ level: 'info', priority: 5 }));

// Provider-first form: priority is a separate options argument.
const secondApp = new WebApplication();
const provider = new PinoLoggerProvider({ level: 'info' });
secondApp.use(createLoggerPlugin(provider, { priority: 5 }));
```

### Log from Express Handlers with req.log

The plugin middleware attaches a request-scoped logger to every request. When upstream middleware (e.g., express-request-id) set `req.id`, each entry automatically carries it as `requestId`.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Request, Response } from 'express';
import { pinoLoggerPlugin } from 'blendsdk/webafx-pino';

const app = new WebApplication();
app.use(pinoLoggerPlugin({ level: 'info' }));

// Handlers run after the plugin middleware, so req.log is available.
// req.id is set by upstream middleware (e.g., express-request-id).
async function listOrders(req: Request, res: Response): Promise<void> {
  await req.log?.info('listing orders', { path: req.path, method: req.method });
  res.status(200).json({ orders: [] });
}

// Effective entry emitted for a request with req.id === 'req-7':
// {"level":30,...,"requestId":"req-7","path":"/orders","method":"GET","msg":"listing orders"}

// Keep the handler referenced so the snippet compiles as a unit.
void listOrders;
```

### Production-Ready Plugin Configuration

A realistic setup: level and redaction resolved from the environment, human-readable output only outside production, and the standard install order.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import {
  pinoLoggerPlugin,
  normalizeLevel,
  DEFAULT_PLUGIN_PRIORITY,
  DEFAULT_REDACT_PATHS,
} from 'blendsdk/webafx-pino';

const isProduction: boolean = process.env.NODE_ENV === 'production';

const app = new WebApplication();

app.use(
  pinoLoggerPlugin({
    // LOG_LEVEL is conventionally uppercase — normalizeLevel() handles it.
    level: normalizeLevel(process.env.LOG_LEVEL ?? 'info'),
    // Keep the default header redaction and add application-specific paths.
    redact: [...DEFAULT_REDACT_PATHS, 'user.password'],
    // Human-readable locally; raw JSON in production.
    // `pretty` requires the optional pino-pretty peer dependency.
    pretty: !isProduction,
    priority: DEFAULT_PLUGIN_PRIORITY,
  }),
);

// Production install: JSON on stdout, level and redaction resolved
// from the environment, installed before cache/mailer plugins.
```

---

## Custom Providers

The plugin accepts any `LoggerProvider` — not only the pino implementation — so you can swap logging backends without touching application wiring.

### Subclass LoggerProvider for a Custom Backend

Implement the abstract members once, use the provider standalone, and install the same instance as a WebAFX plugin.

```typescript
import { WebApplication } from 'blendsdk/webafx';
import type { Logger } from 'blendsdk/webafx';
import { LoggerProvider, createLoggerPlugin } from 'blendsdk/webafx-pino';

/**
 * Minimal custom provider that keeps entries in memory.
 * LoggerProvider enforces the Logger contract plus
 * health(), shutdown(), and request-scoped child loggers.
 */
class MemoryLoggerProvider extends LoggerProvider {
  readonly entries: Array<{ level: string; message: string; data: Record<string, unknown> }> = [];

  async info(message: string, data?: Record<string, unknown>): Promise<void> {
    this.entries.push({ level: 'info', message, data: { ...data } });
  }

  async error(message: string, data?: Record<string, unknown>): Promise<void> {
    this.entries.push({ level: 'error', message, data: { ...data } });
  }

  async warn(message: string, data?: Record<string, unknown>): Promise<void> {
    this.entries.push({ level: 'warn', message, data: { ...data } });
  }

  async debug(message: string, data?: Record<string, unknown>): Promise<void> {
    this.entries.push({ level: 'debug', message, data: { ...data } });
  }

  async health(): Promise<boolean> {
    return true;
  }

  async shutdown(): Promise<void> {
    // Nothing buffered outside memory — nothing to flush.
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

// Standalone usage.
const provider = new MemoryLoggerProvider({ serviceName: 'memoryLogger' });
await provider.info('standalone entry', { ok: true });

// The same provider installs in WebAFX — createLoggerPlugin() accepts
// ANY LoggerProvider, not just PinoLoggerProvider.
const app = new WebApplication();
app.use(createLoggerPlugin(provider, { priority: 25 }));

console.log(provider.entries.length); // 1
```

---

## Testing Patterns

Assert on structured output and verify the plugin surface in your own test suite. Both patterns are taken from the package's Vitest suite.

### Capture and Assert Structured Output with Vitest

Create a test provider backed by a capturing `Writable`, then assert on parsed JSON entries — levels, data fields, suppression, and redaction.

```typescript
import { Writable } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

interface LogEntry {
  level: number;
  msg: string;
  [key: string]: unknown;
}

function createTestProvider(level = 'trace'): { provider: PinoLoggerProvider; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      entries.push(JSON.parse(chunk.toString()) as LogEntry);
      callback();
    },
  });
  const provider = new PinoLoggerProvider({ level, destination: stream });
  return { provider, entries };
}

let activeProvider: PinoLoggerProvider | null = null;

afterEach(async () => {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
});

describe('PinoLoggerProvider', () => {
  it('merges structured data into the JSON entry', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    await provider.info('server started', { port: 3000, host: 'localhost' });

    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('server started');
    expect(entries[0].level).toBe(30);
    expect(entries[0].port).toBe(3000);
    expect(entries[0].host).toBe('localhost');
  });

  it('maps each method to its numeric pino level', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    await provider.debug('d');
    await provider.info('i');
    await provider.warn('w');
    await provider.error('e');

    expect(entries.map((entry) => entry.level)).toEqual([20, 30, 40, 50]);
  });

  it('suppresses entries below the configured level', async () => {
    const { provider, entries } = createTestProvider('info');
    activeProvider = provider;

    await provider.debug('suppressed');
    await provider.info('visible');

    expect(entries).toHaveLength(1);
    expect(entries[0].msg).toBe('visible');
  });

  it('redacts default sensitive header paths', async () => {
    const { provider, entries } = createTestProvider();
    activeProvider = provider;

    await provider.info('request', {
      req: { headers: { authorization: 'Bearer secret-token', cookie: 'session=abc123' } },
    });

    const serialized = JSON.stringify(entries[0]);
    expect(serialized).toContain('[Redacted]');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('session=abc123');
  });
});

// Run with: npx vitest run
```

### Test the Plugin Definition Surface

Plugin factories return plain `PluginDefinition` objects — assert on their identity, priority, and factory without booting a WebAFX application.

```typescript
import { describe, it, expect } from 'vitest';
import {
  pinoLoggerPlugin,
  createLoggerPlugin,
  PinoLoggerProvider,
  DEFAULT_PLUGIN_PRIORITY,
} from 'blendsdk/webafx-pino';

describe('pinoLoggerPlugin', () => {
  it('produces a PluginDefinition with the expected identity', () => {
    const plugin = pinoLoggerPlugin();

    expect(plugin.name).toBe('pino-logger');
    expect(plugin.priority).toBe(DEFAULT_PLUGIN_PRIORITY); // 20
    expect(plugin.factory).toBeInstanceOf(Function);
  });

  it('accepts a priority override', () => {
    const plugin = pinoLoggerPlugin({ priority: 5 });

    expect(plugin.priority).toBe(5);
  });
});

describe('createLoggerPlugin', () => {
  it('wraps a pre-built provider', () => {
    const provider = new PinoLoggerProvider({ level: 'silent' });
    const plugin = createLoggerPlugin(provider, { priority: 10 });

    expect(plugin.name).toBe('pino-logger');
    expect(plugin.priority).toBe(10);
    expect(plugin.factory).toBeInstanceOf(Function);
  });
});

// Run with: npx vitest run
```

---

## Advanced

Escape hatches and pino-level customization for scenarios the `Logger` interface does not cover.

### Access the Raw Pino Instance

`getPinoInstance()` exposes the underlying pino logger — useful for level checks, and for handing the instance to pino ecosystem tooling.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

const logger = new PinoLoggerProvider({ level: 'debug' });

// The escape hatch: the underlying pino logger instance.
const raw = logger.getPinoInstance();

console.log(raw.level);        // 'debug'
console.log(typeof raw.child); // 'function'

// Guard expensive payload construction behind a level check.
if (raw.isLevelEnabled('debug')) {
  const diagnostics = Array.from({ length: 3 }, (_value, index) => ({ index }));
  await logger.debug('diagnostics computed', { diagnostics });
}

// Typical advanced use: hand `raw` to pino ecosystem tooling
// (for example, a pino-http middleware) that expects a pino instance.

await logger.shutdown();
```

### Configure Custom Serializers

Serializers control what data is extracted when a top-level field such as `req` or `res` is logged — for example, reducing a request object to `method` and `url` only.

```typescript
import { PinoLoggerProvider } from 'blendsdk/webafx-pino';

/** Type guard narrowing an unknown value to a minimal request shape. */
function isRequestLike(value: unknown): value is { method: string; url: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    'url' in value
  );
}

const logger = new PinoLoggerProvider({
  level: 'info',
  serializers: {
    // Applied whenever a top-level `req` field is logged.
    req: (req: unknown) => (isRequestLike(req) ? { method: req.method, url: req.url } : req),
    res: (res: unknown) => res,
  },
});

await logger.info('incoming request', {
  req: { method: 'GET', url: '/orders', headers: { authorization: 'Bearer secret' } },
});

// stdout — the serializer reduced req to method + url:
// {"level":30,...,"req":{"method":"GET","url":"/orders"},"msg":"incoming request"}

await logger.shutdown();
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
