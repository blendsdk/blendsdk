> **Package**: `blendsdk/webafx-i18n`

# webafx-i18n Best Practices

---

This guide collects the practices that keep `blendsdk/webafx-i18n` installations correct, observable, and fast. Most of them follow from three properties of the package: **sources are merged in order (the last source wins per key + locale)**, the **`Translator` is a process-wide singleton that only the plugin should swap**, and **reload re-executes every source from scratch**. The ❌/✅ pairs below show the wrong and right shape of the same code, followed by anti-patterns, performance tips, and security considerations.

---

## Do / Don't Pairs

### 1. Order sources so the most authoritative data wins

**❌ Wrong** — the database is loaded first, so the JSON files (loaded later) override every administrator edit at startup and on every reload:

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createTranslationsPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        sources: [
            postgresqlSource({ queryFn: (sql) => database.query(sql) }),
            jsonFileSource({ paths: ["./translations/*.json"] }),
        ],
    });
}
```

**✅ Correct** — base files first, database rows last so maintained translations take precedence:

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createTranslationsPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            postgresqlSource({ queryFn: (sql) => database.query(sql) }),
        ],
    });
}
```

**Why:** `mergeCatalogs` applies sources left to right — for the same key + locale, the last source that defines it wins. Getting the order backwards silently discards data (file values stomp database edits) with no error and no log entry pointing at the cause.

---

### 2. Use the per-request `locale` service — don't re-implement resolution

**❌ Wrong** — reading `req.query.locale` directly skips `Accept-Language`, the cookie, `en-US` → `en_US` normalization, and the configured default:

```typescript
import type { Request, Response } from "express";
import type { Translator } from "blendsdk/webafx-i18n";

export async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    const raw = req.query.locale;
    const locale = typeof raw === "string" && raw.trim() ? raw.trim() : "en";
    res.json({ message: translator.translate("greeting", locale) });
}
```

**✅ Correct** — resolve the locale from the service the plugin registered:

```typescript
import type { Request, Response } from "express";
import type { Translator } from "blendsdk/webafx-i18n";

export async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");
    res.json({ message: translator.translate("greeting", locale) });
}
```

**Why:** `resolveLocale` implements a documented priority chain (query → `Accept-Language` → cookie → default) and persists the resolved locale in a cookie. A hand-rolled version inevitably drifts from that contract, handles fewer signals, and produces a different locale than the rest of the application for the same request.

---

### 3. Read translations from the registered `Translator` — don't build your own

**❌ Wrong** — constructing a second `Translator` next to the plugin creates a disconnected source of truth that never sees source merges or reloads:

```typescript
import { Translator } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

const bootstrapCatalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
};

const translator = new Translator({
    defaultLocale: "en",
    catalog: bootstrapCatalog,
});

export function greetingFor(locale: string): string {
    return translator.translate("greeting", locale);
}
```

**✅ Correct** — resolve the singleton the plugin created from the configured sources:

```typescript
import type { Request } from "express";
import type { Translator } from "blendsdk/webafx-i18n";

export async function greetingFor(req: Request): Promise<string> {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");
    return translator.translate("greeting", locale);
}
```

**Why:** the registered translator holds the merged catalog from every configured source, forwards `onMissingTranslation`, and is the instance that `setCatalog()` swaps during reloads. A hand-built one duplicates data in memory, ignores the merge pipeline, and keeps serving a stale snapshot after every reload. (Constructing `Translator` yourself is only appropriate outside a WebAFX app, where the plugin is not installed.)

---

### 4. Always configure `onMissingTranslation`

**❌ Wrong** — without the hook, missing keys leave no trace anywhere except the rendered output:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export function createTranslationsPlugin(): PluginDefinition {
    return createI18nPlugin({
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    });
}
```

**✅ Correct** — forward the hook to your logging or metrics pipeline:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export function createTranslationsPlugin(
    reportMissing: (key: string, locale: string) => void
): PluginDefinition {
    return createI18nPlugin({
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
        onMissingTranslation: (key, locale) => {
            reportMissing(key, locale);
        },
    });
}
```

**Why:** the hook fires on every unresolved lookup, with the exact key and locale, in the request that needed it. That is the difference between "users report the German page looks odd" and a dashboard showing `checkout.submit → de` was never translated.

---

### 5. Let `load()` errors propagate — the plugin applies the phase-appropriate policy

**❌ Wrong** — swallowing errors inside the source hides failures in both phases and turns reloads into silent data loss:

```typescript
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";

export class SwallowingSource implements TranslationSource {
    readonly name = "SwallowingSource";

    constructor(private readonly fetchCatalog: () => Promise<TranslationCatalog>) {}

    async load(): Promise<TranslationCatalog> {
        try {
            return await this.fetchCatalog();
        } catch {
            // ❌ Startup boots with missing strings; a failed reload silently
            // drops this source's overrides on top of an empty catalog
            return {};
        }
    }
}
```

**✅ Correct** — return the promise and let the plugin decide:

```typescript
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";

export class PropagatingSource implements TranslationSource {
    readonly name = "PropagatingSource";

    constructor(private readonly fetchCatalog: () => Promise<TranslationCatalog>) {}

    async load(): Promise<TranslationCatalog> {
        // ✅ Startup fails fast; reload errors are caught by the plugin,
        // which logs them and keeps the previous catalog intact
        return this.fetchCatalog();
    }
}
```

**Why:** the plugin's error semantics are deliberate. At startup, a rejected `load()` fails plugin initialization — the problem surfaces immediately instead of shipping a half-translated app. At reload, errors are caught and logged and the previous catalog is kept, so a broken backend never takes the application down. Catching inside the source defeats both behaviors.

---

### 6. Reload via the `i18n:reload` service or pub/sub — not ad-hoc loads

**❌ Wrong** — loading a fresh source instance does nothing to the live translator the application serves from:

```typescript
import { jsonFileSource } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function reload(req: Request, res: Response): Promise<void> {
    const source = jsonFileSource({ paths: ["./translations/*.json"] });
    await source.load();
    res.json({ reloaded: true });
}
```

**✅ Correct** — reuse the plugin's reload function, which re-runs every source and swaps the shared catalog:

```typescript
import type { Request, Response } from "express";

export async function reload(req: Request, res: Response): Promise<void> {
    const reloadAll = await req.services.get<() => Promise<void>>("i18n:reload");
    await reloadAll();
    res.json({ reloaded: true });
}
```

**Why:** the reload service re-executes *all* sources in configuration order, re-merges with the same precedence rules, logs progress, and calls `translator.setCatalog()` on the shared singleton — so every subsequent request sees the new data. Note the naming rule: when you customize `serviceName`, the reload service becomes `${serviceName}:reload`.

---

### 7. Disable locale cookie persistence for non-browser clients

**❌ Wrong** — an API-only service keeps the default cookie name, so every response carries a `Set-Cookie` header no token client needs:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export function createApiPlugin(): PluginDefinition {
    return createI18nPlugin({
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    });
}
```

**✅ Correct** — turn persistence off when the client decides the locale per request:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export function createApiPlugin(): PluginDefinition {
    return createI18nPlugin({
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
        localeCookieName: false,
    });
}
```

**Why:** cookie persistence exists for the browser use case — a visitor's language choice sticking across visits. For API clients the cookie is dead weight: an extra header on every response, per-user state on endpoints that would otherwise be shared-cacheable, and a preference that cannot stick anyway. Resolution still works through `?locale=` and `Accept-Language`.

---

### 8. Keep Node-only sources out of browser bundles

**❌ Wrong** — a module shared between server and browser imports the Node-only file source, dragging filesystem dependencies into the client bundle:

```typescript
// shared/translation-module.ts — bundled for both server and browser
import { jsonFileSource } from "blendsdk/webafx-i18n";
import type { TranslationSource } from "blendsdk/webafx-i18n";

export function createFileSource(): TranslationSource {
    return jsonFileSource({ paths: ["./translations/*.json"] });
}
```

**✅ Correct** — server modules use this package; browser modules use the browser-safe core directly:

```typescript
// server/translation-module.ts — Node.js only
import { jsonFileSource } from "blendsdk/webafx-i18n";
import type { TranslationSource } from "blendsdk/webafx-i18n";

export function createFileSource(): TranslationSource {
    return jsonFileSource({ paths: ["./translations/*.json"] });
}
```

```typescript
// client/translation-module.ts — browser bundle
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
};

export function createBrowserTranslator(): Translator {
    return new Translator({ defaultLocale: "en", catalog });
}
```

**Why:** `JsonFileSource` and `ContentFileSource` are re-exported from the Node.js `/node` subpath of the core and depend on the filesystem. Importing them in shared code breaks or bloats browser bundlers. This package is the *server-side* integration layer; browser-only translation work imports `blendsdk/i18n` directly.

---

## Anti-Patterns

### Mixing locale key formats across catalogs and requests

Locale strings flow through resolution mostly unmodified: `?locale=en-US` and cookie values are returned **verbatim** (trimmed only), while `Accept-Language: en-US` is normalized to `en_US` by replacing the first hyphen. A catalog keyed with one format misses requests resolved in the other:

```typescript
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

// ❌ "en-US" arrives from a query param or cookie; "en_US" arrives from the
// Accept-Language header — a hyphen-only catalog matches just one of them
const partial: TranslationCatalog = {
    greeting: { "en-US": "Hello" },
};

// ✅ Pick one canonical scheme and cover every form the resolver can emit
// for the locales you advertise
const complete: TranslationCatalog = {
    greeting: { en: "Hello", "en-US": "Hello", en_US: "Hello" },
};
```

Keep keys lowercase and consistent, and remember that casing is significant — a client sending `NL` resolves to `NL`, which will not match a `nl` key.

---

### Trusting `i18n:reload` as a success signal

The reload path catches errors internally, logs them, and keeps the previous catalog — the promise **always resolves**, even when every source failed. Code like this reports success unconditionally:

```typescript
import type { Request, Response } from "express";

// ❌ "reloaded: true" is returned even when the reload logged
// "reload failed, keeping previous catalog"
export async function reload(req: Request, res: Response): Promise<void> {
    const reloadAll = await req.services.get<() => Promise<void>>("i18n:reload");
    await reloadAll();
    res.json({ reloaded: true });
}
```

If you need failure visibility, watch the plugin's log output or wrap your sources with your own source that records the last load error — do not infer success from the resolved promise.

---

### Reloading on a timer (or per request)

Every reload re-executes every source's `load()` from scratch — for a database source, that is a full table read plus JSON parsing per row, re-merged into a new catalog:

```typescript
import type { Request } from "express";

// ❌ Each interval tick becomes a full re-read of all sources on every instance
export async function startPolling(req: Request): Promise<void> {
    const reloadAll = await req.services.get<() => Promise<void>>("i18n:reload");
    setInterval(() => {
        void reloadAll();
    }, 30_000);
}
```

Trigger reloads **on change** instead: an admin save publishes one message to `reloadChannel`, or an admin endpoint invokes the reload service once. Polling turns a fixed background load into permanent database pressure for data that rarely changes.

---

### Assuming `reloadChannel` is active without the pub/sub plugin

If `blendsdk/webafx-cache` (or whatever provider is registered under `pubsubServiceName`) is not installed, the plugin logs `pub/sub service "..." not available` and **continues normally**:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

// ❌ Without the pub/sub provider this channel silently never fires —
// publishes succeed but nothing reloads anywhere
export const plugin = createI18nPlugin({
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    reloadChannel: "i18n:reload",
});
```

Verify the startup log line (`subscribed to reload channel "..."`) in every environment, and confirm that `pubsubServiceName` matches the name the pub/sub plugin actually registers.

---

### Expecting any JSON array to parse as a plural tuple

`PostgreSQLSource.parseValue()` converts a stored value into a `[singular, plural]` tuple **only** when it parses as a JSON array of exactly two strings. Single-form and three-form arrays are served verbatim as raw strings:

```typescript
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

// ❌ Only exactly-two-string JSON arrays become tuples — a three-form array
// is served as the literal string '["zero","one","many"]'
const broken: TranslationCatalog = {
    books: { ar: '["zero","one","many"]' },
};

// ✅ Use tuples for two-form plurals; represent larger plural sets with
// dedicated keys per form (for example books.zero, books.one, books.many)
const correct: TranslationCatalog = {
    books: { en: ["1 book", "N books"] },
};
```

The same applies to arrays with one element and to malformed JSON — they are all kept as plain strings, by design.

---

### Hard-coding `"i18n:reload"` after renaming `serviceName`

When you customize `serviceName`, the plugin name *and* the reload service name change with it. A handler that still resolves `"i18n:reload"` fails at runtime with a service-not-found error — and only in the environments that use the custom name:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

// Plugin registered as "translator" …
createI18nPlugin({
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    serviceName: "translator",
});

// ❌ … so the reload service is "translator:reload", not "i18n:reload"
const reloadAll = await req.services.get<() => Promise<void>>("i18n:reload");
```

Keep the service names in shared constants and derive the reload name from them (`${serviceName}:reload`) so the two never drift apart.

---

## Performance Tips

1. **Resolve once per request and pass it down.** Locale resolution reads the query, parses and sorts `Accept-Language`, checks the cookie, and (with a configured cookie name) persists the result. Resolve both services once at the top of the request and hand them to helpers:

    ```typescript
    import type { Request } from "express";
    import type { Translator } from "blendsdk/webafx-i18n";

    export interface TranslateContext {
        translator: Translator;
        locale: string;
    }

    export async function createTranslateContext(req: Request): Promise<TranslateContext> {
        return {
            translator: await req.services.get<Translator>("i18n"),
            locale: await req.services.get<string>("locale"),
        };
    }
    ```

    Translating ten keys with one context means one resolution and one consistent locale for the whole response.

2. **Load only the rows you serve.** `PostgreSQLSource.load()` selects the full table (plus your filter) and runs `parseValue()` — including a `JSON.parse` for every `[`-prefixed value — on each row. The catalog then stays in memory for the process lifetime and is rebuilt on every reload. A scoped filter keeps startup time, reload time, and per-instance memory proportional to what the application actually uses:

    ```typescript
    filter: "active = true AND app = 'myapp'"
    ```

3. **Keep the source list short — loading is sequential.** The plugin awaits each source's `load()` in configuration order, so startup and reload time is the *sum* of all source load times. Four overlapping file patterns are four sequential I/O passes; consolidate them into one source with one glob where possible.

4. **Reload on change, not on a schedule.** A reload is a full re-read plus re-merge, not an incremental diff. Publishing one pub/sub message the moment translations are edited keeps reload frequency proportional to real edits; polling every minute makes it proportional to the clock instead (see the anti-pattern above).

5. **Keep `onMissingTranslation` constant-time.** The hook is a synchronous callback invoked in the translation path every time a key is missing — precisely when the request is already paying a fallback cost. Increment a counter, push to a buffer, or forward to the app logger; avoid synchronous I/O or heavy string formatting in the hook.

6. **Stagger fleet-wide reloads if the burst matters.** A single publish makes *every* subscribed instance reload in parallel — N instances × a full source read hit the backend at once. If your database is sensitive to that burst, wrap sources with a small jitter before the actual load:

    ```typescript
    import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";

    export class JitteredSource implements TranslationSource {
        constructor(
            private readonly inner: TranslationSource,
            private readonly maxDelayMs = 2000
        ) {}

        get name(): string {
            return this.inner.name;
        }

        async load(): Promise<TranslationCatalog> {
            const delay = Math.random() * this.maxDelayMs;
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            return this.inner.load();
        }
    }
    ```

    ```typescript
    import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
    import type { PluginDefinition } from "blendsdk/webafx";
    import { JitteredSource } from "./jittered-source.js";

    interface DatabaseClient {
        query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
    }

    export function createJitteredPlugin(database: DatabaseClient): PluginDefinition {
        return createI18nPlugin({
            sources: [
                jsonFileSource({ paths: ["./translations/*.json"] }),
                new JitteredSource(
                    postgresqlSource({ queryFn: (sql) => database.query(sql) })
                ),
            ],
        });
    }
    ```

7. **Disable the cookie for API traffic.** With a cookie name configured, the per-request factory writes a `Set-Cookie` header on every response. `localeCookieName: false` removes that header, shrinks responses, and keeps endpoints shared-cache friendly (see pair 7).

---

## Security Considerations

### `tableName` and `filter` are interpolated SQL — treat them as code, not data

`PostgreSQLSource` concatenates `tableName` and `filter` directly into the query string; there is no parameter binding for identifiers or `WHERE` fragments. Never thread request input, user-editable config, or admin-panel values into them:

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

// ❌ filter is concatenated into the SQL text verbatim — this is an
// injection vector the moment the argument is not developer-controlled
export function unsafeSource(database: DatabaseClient, filter: string) {
    return postgresqlSource({
        queryFn: (sql) => database.query(sql),
        filter,
    });
}

// ✅ Fragments come only from literal, developer-authored constants
export function safeSource(database: DatabaseClient) {
    return postgresqlSource({
        queryFn: (sql) => database.query(sql),
        tableName: "translations",
        filter: "active = true AND app = 'myapp'",
    });
}
```

If the filter genuinely must vary, map it from a closed set of predefined constant strings — never assemble it from strings that crossed a trust boundary.

---

### Validate the resolved locale before using it outside catalog lookups

`resolveLocale()` returns the `?locale=` value trimmed and otherwise **unvalidated**, and `parseAcceptLanguage()` can return any token a client sends (for example `zz-ZZ` → `zz_ZZ`). Catalog lookup is a safe map read, but a locale fed into file paths, template selection, redirects, or database queries is attacker-controlled text:

```typescript
const SUPPORTED_LOCALES = new Set(["en", "nl", "de"]);

export function sanitizeLocale(requested: string, fallback: string): string {
    return SUPPORTED_LOCALES.has(requested) ? requested : fallback;
}
```

Apply the allowlist at the point of use — especially in custom `TranslationSource` implementations that build file names or URLs from a locale.

---

### The locale cookie is a preference, not a credential

The plugin writes the cookie with `httpOnly: false`, `sameSite: "lax"`, and a one-year max age, and the `?locale=` query parameter overrides everything upstream of it anyway. Any client can set any locale value at any time. Never branch authorization, feature access, or sensitive content on the resolved locale or the cookie — locale selection is inherently public input.

---

### Protect the reload triggers

Both reload paths — the `i18n:reload` service you expose (if you do) and publish rights on `reloadChannel` — let a caller force a full re-read of every source on every instance. An unauthenticated reload endpoint or broadly shared pub/sub credentials turn a cheap message into a fleet-wide database hit (a denial-of-service lever):

- Gate any reload endpoint behind admin authentication and rate limits.
- Scope channel publish permissions to trusted services only.
- Treat the channel as a control plane trigger: the message payload is ignored by the subscriber, so there is no data-injection surface — but the *trigger itself* is powerful.

---

### Keep secrets out of `load()` error messages

When a reload fails, the plugin logs the error message verbatim (`reload failed, keeping previous catalog: <message>`), and the same message surfaces in startup failures. Make sure your source implementations — and the database clients behind `queryFn` — do not embed connection strings, credentials, or tokens in thrown error messages. Log the failure, not the secret.

---

# webafx-i18n Testing Patterns

---

This document shows how to test code built on `blendsdk/webafx-i18n`: the plugin factory, translation sources, locale resolution, cookie persistence, and reload behavior. The patterns mirror the package's own Vitest suite — `tests/i18n-plugin.test.ts`, `tests/locale-resolver.test.ts`, and `tests/postgresql-source.test.ts` — which runs entirely in-process with mocked I/O. Every example is complete TypeScript (strict mode) and builds on the shared helpers introduced in [Test Setup](#test-setup).

---

## Test Setup

### Test Framework and Configuration

The package tests run with Vitest 4 in a plain Node environment. In a consumer project, install Vitest as a dev dependency (`npm install -D vitest`) — no other test tooling is required. A minimal `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
    },
});
```

Key points:

- **No browser environment is needed.** The plugin, the sources, and the locale resolver are all server-side. Express-style `Request` objects are mocked, never served.
- **No Docker containers or external services.** The package's own suite mocks every I/O boundary: sources are `vi.fn()` doubles, database access goes through the injected `queryFn` callback, and the WebAFX application is a boundary mock. (An opt-in live-database pattern is shown under [Integration Testing](#integration-testing).)
- **ESM with `.js` specifiers.** The package is `"type": "module"`. The package's own tests import internals with explicit `.js` extensions (for example `../src/i18n-plugin.js`); consumer tests import the public entry point `blendsdk/webafx-i18n`.
- **Strict TypeScript.** All helpers and tests below are fully typed — no `any`.

The scripts defined by the package:

| Script | Command | Purpose |
| --- | --- | --- |
| `npm test` | `vitest run --reporter=verbose` | Single verbose run (CI-friendly) |
| `npm run test:fast` | `vitest run --reporter=verbose` | Alias of `test` |
| `npm run test:watch` | `vitest watch --reporter=verbose` | Watch mode for local development |

### Required Imports

The canonical import block used throughout this document:

```typescript
import { describe, expect, it, vi } from "vitest";
import {
    createI18nPlugin,
    parseAcceptLanguage,
    PostgreSQLSource,
    postgresqlSource,
    resolveLocale,
} from "blendsdk/webafx-i18n";
import type {
    I18nPluginConfig,
    TranslationCatalog,
    TranslationSource,
    Translator,
} from "blendsdk/webafx-i18n";
import type { Plugin, PluginDefinition } from "blendsdk/webafx";
import type { Request } from "express";
```

Where each import comes from:

| Source | What it provides |
| --- | --- |
| `vitest` | `describe`, `it`, `expect`, `vi`, and the `Mock` type |
| `blendsdk/webafx-i18n` | `createI18nPlugin`, `resolveLocale`, `parseAcceptLanguage`, `PostgreSQLSource` / `postgresqlSource`, and the re-exported `Translator` / `mergeCatalogs` |
| `blendsdk/webafx-i18n` (types) | `I18nPluginConfig`, `TranslationCatalog`, `TranslationSource`, `TranslatorConfig`, etc. |
| `blendsdk/webafx` (types) | `PluginDefinition`, `Plugin`, `Logger` |
| `express` (types only) | `Request` for locale-resolution tests |

### Test Helpers

The package's own test files define equivalent doubles inline. Extracting them into a `tests/helpers.ts` module — as shown below — keeps consumer suites DRY and confines the two framework-boundary assertions to one place (see [Boundary Casts, Explained](#boundary-casts-explained)).

```typescript
import { vi } from "vitest";
import type { Mock } from "vitest";
import type { TranslationCatalog, TranslationSource } from "blendsdk/webafx-i18n";
import type { Plugin, PluginDefinition } from "blendsdk/webafx";
import type { Request } from "express";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Create a TranslationSource double whose load() resolves to `catalog`. */
export function mockSource(name: string, catalog: TranslationCatalog): TranslationSource {
    return {
        name,
        load: vi.fn<() => Promise<TranslationCatalog>>().mockResolvedValue(catalog),
    };
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface MockLogger {
    info: Mock<(message: string) => Promise<void>>;
    error: Mock<(message: string) => Promise<void>>;
    warn: Mock<(message: string) => Promise<void>>;
    debug: Mock<(message: string) => Promise<void>>;
}

function logFn(): Mock<(message: string) => Promise<void>> {
    return vi.fn<(message: string) => Promise<void>>().mockResolvedValue(undefined);
}

/** Create a fully mocked WebAFX Logger with async no-op methods. */
export function mockLogger(): MockLogger {
    return {
        info: logFn(),
        error: logFn(),
        warn: logFn(),
        debug: logFn(),
    };
}

// ---------------------------------------------------------------------------
// WebAFX application
// ---------------------------------------------------------------------------

/** A service definition recorded from app.registerService() calls. */
export interface RegisteredService {
    name: string;
    type: string;
    factory: (...args: unknown[]) => unknown;
}

/** A pub/sub provider double for exercising the reload channel. */
export interface MockPubSub {
    subscribe: Mock<(channel: string, handler: () => Promise<void>) => Promise<void>>;
}

/** Create a pub/sub provider double; pass it to mockApp({ pubsub }). */
export function mockPubSub(): MockPubSub {
    return {
        subscribe: vi
            .fn<(channel: string, handler: () => Promise<void>) => Promise<void>>()
            .mockResolvedValue(undefined),
    };
}

export interface MockAppOptions {
    /**
     * When provided, services.get() resolves to this provider — enabling
     * the plugin's reload-channel subscription. By default services.get()
     * rejects, simulating a container without a pub/sub provider installed.
     */
    pubsub?: MockPubSub;
}

/** Minimal WebAFX application double that records service registrations. */
export interface MockApp {
    registerService: Mock<(definition: RegisteredService) => void>;
    services: {
        get: Mock<(name: string) => Promise<unknown>>;
    };
    /** Registrations from registerService() calls, keyed by service name. */
    _registeredServices: Record<string, RegisteredService>;
}

/** Create a mock WebAFX application for plugin-factory tests. */
export function mockApp(options: MockAppOptions = {}): MockApp {
    const registeredServices: Record<string, RegisteredService> = {};
    const get = vi.fn<(name: string) => Promise<unknown>>();

    if (options.pubsub) {
        get.mockResolvedValue(options.pubsub);
    } else {
        get.mockRejectedValue(new Error("Service not found"));
    }

    return {
        registerService: vi.fn((definition: RegisteredService) => {
            registeredServices[definition.name] = definition;
        }),
        services: { get },
        _registeredServices: registeredServices,
    };
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

type PluginFactoryContext = Parameters<NonNullable<PluginDefinition["factory"]>>[0];

/**
 * Run a plugin factory to completion with the mock collaborators.
 *
 * WebAFX owns the real application and Express namespace types, whose full
 * interfaces (HTTP server, routing, middleware, ...) are irrelevant to i18n
 * behavior. The boundary assertions confine that impedance mismatch here.
 */
export async function startPlugin(
    plugin: PluginDefinition,
    app: MockApp,
    logger: MockLogger
): Promise<Plugin> {
    const instance = await plugin.factory({
        app: app as unknown as PluginFactoryContext["app"],
        express: {} as unknown as PluginFactoryContext["express"],
        logger: logger as unknown as PluginFactoryContext["logger"],
    });

    if (!instance) {
        throw new Error("Plugin factory did not return a Plugin instance");
    }

    return instance as Plugin;
}

/** Resolve a singleton service registered by the plugin, typed as T. */
export function resolveService<T>(app: MockApp, name: string): T {
    const definition = app._registeredServices[name];
    if (!definition) {
        throw new Error(`Service "${name}" was not registered`);
    }
    return definition.factory() as T;
}

/** Invoke a per-request service factory with a mock request and response. */
export function invokePerRequestService<T>(
    app: MockApp,
    name: string,
    req: Request,
    res: MockResponse
): T {
    const definition = app._registeredServices[name];
    if (!definition) {
        throw new Error(`Service "${name}" was not registered`);
    }
    return definition.factory(undefined, undefined, req, res) as T;
}

// ---------------------------------------------------------------------------
// Express doubles
// ---------------------------------------------------------------------------

export interface MockRequestOverrides {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
}

/**
 * Create a minimal Express Request carrying only the fields the locale
 * resolver reads: query, headers, and cookies.
 */
export function mockRequest(overrides: MockRequestOverrides = {}): Request {
    return {
        query: overrides.query ?? {},
        headers: overrides.headers ?? {},
        cookies: overrides.cookies ?? {},
    } as unknown as Request;
}

/** Minimal Express Response double — only the cookie() call the plugin makes. */
export interface MockResponse {
    cookie: Mock<(name: string, value: string, options?: Record<string, unknown>) => void>;
}

/** Create a mock Express Response for cookie-persistence assertions. */
export function mockResponse(): MockResponse {
    return {
        cookie: vi.fn<(name: string, value: string, options?: Record<string, unknown>) => void>(),
    };
}
```

Helper quick reference:

| Helper | Returns | Use it for |
| --- | --- | --- |
| `mockSource(name, catalog)` | `TranslationSource` | Source loading, merge-order, and reload tests |
| `mockLogger()` | `MockLogger` | Asserting plugin progress and error messages |
| `mockApp(options?)` | `MockApp` | Capturing service registrations; simulating the container |
| `mockPubSub()` | `MockPubSub` | Capturing the reload-channel subscription handler |
| `startPlugin(plugin, app, logger)` | `Promise<Plugin>` | Running `plugin.factory()` against the mocks |
| `resolveService<T>(app, name)` | `T` | Reading the registered `Translator` or reload function back out |
| `invokePerRequestService<T>(app, name, req, res)` | `T` | Exercising the per-request `locale` service directly |
| `mockRequest(overrides?)` | `Request` | Locale-resolution and locale-service tests |
| `mockResponse()` | `MockResponse` | Cookie-persistence assertions |

---

## Unit Testing

Unit tests for this package follow three rules:

1. **Replace I/O at the seams the package exposes** — `TranslationSource`, `queryFn`, the WebAFX application/container, and the logger. These are the only collaborators the plugin talks to.
2. **Keep the real translation machinery in play** — `Translator`, `mergeCatalogs`, `resolveLocale`, and `parseAcceptLanguage` are deterministic and in-memory. Mocking them would hide the very bugs worth catching.
3. **Assert on observable behavior** — registered services, returned translations, emitted log calls, and persisted cookies.

### Testing the Plugin Definition

`createI18nPlugin()` is a pure function: it validates configuration and returns a `PluginDefinition` without touching any I/O. Test it synchronously.

```typescript
import { describe, expect, it } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";

describe("createI18nPlugin", () => {
    it("uses the default service name and priority", () => {
        const plugin = createI18nPlugin({ sources: [] });

        expect(plugin.name).toBe("i18n");
        expect(plugin.priority).toBe(40);
        expect(typeof plugin.factory).toBe("function");
    });

    it("honors a custom service name and priority", () => {
        const plugin = createI18nPlugin({
            sources: [],
            serviceName: "translations",
            priority: 10,
        });

        expect(plugin.name).toBe("translations");
        expect(plugin.priority).toBe(10);
    });
});
```

### Testing the Plugin Factory

The factory performs the real work: it loads every source, builds the `Translator`, and registers three services (`i18n`, `i18n:reload`, `locale`). Test it asynchronously with `mockApp()` and `mockLogger()`.

```typescript
import { describe, expect, it } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import { mockApp, mockLogger, mockSource, startPlugin } from "./helpers.js";

describe("plugin factory", () => {
    it("loads every source and registers three services", async () => {
        const source = mockSource("Files", { greeting: { en: "Hello" } });
        const plugin = createI18nPlugin({ sources: [source] });
        const app = mockApp();
        const logger = mockLogger();

        const instance = await startPlugin(plugin, app, logger);

        expect(source.load).toHaveBeenCalledTimes(1);
        expect(app.registerService).toHaveBeenCalledTimes(3);
        expect(app._registeredServices["i18n"].type).toBe("singleton");
        expect(app._registeredServices["i18n:reload"].type).toBe("singleton");
        expect(app._registeredServices["locale"].type).toBe("per-request");
        expect(await instance.health?.()).toBe(true);
    });
});
```

### Reading Registered Services Back Out

The `i18n:reload` service is a `() => Promise<void>` function and `i18n` is the `Translator` built from the merged catalog. Use `resolveService<T>()` to retrieve them with precise types.

```typescript
import { describe, expect, it } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import { mockApp, mockLogger, mockSource, resolveService, startPlugin } from "./helpers.js";

describe("service wiring", () => {
    it("exposes a working Translator under the default service name", async () => {
        const plugin = createI18nPlugin({
            sources: [mockSource("Files", { greeting: { en: "Hello", nl: "Hallo" } })],
        });
        const app = mockApp();
        await startPlugin(plugin, app, mockLogger());

        const translator = resolveService<Translator>(app, "i18n");

        expect(translator.translate("greeting", "en")).toBe("Hello");
        expect(translator.translate("greeting", "nl")).toBe("Hallo");
    });
});
```

### Testing Sources in Isolation

Sources stand alone — test `PostgreSQLSource` without the plugin by mocking only its `queryFn` seam.

```typescript
import { describe, expect, it, vi } from "vitest";
import { PostgreSQLSource } from "blendsdk/webafx-i18n";

type TranslationRow = { key: string; locale: string; value: string };

describe("PostgreSQLSource", () => {
    it("normalizes rows into a catalog without the plugin", async () => {
        const source = new PostgreSQLSource({
            queryFn: vi.fn<(sql: string) => Promise<TranslationRow[]>>().mockResolvedValue([
                { key: "greeting", locale: "en", value: "Hello" },
                { key: "greeting", locale: "nl", value: "Hallo" },
            ]),
        });

        const catalog = await source.load();

        expect(catalog).toEqual({ greeting: { en: "Hello", nl: "Hallo" } });
    });
});
```

### Synchronous and Asynchronous Patterns

Pure functions and plugin metadata assert synchronously. Anything that loads sources, runs the factory, or reloads asserts with `await` (and `resolves` / `rejects` for promise outcomes).

```typescript
import { describe, expect, it } from "vitest";
import { createI18nPlugin, parseAcceptLanguage } from "blendsdk/webafx-i18n";
import { mockApp, mockLogger, startPlugin } from "./helpers.js";

describe("sync and async patterns", () => {
    it("asserts synchronous results directly", () => {
        expect(parseAcceptLanguage("nl, en;q=0.8")).toBe("nl");
    });

    it("awaits asynchronous factory work", async () => {
        const plugin = createI18nPlugin({ sources: [] });
        const instance = await startPlugin(plugin, mockApp(), mockLogger());

        expect(instance).toBeDefined();
    });

    it("asserts promise outcomes with resolves and rejects", async () => {
        const plugin = createI18nPlugin({ sources: [] });

        await expect(startPlugin(plugin, mockApp(), mockLogger())).resolves.toBeDefined();
    });
});
```

---

## Integration Testing

The package's own suite is entirely in-process — there is no Docker dependency, no external database, and no file fixtures. "Integration" for this package therefore means running the *real* components together: the plugin factory, the real `Translator`, the real `mergeCatalogs`, and the real `resolveLocale`, while only I/O boundaries stay mocked. This catches wiring errors (wrong service names, wrong merge order, lost cookie options) that isolated unit tests cannot.

### Full Wiring End to End

This test drives a request through the complete chain: source loading → catalog merge → locale resolution → cookie persistence → translation lookup.

```typescript
import { describe, expect, it } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import {
    invokePerRequestService,
    mockApp,
    mockLogger,
    mockRequest,
    mockResponse,
    mockSource,
    resolveService,
    startPlugin,
} from "./helpers.js";

describe("i18n integration", () => {
    it("resolves a request locale and serves merged translations", async () => {
        const plugin = createI18nPlugin({
            defaultLocale: "en",
            sources: [
                mockSource("Files", { greeting: { en: "Hello", nl: "Hallo" } }),
                mockSource("PostgreSQLSource", { greeting: { en: "Hi there" } }),
            ],
        });

        const app = mockApp();
        await startPlugin(plugin, app, mockLogger());

        const translator = resolveService<Translator>(app, "i18n");

        // Simulate a Dutch request hitting the per-request locale service
        const req = mockRequest({ query: { locale: "nl" } });
        const res = mockResponse();
        const locale = invokePerRequestService<string>(app, "locale", req, res);

        expect(locale).toBe("nl");
        expect(res.cookie).toHaveBeenCalledWith(
            "locale",
            "nl",
            expect.objectContaining({ sameSite: "lax" })
        );
        expect(translator.translate("greeting", locale)).toBe("Hallo");
        expect(translator.translate("greeting", "en")).toBe("Hi there");
    });
});
```

### Optional: Live PostgreSQL Tests

`PostgreSQLSource` is deliberately decoupled from any database driver — it only needs a `queryFn` that returns `{ key, locale, value }` rows. That makes live-database tests opt-in: gate them behind an environment variable and provision PostgreSQL with Docker (the official `postgres` image works well) when you want them to run. The package's own suite never requires this.

```typescript
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { postgresqlSource } from "blendsdk/webafx-i18n";

type TranslationRow = { key: string; locale: string; value: string };

const connectionString = process.env.I18N_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("PostgreSQLSource against a live database", () => {
    it("loads the catalog through a real query function", async () => {
        const pool = new Pool({ connectionString });

        try {
            const source = postgresqlSource({
                queryFn: async (sql) => {
                    const result = await pool.query<TranslationRow>(sql);
                    return result.rows;
                },
                filter: "active = true",
            });

            const catalog = await source.load();

            expect(Object.keys(catalog).length).toBeGreaterThan(0);
        } finally {
            await pool.end();
        }
    });
});
```

Run it with a reachable database:

```bash
I18N_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/translations npm test
```

If you use `blendsdk/postgresql` instead of a raw driver, adapt the callback the same way — `queryFn` only needs a function that executes the SQL and returns rows. Keep `tableName` and `filter` static and trusted; both are interpolated into the generated SQL verbatim.

File-based sources (`jsonFileSource`, `contentFileSource`) follow the same philosophy: their disk I/O and fixture formats are covered by `blendsdk/i18n`'s own suite, so most consumer tests replace them with `mockSource()` and reserve the real thing for explicit filesystem integration tests with temporary directories.

---

## Mocking & Stubbing

Mock only the I/O boundaries; keep the translation core real. This table is the decision guide:

| Component | Treatment | Why |
| --- | --- | --- |
| `TranslationSource` backends (PostgreSQL, files, HTTP) | `mockSource()`, or `PostgreSQLSource` with a mocked `queryFn` | Keeps disk, network, and database out of unit tests; gives exact catalogs and call counts |
| `queryFn` callback | `vi.fn<...>()` returning fixture rows | Purpose-built seam: assert the generated SQL and simulate failures |
| WebAFX `Logger` | `mockLogger()` — async `vi.fn()` methods | Assert startup/reload messages without console output |
| WebAFX application / service container | `mockApp()` — records registrations; `services.get` rejects by default | Assert plugin wiring without booting the framework |
| Pub/sub provider | `mockPubSub()` passed via `mockApp({ pubsub })` | Capture the reload handler and invoke it on demand |
| Express `Request` | `mockRequest()` — only `query`, `headers`, `cookies` | Exactly the fields the locale resolver reads |
| Express `Response` | `mockResponse()` — only `cookie()` | Assert the persisted locale name, value, and options |
| `Translator`, `mergeCatalogs`, `resolveLocale`, `parseAcceptLanguage` | Real instances — do not mock | Deterministic and in-memory; mocking them would hide merge-order and lookup bugs |

### Boundary Casts, Explained

Two helpers contain `as unknown as` assertions:

- `startPlugin()` asserts the mock app, Express namespace, and logger at the WebAFX factory boundary. The real `WebApplication` carries dozens of members (HTTP server, routing, container internals) that i18n behavior never touches.
- `mockRequest()` builds a partial Express `Request`. The resolver reads only `query`, `headers`, and `cookies`; constructing a full `Request` would couple your tests to the HTTP stack instead of to locale logic.

Keeping the assertions inside helpers means test bodies never see a cast. These mirror the package's own test doubles, which use the same technique.

### Mocking a Source That Changes Between Calls

For reload tests, back a source's `load()` with a mutable variable so you can "change the backend" between calls:

```typescript
import { vi } from "vitest";
import type { TranslationCatalog, TranslationSource } from "blendsdk/webafx-i18n";

let currentCatalog: TranslationCatalog = { greeting: { en: "Hello" } };

const mutableSource: TranslationSource = {
    name: "MutableSource",
    load: vi.fn<() => Promise<TranslationCatalog>>(async () => currentCatalog),
};

// Simulate a backend change, then trigger a reload:
currentCatalog = { greeting: { en: "Howdy" } };
```

### Mocking the Pub/Sub Provider

```typescript
import { mockApp, mockPubSub } from "./helpers.js";

const pubsub = mockPubSub();
const app = mockApp({ pubsub });
```

The plugin subscribes to `reloadChannel` through the provider and reloads whenever a message arrives. Retrieve the captured handler with `pubsub.subscribe.mock.calls[0][1]` and invoke it to drive a reload deterministically.

### Mocking `queryFn` Failures

```typescript
import { describe, expect, it, vi } from "vitest";
import { PostgreSQLSource } from "blendsdk/webafx-i18n";

type TranslationRow = { key: string; locale: string; value: string };

describe("queryFn failures", () => {
    it("surfaces query errors from load()", async () => {
        const source = new PostgreSQLSource({
            queryFn: vi
                .fn<(sql: string) => Promise<TranslationRow[]>>()
                .mockRejectedValue(new Error("Connection refused")),
        });

        await expect(source.load()).rejects.toThrow("Connection refused");
    });
});
```

Note the two different error semantics worth covering: at **startup** a failing source rejects plugin initialization; at **reload** the plugin catches the error, logs it, and keeps the previous catalog. Both are tested in the feature patterns below.

---

## Test Patterns by Feature

### Plugin Definition & Registration

```typescript
import { describe, expect, it } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import { mockApp, mockLogger, startPlugin } from "./helpers.js";

describe("plugin definition and registration", () => {
    it("uses the documented defaults", () => {
        const plugin = createI18nPlugin({ sources: [] });

        expect(plugin.name).toBe("i18n");
        expect(plugin.priority).toBe(40);
        expect(typeof plugin.factory).toBe("function");
    });

    it("honors custom service names and plugin priority", () => {
        const plugin = createI18nPlugin({
            sources: [],
            serviceName: "translations",
            localeServiceName: "request-locale",
            priority: 10,
        });

        expect(plugin.name).toBe("translations");
        expect(plugin.priority).toBe(10);
    });

    it("registers the translator, reload function, and locale services", async () => {
        const app = mockApp();
        await startPlugin(createI18nPlugin({ sources: [] }), app, mockLogger());

        expect(app.registerService).toHaveBeenCalledTimes(3);
        expect(app._registeredServices["i18n"].type).toBe("singleton");
        expect(app._registeredServices["i18n:reload"].type).toBe("singleton");
        expect(app._registeredServices["locale"].type).toBe("per-request");
    });

    it("renames the locale service when configured", async () => {
        const app = mockApp();
        await startPlugin(
            createI18nPlugin({ sources: [], localeServiceName: "request-locale" }),
            app,
            mockLogger()
        );

        expect(app._registeredServices["request-locale"]).toBeDefined();
        expect(app._registeredServices["locale"]).toBeUndefined();
    });

    it("exposes a health hook that resolves to true", async () => {
        const instance = await startPlugin(createI18nPlugin({ sources: [] }), mockApp(), mockLogger());

        expect(await instance.health?.()).toBe(true);
    });
});
```

### Source Loading & Merge Order

Later sources override earlier ones per key + locale; locales and keys a later source does not redefine survive. A failing source rejects startup.

```typescript
import { describe, expect, it, vi } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type {
    TranslationCatalog,
    TranslationSource,
    Translator,
} from "blendsdk/webafx-i18n";
import { mockApp, mockLogger, mockSource, resolveService, startPlugin } from "./helpers.js";

describe("source loading and merge order", () => {
    it("loads every source and lets later sources override earlier ones", async () => {
        const files = mockSource("Files", {
            greeting: { en: "Hello", nl: "Hallo" },
            farewell: { en: "Goodbye" },
        });
        const database = mockSource("PostgreSQLSource", {
            greeting: { en: "Hi there" },
        });

        const plugin = createI18nPlugin({ sources: [files, database] });
        const app = mockApp();
        await startPlugin(plugin, app, mockLogger());

        expect(files.load).toHaveBeenCalledTimes(1);
        expect(database.load).toHaveBeenCalledTimes(1);

        const translator = resolveService<Translator>(app, "i18n");

        expect(translator.translate("greeting", "en")).toBe("Hi there"); // later source wins
        expect(translator.translate("greeting", "nl")).toBe("Hallo"); // earlier locale preserved
        expect(translator.translate("farewell", "en")).toBe("Goodbye"); // union of keys
    });

    it("registers services even when no sources are configured", async () => {
        const app = mockApp();
        await startPlugin(createI18nPlugin({ sources: [] }), app, mockLogger());

        expect(app.registerService).toHaveBeenCalledTimes(3);
    });

    it("rejects initialization when a source fails at startup", async () => {
        const broken: TranslationSource = {
            name: "BrokenSource",
            load: vi
                .fn<() => Promise<TranslationCatalog>>()
                .mockRejectedValue(new Error("disk unavailable")),
        };

        const plugin = createI18nPlugin({ sources: [broken] });

        await expect(startPlugin(plugin, mockApp(), mockLogger())).rejects.toThrow(
            "disk unavailable"
        );
    });

    it("accepts any object implementing the TranslationSource contract", async () => {
        class StaticSource implements TranslationSource {
            readonly name = "StaticSource";

            constructor(private readonly catalog: TranslationCatalog) {}

            async load(): Promise<TranslationCatalog> {
                return this.catalog;
            }
        }

        const plugin = createI18nPlugin({
            sources: [new StaticSource({ greeting: { en: "Hello from a custom source" } })],
        });
        const app = mockApp();
        await startPlugin(plugin, app, mockLogger());

        const translator = resolveService<Translator>(app, "i18n");

        expect(translator.translate("greeting", "en")).toBe("Hello from a custom source");
    });
});
```

### PostgreSQLSource

```typescript
import { describe, expect, it, vi } from "vitest";
import { PostgreSQLSource, postgresqlSource } from "blendsdk/webafx-i18n";

type TranslationRow = { key: string; locale: string; value: string };

function mockQueryFn(rows: TranslationRow[]) {
    return vi.fn<(sql: string) => Promise<TranslationRow[]>>().mockResolvedValue(rows);
}

describe("PostgreSQLSource", () => {
    it("normalizes rows into a key → locale → value catalog", async () => {
        const source = new PostgreSQLSource({
            queryFn: mockQueryFn([
                { key: "greeting", locale: "en", value: "Hello" },
                { key: "greeting", locale: "nl", value: "Hallo" },
                { key: "farewell", locale: "en", value: "Goodbye" },
            ]),
        });

        const catalog = await source.load();

        expect(catalog).toEqual({
            greeting: { en: "Hello", nl: "Hallo" },
            farewell: { en: "Goodbye" },
        });
    });

    it("parses plural values stored as JSON arrays", async () => {
        const source = new PostgreSQLSource({
            queryFn: mockQueryFn([
                { key: "book", locale: "en", value: '["${count} book","${count} books"]' },
            ]),
        });

        const catalog = await source.load();

        expect(catalog.book).toEqual({
            en: ["${count} book", "${count} books"],
        });
    });

    it("keeps invalid JSON values as plain strings", async () => {
        const source = new PostgreSQLSource({
            queryFn: mockQueryFn([{ key: "note", locale: "en", value: "[not valid json" }]),
        });

        const catalog = await source.load();

        expect(catalog.note.en).toBe("[not valid json");
    });

    it("keeps JSON arrays that are not two-element tuples as plain strings", async () => {
        const source = new PostgreSQLSource({
            queryFn: mockQueryFn([{ key: "note", locale: "en", value: '["only one"]' }]),
        });

        const catalog = await source.load();

        expect(catalog.note.en).toBe('["only one"]');
    });

    it("builds the default SELECT statement", async () => {
        const queryFn = mockQueryFn([]);
        const source = new PostgreSQLSource({ queryFn });

        await source.load();

        expect(queryFn).toHaveBeenCalledWith(
            "SELECT key, locale, value FROM translations ORDER BY key, locale"
        );
    });

    it("applies the custom table name and filter", async () => {
        const queryFn = mockQueryFn([]);
        const source = new PostgreSQLSource({
            queryFn,
            tableName: "i18n_strings",
            filter: "active = true AND app = 'myapp'",
        });

        await source.load();

        expect(queryFn).toHaveBeenCalledWith(
            "SELECT key, locale, value FROM i18n_strings " +
                "WHERE active = true AND app = 'myapp' ORDER BY key, locale"
        );
    });

    it("returns an empty catalog when the table is empty", async () => {
        const source = new PostgreSQLSource({ queryFn: mockQueryFn([]) });

        const catalog = await source.load();

        expect(catalog).toEqual({});
    });

    it("propagates query failures", async () => {
        const source = new PostgreSQLSource({
            queryFn: vi
                .fn<(sql: string) => Promise<TranslationRow[]>>()
                .mockRejectedValue(new Error("Connection refused")),
        });

        await expect(source.load()).rejects.toThrow("Connection refused");
    });

    it("exposes its name and the postgresqlSource() factory", () => {
        const source = postgresqlSource({ queryFn: async () => [] });

        expect(source).toBeInstanceOf(PostgreSQLSource);
        expect(source.name).toBe("PostgreSQLSource");
    });
});
```

### Locale Resolution

`resolveLocale()` and `parseAcceptLanguage()` are pure functions — test them synchronously. The priority chain is: query parameter → `Accept-Language` → cookie → default.

```typescript
import { describe, expect, it } from "vitest";
import { parseAcceptLanguage, resolveLocale } from "blendsdk/webafx-i18n";
import { mockRequest } from "./helpers.js";

describe("resolveLocale", () => {
    describe("query parameter", () => {
        it("resolves from ?locale=", () => {
            const req = mockRequest({ query: { locale: "nl" } });
            expect(resolveLocale(req, "en", "locale")).toBe("nl");
        });

        it("trims whitespace and skips blank values", () => {
            const trimmed = mockRequest({ query: { locale: "  nl  " } });
            expect(resolveLocale(trimmed, "en", "locale")).toBe("nl");

            const blank = mockRequest({ query: { locale: "   " } });
            expect(resolveLocale(blank, "en", "locale")).toBe("en");
        });
    });

    describe("Accept-Language header", () => {
        it("resolves from a simple header", () => {
            const req = mockRequest({ headers: { "accept-language": "nl" } });
            expect(resolveLocale(req, "en", "locale")).toBe("nl");
        });

        it("picks the entry with the highest quality", () => {
            const req = mockRequest({ headers: { "accept-language": "en;q=0.8, nl;q=0.9" } });
            expect(resolveLocale(req, "en", "locale")).toBe("nl");
        });

        it("normalizes region separators", () => {
            const req = mockRequest({ headers: { "accept-language": "en-US" } });
            expect(resolveLocale(req, "en", "locale")).toBe("en_US");
        });
    });

    describe("cookie", () => {
        it("resolves from the configured cookie name", () => {
            const req = mockRequest({ cookies: { locale: "de" } });
            expect(resolveLocale(req, "en", "locale")).toBe("de");
        });

        it("skips the cookie when cookieName is false", () => {
            const req = mockRequest({ cookies: { locale: "de" } });
            expect(resolveLocale(req, "en", false)).toBe("en");
        });
    });

    describe("priority chain", () => {
        it("prefers query over header over cookie over default", () => {
            const all = mockRequest({
                query: { locale: "nl" },
                headers: { "accept-language": "de" },
                cookies: { locale: "fr" },
            });
            expect(resolveLocale(all, "en", "locale")).toBe("nl");

            const headerAndCookie = mockRequest({
                headers: { "accept-language": "de" },
                cookies: { locale: "fr" },
            });
            expect(resolveLocale(headerAndCookie, "en", "locale")).toBe("de");

            const cookieOnly = mockRequest({ cookies: { locale: "fr" } });
            expect(resolveLocale(cookieOnly, "en", "locale")).toBe("fr");
        });

        it("falls back to the default when nothing is set", () => {
            expect(resolveLocale(mockRequest(), "en", "locale")).toBe("en");
        });
    });
});

describe("parseAcceptLanguage", () => {
    it("parses simple and quality-annotated entries", () => {
        expect(parseAcceptLanguage("nl")).toBe("nl");
        expect(parseAcceptLanguage("nl, en;q=0.8")).toBe("nl");
    });

    it("respects quality ordering", () => {
        expect(parseAcceptLanguage("en;q=0.8, nl;q=0.9, de;q=0.7")).toBe("nl");
    });

    it("normalizes en-US to en_US", () => {
        expect(parseAcceptLanguage("en-US,en;q=0.9")).toBe("en_US");
    });

    it("returns null for wildcard-only and empty headers", () => {
        expect(parseAcceptLanguage("*")).toBeNull();
        expect(parseAcceptLanguage("")).toBeNull();
    });

    it("skips entries with q=0", () => {
        expect(parseAcceptLanguage("nl;q=0, en")).toBe("en");
    });
});
```

### The Per-Request Locale Service

The `locale` service is registered with `type: "per-request"`. Its factory resolves the request locale and — unless `localeCookieName` is `false` — persists it to a cookie with `httpOnly: false`, `sameSite: "lax"`, and a one-year `maxAge`. Invoke the factory directly via `invokePerRequestService()` to test the full behavior.

```typescript
import { describe, expect, it } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import {
    invokePerRequestService,
    mockApp,
    mockLogger,
    mockRequest,
    mockResponse,
    startPlugin,
} from "./helpers.js";

describe("locale service", () => {
    it("registers as a per-request service", async () => {
        const app = mockApp();
        await startPlugin(createI18nPlugin({ sources: [] }), app, mockLogger());

        expect(app._registeredServices["locale"].type).toBe("per-request");
    });

    it("resolves the request locale and persists it in the default cookie", async () => {
        const app = mockApp();
        await startPlugin(createI18nPlugin({ sources: [] }), app, mockLogger());

        const req = mockRequest({ query: { locale: "nl" } });
        const res = mockResponse();
        const locale = invokePerRequestService<string>(app, "locale", req, res);

        expect(locale).toBe("nl");
        expect(res.cookie).toHaveBeenCalledWith("locale", "nl", {
            httpOnly: false,
            sameSite: "lax",
            maxAge: 365 * 24 * 60 * 60 * 1000,
        });
    });

    it("skips cookie persistence when localeCookieName is false", async () => {
        const app = mockApp();
        await startPlugin(
            createI18nPlugin({ sources: [], localeCookieName: false }),
            app,
            mockLogger()
        );

        const req = mockRequest({ query: { locale: "nl" } });
        const res = mockResponse();
        const locale = invokePerRequestService<string>(app, "locale", req, res);

        expect(locale).toBe("nl");
        expect(res.cookie).not.toHaveBeenCalled();
    });

    it("reads and writes a custom cookie name", async () => {
        const app = mockApp();
        await startPlugin(
            createI18nPlugin({ sources: [], localeCookieName: "lang" }),
            app,
            mockLogger()
        );

        const req = mockRequest({ cookies: { lang: "de" } });
        const res = mockResponse();
        const locale = invokePerRequestService<string>(app, "locale", req, res);

        expect(locale).toBe("de");
        expect(res.cookie).toHaveBeenCalledWith(
            "lang",
            "de",
            expect.objectContaining({ sameSite: "lax" })
        );
    });
});
```

### Missing Translations

The `onMissingTranslation` hook is forwarded to the `Translator` and receives the key and locale of every failed lookup — ideal for logging gaps or feeding metrics.

```typescript
import { describe, expect, it, vi } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import { mockApp, mockLogger, resolveService, startPlugin } from "./helpers.js";

describe("missing translations", () => {
    it("invokes onMissingTranslation with the key and locale", async () => {
        const onMissingTranslation = vi.fn<(key: string, locale: string) => void>();
        const plugin = createI18nPlugin({ sources: [], onMissingTranslation });
        const app = mockApp();
        await startPlugin(plugin, app, mockLogger());

        const translator = resolveService<Translator>(app, "i18n");
        translator.translate("checkout.submit", "en");

        expect(onMissingTranslation).toHaveBeenCalledWith("checkout.submit", "en");
    });
});
```

### Manual Reload

The singleton `i18n:reload` service resolves to a `() => Promise<void>` function that reloads every source and atomically swaps the catalog. A failed reload logs the error, resolves normally, and keeps the previous catalog.

```typescript
import { describe, expect, it, vi } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type {
    TranslationCatalog,
    TranslationSource,
    Translator,
} from "blendsdk/webafx-i18n";
import { mockApp, mockLogger, resolveService, startPlugin } from "./helpers.js";

describe("manual reload via the i18n:reload service", () => {
    it("reloads all sources and swaps the catalog", async () => {
        let currentCatalog: TranslationCatalog = { greeting: { en: "Hello" } };
        const source: TranslationSource = {
            name: "MutableSource",
            load: vi.fn<() => Promise<TranslationCatalog>>(async () => currentCatalog),
        };

        const plugin = createI18nPlugin({ sources: [source] });
        const app = mockApp();
        await startPlugin(plugin, app, mockLogger());

        const translator = resolveService<Translator>(app, "i18n");
        const reload = resolveService<() => Promise<void>>(app, "i18n:reload");

        expect(translator.translate("greeting", "en")).toBe("Hello");

        currentCatalog = { greeting: { en: "Howdy" } };
        await reload();

        expect(source.load).toHaveBeenCalledTimes(2);
        expect(translator.translate("greeting", "en")).toBe("Howdy");
    });

    it("names the reload service after a custom serviceName", async () => {
        const app = mockApp();
        await startPlugin(
            createI18nPlugin({ sources: [], serviceName: "translations" }),
            app,
            mockLogger()
        );

        expect(app._registeredServices["translations:reload"]).toBeDefined();
        expect(app._registeredServices["i18n:reload"]).toBeUndefined();
    });

    it("keeps the previous catalog when a reload fails", async () => {
        let shouldFail = false;
        const source: TranslationSource = {
            name: "FlakySource",
            load: vi.fn<() => Promise<TranslationCatalog>>(async () => {
                if (shouldFail) {
                    throw new Error("database offline");
                }
                return { greeting: { en: "Hello" } };
            }),
        };

        const plugin = createI18nPlugin({ sources: [source] });
        const app = mockApp();
        const logger = mockLogger();
        await startPlugin(plugin, app, logger);

        const translator = resolveService<Translator>(app, "i18n");
        const reload = resolveService<() => Promise<void>>(app, "i18n:reload");

        shouldFail = true;
        await expect(reload()).resolves.toBeUndefined();

        expect(translator.translate("greeting", "en")).toBe("Hello");
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("keeping previous catalog")
        );
    });
});
```

### Pub/Sub Reload

When `reloadChannel` is configured, the plugin looks up the pub/sub provider under `pubsubServiceName` (default `"pubsub"`) and subscribes. If the provider is missing, the plugin logs that the channel is inactive and startup continues normally. Use `mockPubSub()` to capture the subscription and drive reloads deterministically.

```typescript
import { describe, expect, it, vi } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type {
    TranslationCatalog,
    TranslationSource,
    Translator,
} from "blendsdk/webafx-i18n";
import {
    mockApp,
    mockLogger,
    mockPubSub,
    mockSource,
    resolveService,
    startPlugin,
} from "./helpers.js";

describe("pub/sub reload channel", () => {
    it("keeps working when no pub/sub provider is registered", async () => {
        const logger = mockLogger();
        const plugin = createI18nPlugin({
            sources: [mockSource("Files", { greeting: { en: "Hello" } })],
            reloadChannel: "i18n:reload",
        });

        await expect(startPlugin(plugin, mockApp(), logger)).resolves.toBeDefined();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("not available"));
    });

    it("subscribes to the reload channel and refreshes on incoming messages", async () => {
        let currentCatalog: TranslationCatalog = { greeting: { en: "Hello" } };
        const source: TranslationSource = {
            name: "MutableSource",
            load: vi.fn<() => Promise<TranslationCatalog>>(async () => currentCatalog),
        };
        const pubsub = mockPubSub();
        const app = mockApp({ pubsub });
        const plugin = createI18nPlugin({
            sources: [source],
            reloadChannel: "i18n:reload",
        });

        await startPlugin(plugin, app, mockLogger());

        expect(pubsub.subscribe).toHaveBeenCalledWith("i18n:reload", expect.any(Function));

        const translator = resolveService<Translator>(app, "i18n");
        expect(translator.translate("greeting", "en")).toBe("Hello");

        // Simulate an incoming reload message on the channel
        currentCatalog = { greeting: { en: "Howdy" } };
        const handler = pubsub.subscribe.mock.calls[0][1];
        await handler();

        expect(source.load).toHaveBeenCalledTimes(2);
        expect(translator.translate("greeting", "en")).toBe("Howdy");
    });

    it("looks the provider up under a custom pubsubServiceName", async () => {
        const app = mockApp({ pubsub: mockPubSub() });

        await startPlugin(
            createI18nPlugin({
                sources: [],
                reloadChannel: "i18n:reload",
                pubsubServiceName: "my-pubsub",
            }),
            app,
            mockLogger()
        );

        expect(app.services.get).toHaveBeenCalledWith("my-pubsub");
    });
});
```

---

All patterns in this document map directly onto the package's own three test files plus the wiring checks worth adding in consumer code. When in doubt, follow the rule of thumb from [Mocking & Stubbing](#mocking--stubbing): mock the I/O boundaries the package exposes, and assert against the real translation behavior behind them.

---

# webafx-i18n Troubleshooting

This document covers the failure modes you are most likely to hit with `blendsdk/webafx-i18n`, each written as **Error / Symptom → Cause → Fix**. Failures in this package surface in three distinct places, and knowing which one you are looking at is half the diagnosis:

- **Startup** — anything that rejects while a source loads fails plugin installation. This is deliberate fail-fast behavior.
- **Request time** — locale resolution and translation lookups rarely throw; they quietly return the wrong value, which then shows up as missing translations.
- **Reload time** — errors are swallowed and logged; the previous catalog is kept. The logs are the only signal.

Each fix includes a complete, strict-mode TypeScript example. For the underlying architecture, see Core Concepts; for a high-level map of the package, see Overview.

---

## Common Errors

### Startup and Source Loading Failures

#### Plugin installation fails while loading a source

**Error / Symptom** — Application startup aborts during plugin installation with the error thrown by one of your sources. Typical messages: `Error: connect ECONNREFUSED 127.0.0.1:5432`, `error: relation "translations" does not exist`, `ENOENT: no such file or directory`. The last `I18n:` line before the failure names the failing source:

```text
I18n: loading from PostgreSQLSource...
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Cause** — `loadAllSources()` awaits `source.load()` for every configured source without catching anything. At startup there is no fallback, so a rejection propagates out of the plugin factory and the plugin installation fails. This is by design: a misconfigured translation backend is surfaced immediately instead of silently serving untranslated output. It is the exact opposite of reload, where errors are caught and the old catalog is kept.

**Fix**

1. Read the last `I18n: loading from <name>...` log line to identify the failing source.
2. Probe that source in isolation (see [Probe each source in isolation](#2-probe-each-source-in-isolation)) to get the raw error.
3. Fix the underlying problem — database reachability, table/view, file paths.
4. Only if the source is genuinely optional at boot, wrap it so its failure degrades to an empty catalog instead of failing startup:

```typescript
import { createI18nPlugin, postgresqlSource } from "blendsdk/webafx-i18n";
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

interface MinimalLogger {
    error(message: string): void;
}

/** Wraps a source so a startup failure degrades to an empty catalog instead of failing boot. */
export function optionalSource(inner: TranslationSource, logger: MinimalLogger): TranslationSource {
    return {
        name: `${inner.name} (optional)`,
        async load(): Promise<TranslationCatalog> {
            try {
                return await inner.load();
            } catch (error) {
                logger.error(
                    `I18n: optional source ${inner.name} failed, continuing with empty catalog: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
                return {};
            }
        },
    };
}

export function createTranslationsPlugin(database: DatabaseClient): PluginDefinition {
    const databaseSource = postgresqlSource({ queryFn: (sql) => database.query(sql) });
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [optionalSource(databaseSource, console)],
    });
}
```

Be aware of the trade-off: wrapping changes reload semantics. If the database is down during a reload, the wrapper returns `{}`, the catalog rebuilds without the database keys, and `setCatalog()` swaps it in — whereas an unwrapped failing source would have caused the plugin to keep the entire previous catalog.

#### `TypeError: Cannot read properties of null (reading 'startsWith')`

**Error / Symptom** — `PostgreSQLSource.load()` throws while parsing rows. At startup this reads `TypeError: Cannot read properties of null (reading 'startsWith')`; during a reload you see it inside the log line `I18n: reload failed, keeping previous catalog: Cannot read properties of null (reading 'startsWith')`. The equivalent `... of undefined ...` variant appears when a `queryFn` returns rows without a `value` property.

**Cause** — The `value` column contained SQL `NULL` for at least one row. The `PostgreSQLSourceConfig.queryFn` type declares `value: string`, but that is a compile-time promise only — PostgreSQL returns `null` for nullable columns at runtime, and `parseValue()` calls `value.startsWith("[")` on it. The `undefined` variant happens when a custom `queryFn` maps rows and loses the `value` property.

**Fix** — Make the database the source of truth: add a `NOT NULL` constraint and clean existing rows. As defense in depth, coerce inside `queryFn`:

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string | null }>>;
}

export function createNullSafeSource(database: DatabaseClient) {
    return postgresqlSource({
        queryFn: async (sql) => {
            const rows = await database.query(sql);
            return rows.map((row) => ({ ...row, value: row.value ?? "" }));
        },
    });
}
```

Alternatively, exclude the rows in SQL with `filter: "value IS NOT NULL"` — but note this silently drops those keys instead of serving an empty string, so fix the data first.

#### `error: relation "translations" does not exist` / `error: column "key" does not exist`

**Error / Symptom** — At startup, directly after `I18n: loading from PostgreSQLSource...`, the query rejects the plugin factory with `error: relation "translations" does not exist` or `error: column "key" does not exist`.

**Cause** — `PostgreSQLSource` hard-codes the SELECT list `key, locale, value` and defaults `tableName` to `"translations"`. If your schema uses different table or column names, or the failing connection points at a database/schema where the table is not visible (`search_path`), the query cannot compile. The column list itself is not configurable.

**Fix** — Create a compatibility view with the expected column names and point the source at it:

```sql
CREATE VIEW translations AS
SELECT
    translation_key AS key,
    lang            AS locale,
    text            AS value,
    active          AS active
FROM app_translations;
```

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";
import type { PostgreSQLSource } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createTranslationsSource(database: DatabaseClient): PostgreSQLSource {
    return postgresqlSource({
        queryFn: (sql) => database.query(sql),
        tableName: "translations", // the compatibility view, not the raw table
        filter: "active = true",   // columns used in the filter must be exposed by the view
    });
}
```

If the table exists but is "missing", check the connection's default schema and `search_path` — the relation error is also what a wrong schema or database produces.

#### `I18n plugin: loaded 0 translation keys` — every lookup falls through

**Error / Symptom** — Startup completes without any error, but the log shows `I18n plugin: loaded 0 translation keys from 1 source(s)` (or `from 0 source(s)`). Every `translate()` call produces missing translations; `onMissingTranslation` fires constantly if configured; the UI shows raw keys.

**Cause** — Nothing threw, there was simply no data: an empty `sources` array; a `filter` that excludes every row (an empty result set becomes `{}` without error); an empty view/table; or translations that exist only for locales your requests never resolve (see [Wrong language served](#wrong-language-served--translations-never-match-for-some-requests)).

**Fix** — First, verify per-source counts from the startup log (`I18n: <name> loaded <N> keys`) and probe sources individually. Then add a guard wrapper so an unexpectedly empty catalog fails loudly at startup instead of silently serving nothing:

```typescript
import { createI18nPlugin, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

/** Fails startup loudly when a source unexpectedly yields nothing. */
export function requiredSource(inner: TranslationSource, minKeys: number): TranslationSource {
    return {
        name: inner.name,
        async load(): Promise<TranslationCatalog> {
            const catalog = await inner.load();
            const keyCount = Object.keys(catalog).length;
            if (keyCount < minKeys) {
                throw new Error(`${inner.name} returned ${keyCount} keys, expected at least ${minKeys}`);
            }
            return catalog;
        },
    };
}

export function createTranslationsPlugin(database: DatabaseClient): PluginDefinition {
    const databaseSource = postgresqlSource({ queryFn: (sql) => database.query(sql) });
    return createI18nPlugin({
        sources: [requiredSource(databaseSource, 1)],
    });
}
```

At reload time the thrown error simply triggers the standard `I18n: reload failed, keeping previous catalog` path.

### Service Resolution Failures

#### `Service not found` when resolving `i18n`, `locale`, or `i18n:reload`

**Error / Symptom** — A handler throws while resolving a translation-related service; the container reports that the requested service is not registered (for example `Service not found`). Nothing translation-related gets served.

**Cause** — Several possibilities, all of them name or scope related:

- The plugin was never installed (`app.use(createI18nPlugin(...))` is missing), or its factory failed earlier in the boot sequence (see [Plugin installation fails while loading a source](#plugin-installation-fails-while-loading-a-source)).
- `serviceName` / `localeServiceName` were customized and the code still resolves the default names. Note the reload service is derived: `${serviceName}:reload`.
- The `locale` service is resolved outside request handling. It is registered with `type: "per-request"` and only exists within a request scope.
- The name is mistyped — service names are exact, case-sensitive strings.

**Fix** — Use the customized names consistently, resolve per-request services from the request container, and remember the reload-service naming rule:

```typescript
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

// Renaming the service names renames everything the plugin registers:
// "translations" (Translator, singleton), "translations:reload" (reload fn, singleton),
// and "request-locale" (resolved locale, per-request).
export const i18nPlugin = createI18nPlugin({
    sources: [],
    serviceName: "translations",
    localeServiceName: "request-locale",
});

export async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("translations");
    const locale = await req.services.get<string>("request-locale");
    res.json({ message: translator.translate("greeting", locale) });
}

export async function reloadTranslations(req: Request, res: Response): Promise<void> {
    // The reload service is named `${serviceName}:reload` — "translations:reload" here.
    const reload = await req.services.get<() => Promise<void>>("translations:reload");
    await reload();
    res.json({ reloaded: true });
}
```

#### `TypeError: res.cookie is not a function`

**Error / Symptom** — The first request that resolves the `locale` service fails with `TypeError: res.cookie is not a function`. Only occurs when cookie persistence is enabled (the default).

**Cause** — The per-request `locale` factory calls `res.cookie(cookieName, locale, ...)` whenever `localeCookieName` is not `false`. If the response object passed into the service factory does not implement Express's `cookie()` method — lightweight test doubles, custom adapters — the call throws on every request where the service is resolved.

**Fix** — Disable cookie persistence for runtimes without `res.cookie`, or provide a response that implements `cookie()`. Disabling it removes both the cookie read (step 3 of the resolution chain) and the `Set-Cookie` write:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

export const i18nPlugin = createI18nPlugin({
    defaultLocale: "en",
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    // Disables both the cookie read and the Set-Cookie write.
    // Resolution chain becomes: query → Accept-Language → default.
    localeCookieName: false,
});
```

### Locale Resolution Failures

#### Wrong language served — translations never match for some requests

**Error / Symptom** — Requests clearly send a language the application supports, yet the lookup misses. Example: `Accept-Language: en-US` resolves to `en_US` and cannot match catalog keys written as `en-US`; conversely, `?locale=en-US` is returned as `en-US` and cannot match catalogs keyed `en_US`. If `onMissingTranslation` is configured, it logs locales that look "right" but differ by a separator.

**Cause** — Only the `Accept-Language` path normalizes, and it replaces only the first hyphen (`en-US` → `en_US`; `zh-Hant-TW` → `zh_Hant-TW`). Query parameter and cookie values are returned trimmed but otherwise verbatim. Translation lookups are exact string matches, so catalog keys and resolver output must agree character-for-character.

**Fix** — Pick one convention (underscores, matching resolver output), store catalogs under it, and normalize/validate every resolved value before use:

```typescript
import { resolveLocale } from "blendsdk/webafx-i18n";
import type { Request } from "express";

const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(["en", "nl", "de", "en_US"]);

/**
 * Normalize whatever the resolver returned into the convention used for catalog keys.
 * resolveLocale() only normalizes the Accept-Language path, so query parameters
 * and cookies can still arrive with hyphens.
 */
export function resolveSupportedLocale(req: Request): string {
    const resolved = resolveLocale(req, "en", "locale").replace(/-/g, "_");
    return SUPPORTED_LOCALES.has(resolved) ? resolved : "en";
}
```

#### Saved cookie preferences are ignored

**Error / Symptom** — A `locale=nl` cookie exists and is sent by the browser, but requests still resolve to the `Accept-Language` value or the default. No error is logged anywhere.

**Cause** — `resolveLocale()` reads `req.cookies?.[cookieName]` with optional chaining. WebAFX, like Express, only populates `req.cookies` when cookie-parsing middleware runs earlier in the pipeline. Without it, `req.cookies` is `undefined`, the optional chain short-circuits, and the cookie step is silently skipped — indistinguishable from "no cookie present".

**Fix** — Ensure cookie parsing is active before requests reach the `locale` service, and verify with a diagnostic that reads the raw header directly. If this helper returns a value while resolution ignores it, the middleware is missing:

```typescript
import type { Request } from "express";

/**
 * Diagnostic helper: read the locale cookie straight from the Cookie header.
 * If this returns a value while resolveLocale() does not, `req.cookies` is not
 * being populated — cookie-parsing middleware is missing from the pipeline.
 */
export function readLocaleCookie(req: Request, cookieName: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) {
        return undefined;
    }
    for (const part of header.split(";")) {
        const [name, ...rest] = part.trim().split("=");
        if (name === cookieName) {
            return decodeURIComponent(rest.join("="));
        }
    }
    return undefined;
}
```

Also remember the write side: the plugin only emits `Set-Cookie` when a request actually resolves the `locale` service (per-request services are lazy), so "the cookie was never set" can simply mean no route resolved the locale for those requests.

#### `TypeError: Cannot read properties of undefined (reading 'split')`

**Error / Symptom** — `parseAcceptLanguage()` throws `TypeError: Cannot read properties of undefined (reading 'split')` when called directly with an absent header — for example from your own negotiation code doing `parseAcceptLanguage(req.headers["accept-language"])`.

**Cause** — `parseAcceptLanguage(header: string)` assumes a string and calls `header.split(",")` immediately. `resolveLocale()` guards with a truthiness check before calling it, so this only happens in direct calls — where the header can be `undefined` when a client sends no `Accept-Language`.

**Fix** — Guard the type before calling. This pattern also resolves the matching strict-mode compiler errors (`TS2345` for the possibly-undefined header and `TS2322` for the `string | null` return value):

```typescript
import { parseAcceptLanguage } from "blendsdk/webafx-i18n";
import type { Request } from "express";

export function negotiateLocale(req: Request): string {
    const header = req.headers["accept-language"];
    if (typeof header !== "string") {
        return "en";
    }
    return parseAcceptLanguage(header) ?? "en";
}
```

### Reload Failures

#### Reload reports success but translations stay stale — `I18n: reload failed, keeping previous catalog: <cause>`

**Error / Symptom** — You trigger a reload (via the `i18n:reload` service or the pub/sub channel), the call resolves without error, but translations never change. The logs contain `I18n: reload failed, keeping previous catalog: <original error message>` — or, if you never checked the logs, nothing at all.

**Cause** — `reloadSources()` catches every error from loading or merging sources and logs `I18n: reload failed, keeping previous catalog: <message>` by design, so a broken backend can never take a running application down. Consequence: the reload function never rejects, and callers cannot detect failure except by inspecting the logs. The `<message>` names the root cause (connection refused, relation missing, and so on).

**Fix** — Treat the log line as the source of truth and fix the underlying error it names. When you need failures to be observable programmatically (admin endpoints, CI smoke checks), perform the reload steps yourself against the translator instead of relying on the silent path:

```typescript
import { jsonFileSource, mergeCatalogs } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function reloadWithErrorReporting(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    try {
        // Mirror every source from the plugin config — this bypasses the plugin's
        // internal reload so failures surface to the caller instead of only the logs.
        const files = await jsonFileSource({ paths: ["./translations/*.json"] }).load();
        translator.setCatalog(mergeCatalogs([files]));
        res.json({ reloaded: true });
    } catch (error) {
        res.status(500).json({
            reloaded: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
```

If you keep using the built-in reload, watch for the success line `I18n: reload complete — <N> keys loaded` to confirm the swap actually happened.

#### Pub/sub reload channel never triggers a reload

**Error / Symptom** — Publishing to the configured `reloadChannel` has no effect. Startup logs show either of these:

```text
I18n plugin: pub/sub service "pubsub" not available — reload channel "i18n:reload" will not be active
```

or — more confusingly — **no line about the channel at all**, neither "subscribed" nor "not available".

**Cause** —

- **"not available"**: the plugin resolves the pub/sub service from the container while its factory runs. Plugins install in priority order (lower numbers first) and i18n defaults to `priority: 40`. If the `blendsdk/webafx-cache` pub/sub plugin installs after i18n, the service is not registered yet and the plugin degrades gracefully.
- **No log at all**: the service under `pubsubServiceName` resolved, but it does not expose a `subscribe` function, so the `typeof subscribe === "function"` check fails and the block is skipped silently — there is no log for this path.
- A related trap: the entire subscribe block is inside a `try/catch`, so if `subscribe()` itself throws, the log still says "not available", which is technically misleading.

**Fix** — Make sure i18n installs after the pub/sub plugin, and verify the runtime evidence:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

export const i18nPlugin = createI18nPlugin({
    defaultLocale: "en",
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    reloadChannel: "i18n:reload",
    // Lower numbers install first. The plugin resolves the pub/sub service while
    // its factory runs, so it must install AFTER the pub/sub plugin: give i18n a
    // numerically higher priority than the pub/sub plugin's (default is 40).
    priority: 60,
});
```

1. Confirm the startup log contains `I18n plugin: subscribed to reload channel "i18n:reload"`.
2. Confirm the object registered under `pubsubServiceName` actually is the pub/sub provider by inspecting it in your bootstrap — if it is a wrapper without `subscribe`, the plugin stays silent.
3. Publish a test message and watch for `I18n reload triggered via pub/sub` followed by `I18n: reload complete — <N> keys loaded`.

### TypeScript Compiler Errors

#### `Cannot find module 'blendsdk/webafx-i18n' or its corresponding type declarations.` (TS2307)

**Cause** — The package is ESM-only and published with an `exports` map. TypeScript only reads `exports` when `moduleResolution` is `node16`, `nodenext`, or `bundler`. With the legacy `"node"` resolution, TS ignores the map and cannot find the type declarations. A missing dependency in `node_modules` produces the same message.

**Fix** — Use a modern module configuration and declare your consuming package as ESM:

```json
{
    "compilerOptions": {
        "target": "es2023",
        "module": "nodenext",
        "moduleResolution": "nodenext",
        "strict": true,
        "verbatimModuleSyntax": true
    }
}
```

```json
{
    "name": "my-webafx-app",
    "type": "module"
}
```

#### `Module '"blendsdk/webafx-i18n"' has no default export.` (TS2613) / `Module '...' has no exported member 'PluginDefinition'.` (TS2305)

**Cause** — The package has no default export, and several names that examples use come from *other* packages. A frequent mistake is importing `PluginDefinition` or `Logger` from this package instead of `blendsdk/webafx`.

**Fix** — Use named imports from the correct package:

```typescript
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export function buildPlugin(): PluginDefinition {
    return createI18nPlugin({ defaultLocale: "en", sources: [] });
}
```

What this package actually exports:

| Kind | Exports |
| --- | --- |
| Values | `createI18nPlugin`, `PostgreSQLSource`, `postgresqlSource`, `resolveLocale`, `parseAcceptLanguage`, `Translator`, `mergeCatalogs`, `JsonFileSource`, `jsonFileSource`, `ContentFileSource`, `contentFileSource` |
| Types | `I18nPluginConfig`, `PostgreSQLSourceConfig`, `TranslationCatalog`, `TranslationEntry`, `TranslationValue`, `TranslationSource`, `TranslatorConfig`, `JsonFileSourceConfig`, `ContentFileSourceConfig` |

`PluginDefinition`, `Plugin`, `Logger`, `Request`, and `Response` come from `blendsdk/webafx` and `express`, respectively.

#### `'Translator' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.` (TS1484)

**Cause** — Imports are split by usage under `verbatimModuleSyntax`: identifiers used only in type positions (`Translator`, `I18nPluginConfig`, `TranslationSource`, and so on) must use `import type`, or the emitted JavaScript would import bindings that do not exist at runtime.

**Fix** — Split value imports from type imports:

```typescript
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { I18nPluginConfig, Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

const config: I18nPluginConfig = {
    defaultLocale: "en",
    sources: [],
};

export const i18nPlugin = createI18nPlugin(config);

export async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");
    res.json({ message: translator.translate("greeting", locale) });
}
```

`Translator` is exported as a class, so it *can* be imported as a value when you need to construct one or use `instanceof` — but if it only appears in type positions, `import type` is required under this flag.

#### `Expected 3 arguments, but got 2.` (TS2554) on `resolveLocale`

**Cause** — `resolveLocale(req, defaultLocale, cookieName)` has a required third parameter of type `string | false` with no default. Calling it with two arguments fails to compile, even when you do not use cookies.

**Fix** — Pass the cookie name, or `false` when cookie resolution should be skipped (matching `localeCookieName: false` semantics):

```typescript
import { resolveLocale } from "blendsdk/webafx-i18n";
import type { Request } from "express";

export function resolveWithoutCookies(req: Request): string {
    // Third argument is required — pass a cookie name or `false`
    return resolveLocale(req, "en", false);
}
```

#### `Object is possibly 'undefined'.` (TS2532) when indexing catalogs

**Cause** — With `noUncheckedIndexedAccess` enabled, every index access into `TranslationCatalog` (a record type) yields `TranslationEntry | undefined`. Directly reading `catalog[key][locale]` on a possibly-missing key fails to compile.

**Fix** — Narrow with an explicit guard before indexing:

```typescript
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

export function localeCount(catalog: TranslationCatalog, key: string): number {
    const entry = catalog[key];
    if (!entry) {
        return 0;
    }
    return Object.keys(entry).length;
}
```

### Runtime Module Errors

#### `Error [ERR_REQUIRE_ESM]: require() of ES Module ... not supported.`

**Error / Symptom** — Booting from a CommonJS entry point fails immediately with `require() of ES Module ... not supported`, or a deep import fails with `Error [ERR_PACKAGE_PATH_NOT_EXPORTED]`.

**Cause** — The package has `"type": "module"` and its `exports` map exposes only `.` with an `"import"` condition — there is no CommonJS build and no subpath access to `dist/` files. (On Node 22.12+, `require()` can load many ESM modules, but depending on that couples you to specific patch versions and breaks as soon as a module graph contains top-level await.)

**Fix** — Consume the package as ESM, and never import from `dist/` or any subpath:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

export const i18nPlugin = createI18nPlugin({
    defaultLocale: "en",
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
});
```

Set `"type": "module"` in your package and compile with `"module": "nodenext"` (see the TS2307 entry for the full configuration). If a legacy CommonJS entry cannot be migrated, load the package with a native dynamic `import()` at that entry point instead of `require()`.

---

## Debugging Strategies

### 1. Read the plugin's own log trail first

The plugin logs every lifecycle step through the WebAFX `Logger` (`logger.info` / `logger.error`), so all of these lines reach your configured log sink. They are the fastest way to localize a problem — find the first line that diverges from the expected sequence.

Startup lines, in order:

| Log line | What it tells you |
| --- | --- |
| `I18n: loading from <name>...` | A source's `load()` is about to be awaited. If startup fails, this names the failing source. |
| `I18n: <name> loaded <N> keys` | The source resolved. `N = 0` means it returned an empty catalog without throwing. |
| `I18n plugin: loaded <N> translation keys from <M> source(s)` | The size of the merged catalog — the exact dataset the translator will serve. |
| `I18n plugin: subscribed to reload channel "<channel>"` | Pub/sub reload is active. |
| `I18n plugin: pub/sub service "<name>" not available — reload channel "<channel>" will not be active` | No pub/sub provider was registered when the factory ran (see the pub/sub entry above). |
| `I18n plugin "<serviceName>" initialized` | The factory finished; all three services are registered. |

A healthy startup looks like:

```text
I18n: loading from JsonFileSource...
I18n: JsonFileSource loaded 128 keys
I18n: loading from PostgreSQLSource...
I18n: PostgreSQLSource loaded 42 keys
I18n plugin: loaded 151 translation keys from 2 source(s)
I18n plugin: subscribed to reload channel "i18n:reload"
I18n plugin "i18n" initialized
```

Reload-time lines to watch for:

- `I18n reload triggered via pub/sub` — a pub/sub message arrived.
- `I18n: reload complete — <N> keys loaded` — the catalog swap succeeded.
- `I18n: reload failed, keeping previous catalog: <cause>` — the swap was skipped and the previous catalog is still live.

### 2. Probe each source in isolation

The plugin calls exactly `source.load()` — do the same yourself to see the raw catalog or the raw error without booting the application. This is step one for every startup failure and every "0 keys" report.

1. Construct the source with the same configuration the plugin uses.
2. Call `load()` inside `try/catch`.
3. Compare the key count with what the plugin logged.

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export async function probeSource(database: DatabaseClient): Promise<void> {
    const source = postgresqlSource({
        queryFn: (sql) => database.query(sql),
        tableName: "translations",
    });

    try {
        const catalog: TranslationCatalog = await source.load();
        const keys = Object.keys(catalog);
        console.log(`[probe] ${source.name}: ${keys.length} keys`);
        for (const key of keys.slice(0, 5)) {
            console.log(`[probe]   ${key}: ${JSON.stringify(catalog[key])}`);
        }
    } catch (error) {
        console.error(
            `[probe] ${source.name} failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
```

### 3. Rebuild the merge to expose override conflicts

When a string you expect is missing or different, the cause is usually the merge: later sources win for the same key + locale. Reproduce `mergeCatalogs()` with the catalogs you captured from step 2 and list every override explicitly.

1. Probe each configured source and keep its catalog.
2. Run the diff below with the catalogs in plugin configuration order.
3. Every printed line is a key + locale where an earlier source lost — confirm that is intended.

```typescript
import { mergeCatalogs } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

/** Reports every key + locale where `after` overrides a value from `before`. */
export function reportOverrides(before: TranslationCatalog, after: TranslationCatalog): void {
    const merged = mergeCatalogs([before, after]);
    for (const key of Object.keys(merged)) {
        for (const locale of Object.keys(merged[key])) {
            const previous = before[key] ? before[key][locale] : undefined;
            const current = after[key] ? after[key][locale] : undefined;
            if (previous !== undefined && current !== undefined && previous !== current) {
                console.log(
                    `[merge] "${key}" (${locale}): ${JSON.stringify(previous)} → ${JSON.stringify(current)}`
                );
            }
        }
    }
}
```

### 4. Trace a single request through the locale resolver

Locale bugs are almost always "the resolver returned something slightly different than the catalog key". Log every input and the output for real requests instead of guessing.

1. Log the raw query value, the raw `Accept-Language` header, and the resolved locale in one place.
2. Compare the resolved value against your catalog keys — separator by separator.
3. Add the plugin-side `onMissingTranslation` hook to capture exactly which keys and locale strings are arriving in production traffic.

```typescript
import { parseAcceptLanguage, resolveLocale } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export function traceLocaleFromRequest(req: Request): string {
    const resolved = resolveLocale(req, "en", "locale");
    console.log(`[locale] query: ${JSON.stringify(req.query.locale)}`);
    console.log(`[locale] accept-language: ${req.headers["accept-language"]}`);
    console.log(`[locale] header-only parse: ${parseAcceptLanguage(req.headers["accept-language"] ?? "")}`);
    console.log(`[locale] resolved: ${resolved}`);
    return resolved;
}

export async function localeDebugHandler(req: Request, res: Response): Promise<void> {
    res.json({ resolved: traceLocaleFromRequest(req) });
}
```

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

export const i18nPlugin = createI18nPlugin({
    defaultLocale: "en",
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    onMissingTranslation: (key, locale) => {
        // Log the raw locale string — "en-US" vs "en_US" mismatches show up here first
        console.log(`[i18n] missing: ${key} @ ${locale}`);
    },
});
```

### 5. Reproduce lookups with the exported `Translator`

`Translator` and `mergeCatalogs` are re-exported precisely so you can build the same object the plugin builds. This isolates "the string is missing from the catalog" from "the lookup never reaches it".

1. Build a `Translator` from a small hand-written catalog.
2. Translate with the exact strings the resolver produces (`en_US` for the header `en-US`; the raw `en-US` when it came from `?locale=`).
3. Observe which lookups hit and which fall through to the missing path.

```typescript
import { Translator } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

export function probeTranslator(): void {
    const catalog: TranslationCatalog = {
        greeting: { en: "Hello", en_US: "Hello (United States)" },
    };

    const translator = new Translator({
        defaultLocale: "en",
        catalog,
        onMissingTranslation: (key, locale) => {
            console.log(`[i18n] missing translation: ${key} (${locale})`);
        },
    });

    console.log(translator.translate("greeting", "en_US")); // "Hello (United States)"
    console.log(translator.translate("greeting", "en"));    // "Hello"
}
```

### 6. Verify service names and exercise the reload path

Two quick checks that close out most remaining "it does nothing" reports.

1. Before boot, assert the plugin's `name` and `priority` equal what your bootstrap expects — `name` is exactly the `serviceName` you configured.
2. Map out the three registered services so your handlers resolve the right names.
3. At runtime, call the reload service explicitly and watch for `I18n: reload complete — <N> keys loaded` versus `I18n: reload failed, keeping previous catalog`.

```typescript
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export const i18nPlugin = createI18nPlugin({
    sources: [],
    serviceName: "translations",
    localeServiceName: "request-locale",
});

// plugin.name     → "translations" (default would be "i18n")
// plugin.priority → 40
// Registered at factory time:
//   "translations"        → Translator (singleton)
//   "translations:reload" → () => Promise<void> (singleton)
//   "request-locale"      → string (per-request)

export async function reloadTranslations(req: Request, res: Response): Promise<void> {
    const reload = await req.services.get<() => Promise<void>>("translations:reload");
    await reload();
    const translator = await req.services.get<Translator>("translations");
    const locale = await req.services.get<string>("request-locale");
    res.json({ sample: translator.translate("greeting", locale) });
}
```

---

## Known Pitfalls

These are behaviors that are easy to miss because nothing errors — the system simply does something different from what you expect.

### Later sources win — the merge order is easy to invert

Sources merge left to right and **later sources override earlier ones** for the same key + locale. Putting the database first and the files second means file strings silently win over database edits. The conventional order is "files first, database second" so administrators override the shipped base.

### Only `Accept-Language` is normalized, and only the first hyphen

The resolver normalizes `en-US` → `en_US` on the header path — but `zh-Hant-TW` becomes `zh_Hant-TW` (only the first `-` is replaced, it is a string replace, not a regex), and query/cookie values are never normalized at all. Catalog keys must match resolver output character-for-character; choose underscores everywhere and validate incoming values as shown in [Wrong language served](#wrong-language-served--translations-never-match-for-some-requests).

### `?locale=` is unvalidated, overrides everything, and is persisted for a year

The query parameter wins over header and cookie, is trusted verbatim (no check against supported locales), and the *resolved* locale — whatever its source — is written to the locale cookie with a one-year max-age. Consequences: a shared link like `/?locale=nl` permanently switches that browser; a crawler hitting such links writes cookies you never intended; and `?locale=en-US` persists a hyphenated value that can never match `en_US` catalog keys. Also note that Express parses `?locale=nl&locale=de` into an array, which fails the `typeof === "string"` check and is silently ignored entirely.

### Cookie resolution silently depends on cookie-parsing middleware

`req.cookies?.[cookieName]` uses optional chaining, so a missing `req.cookies` (no cookie-parsing middleware in the pipeline) degrades to "no cookie" without any error or log. See [Saved cookie preferences are ignored](#saved-cookie-preferences-are-ignored).

### The locale cookie is only written when the `locale` service is resolved

Per-request services are lazy. If a route never resolves the `locale` service, no `Set-Cookie` is emitted for that request, making persistence appear flaky depending on which routes rendered. The cookie is also written with `httpOnly: false` and `sameSite: "lax"` — intentionally client-readable, but that means its value is user-controllable input and should be validated like the query parameter.

### Reload failures resolve successfully, and `health()` is shallow

`i18n:reload` never throws — a failed reload logs `I18n: reload failed, keeping previous catalog: <cause>` and resolves normally. And the plugin's `health()` hook is `async () => true` unconditionally: it reports `true` even when the catalog is empty or every reload is failing. Do not wire reload calls or plugin health into monitoring and expect them to detect translation problems — only the logs reveal them.

### The pub/sub integration can go silent or mislead in its logs

Two related traps beyond the documented "not available" line: if the service under `pubsubServiceName` resolves but has no `subscribe` function, the plugin skips subscription **without logging anything** — you see neither "subscribed" nor "not available". And because the whole subscribe block is wrapped in one `try/catch`, a provider whose `subscribe()` throws still produces the "not available" message, which points at the wrong problem. Always confirm the `subscribed to reload channel` line and inspect the provider object itself.

### Plural parsing is strict about shape — everything else silently becomes raw JSON text

`parseValue()` only accepts a JSON array of **exactly two strings** as a `[singular, plural]` tuple. `["one"]`, a three-element array, an array with non-string members, or invalid JSON all fall back to returning the raw string — so literal text like `["one"]` or `[not valid json` ends up rendered in your UI. Enforce the `["singular","plural"]` format at the data-entry or import layer.

### `tableName` and `filter` are interpolated verbatim into SQL

`PostgreSQLSource` concatenates both options directly into the query text. Never build them from request data — treat them as static configuration (SQL injection risk otherwise), and remember that a typo in `filter` turns into a SQL error at startup (fail-fast) or a `reload failed` log line (at reload). The companion trap is `NULL` values in the `value` column crashing `parseValue()` — see the `startsWith` entry above.

### Renaming `serviceName` silently renames the reload service too

`serviceName: "translations"` registers `translations` **and** `translations:reload`. Code, admin endpoints, and tests that hardcode `i18n:reload` keep compiling and then fail at runtime with a service-resolution error. Derive the reload name as `${serviceName}:reload` in your own code.

### `onMissingTranslation` fires on every missed lookup — including hot paths

The callback runs per failed `translate()` call. A single wrong locale (separator mismatch, unsupported `?locale=`) can turn every rendered key of every request into a callback invocation — flooding logs or metrics. It is excellent as a temporary diagnostic and should be rate-limited or sampled in production.

### Every reload is a full reload of every source, in memory

Each source's entire catalog is loaded into memory at startup, and each reload re-reads everything and merges it again. Large translation tables pay the full cost per reload, and the swap only happens after all sources have resolved — keep reload triggers deliberate rather than per-request.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
