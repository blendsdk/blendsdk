> **Package**: `blendsdk/webafx-i18n`

# webafx-i18n Core Concepts

---

This document is a deep dive into every major abstraction in `blendsdk/webafx-i18n`. Each concept follows the same structure: what it is, how it works internally, a complete TypeScript example, and a reference table. If you are new to the package, read the Overview first, and see Basic Usage for a step-by-step setup.

Concepts at a glance:

- **The plugin definition** — `createI18nPlugin()` and `I18nPluginConfig`
- **The `TranslationSource` contract** — the interface every translation backend implements
- **`PostgreSQLSource`** — the built-in database source with plural parsing
- **File sources** — `JsonFileSource` and `ContentFileSource` re-exported from the core package
- **Catalog merging** — `mergeCatalogs()` and the "later source wins per key + locale" rule
- **The `Translator` service** — the singleton that answers translation lookups
- **Locale resolution** — the request priority chain and the per-request `locale` service
- **Catalog reload** — the manual `i18n:reload` service and distributed pub/sub reload

---

## The Plugin Definition: `createI18nPlugin`

### What It Is

`createI18nPlugin()` is the package's single entry point. It takes an `I18nPluginConfig` object and returns a WebAFX `PluginDefinition` whose `factory` runs once during application startup: it loads every configured translation source, merges the catalogs, creates a `Translator`, and registers the plugin's services in the WebAFX service container. The plugin installs at priority `40` by default — after framework infrastructure plugins such as caching and pub/sub — and its `name` defaults to the primary service name, `"i18n"`.

### How It Works

When the WebAFX pipeline executes the plugin factory, the following steps run in order:

1. **Load sources** — every `TranslationSource` in `config.sources` is loaded in order and its catalog merged; for the same key + locale, later sources override earlier ones (see [Catalog Merging](#catalog-merging-with-mergecatalogs)).
2. **Create the `Translator`** — `new Translator({ defaultLocale, catalog, onMissingTranslation })` is constructed from the merged catalog.
3. **Register singleton services** — the `Translator` under `serviceName` (default `"i18n"`), and an async reload function under `${serviceName}:reload` (default `"i18n:reload"`).
4. **Register the per-request locale service** — under `localeServiceName` (default `"locale"`). Its factory resolves the locale for every request and persists it to a cookie, unless `localeCookieName: false` was configured. See [Locale Resolution](#locale-resolution-and-the-locale-service).
5. **Optionally subscribe to pub/sub** — when `reloadChannel` is set and a pub/sub provider is registered under `pubsubServiceName` (default `"pubsub"`), incoming messages trigger a full source reload (see [Catalog Reload](#catalog-reload-manual-and-distributed)). If the provider is missing, the plugin logs that the channel is inactive and startup continues normally.
6. **Return plugin hooks** — the factory resolves to a `Plugin` whose `health()` hook always resolves to `true`.

The services registered by default:

| Service name | Registration type | Resolves to |
| --- | --- | --- |
| `i18n` | `singleton` | `Translator` built from the merged catalog |
| `i18n:reload` | `singleton` | `() => Promise<void>` — reloads all sources and swaps the catalog |
| `locale` | `per-request` | `string` — the resolved locale for the current request |

### Complete Example

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createTranslationsPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            // Base strings from JSON files (loaded first)
            jsonFileSource({ paths: ["./translations/*.json"] }),
            // Database rows override the base for the same key + locale
            postgresqlSource({
                queryFn: (sql) => database.query(sql),
                tableName: "translations",
                filter: "active = true",
            }),
        ],
        // Service names, persistence, and install order (defaults shown)
        serviceName: "i18n",
        localeServiceName: "locale",
        localeCookieName: "locale",
        priority: 40,
    });
}

// In your application bootstrap (`app` is your WebAFX application instance
// and `database` is your PostgreSQL client):
const i18nPlugin = createTranslationsPlugin(database);
app.use(i18nPlugin);
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `createI18nPlugin` | `(config: I18nPluginConfig): PluginDefinition` | Creates the WebAFX plugin definition (`name`, `priority`, `factory`) |
| `I18nPluginConfig` | `interface` | Plugin configuration — see the options table below |

`I18nPluginConfig` options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultLocale` | `string` | `"en"` | Fallback locale when none can be resolved; also passed to the `Translator` |
| `sources` | `TranslationSource[]` | — (required) | Sources loaded in order; later sources override earlier ones per key + locale |
| `serviceName` | `string` | `"i18n"` | Name of the singleton `Translator` service (and the plugin name) |
| `localeServiceName` | `string` | `"locale"` | Name of the per-request resolved-locale service |
| `localeCookieName` | `string \| false` | `"locale"` | Cookie used to persist the resolved locale; `false` disables persistence |
| `reloadChannel` | `string` | — | Pub/sub channel whose messages trigger a full source reload |
| `pubsubServiceName` | `string` | `"pubsub"` | Container name of the pub/sub provider used by `reloadChannel` |
| `onMissingTranslation` | `(key: string, locale: string) => void` | — | Invoked whenever a translation key is missing |
| `priority` | `number` | `40` | Plugin installation priority — lower numbers install first |

---

## The `TranslationSource` Contract

### What It Is

`TranslationSource` is the strategy interface behind the package's multi-source loading. Every translation backend — the built-in `PostgreSQLSource`, the file sources, or your own implementation — fulfills the same minimal contract: a `name` used in log output and an async `load()` that returns a `TranslationCatalog`. The plugin never talks to a database, a filesystem, or an API directly; it only orchestrates sources.

### How It Works

The plugin calls `load()` once per source at startup, and again for every reload. Catalogs are collected in configuration order and passed to `mergeCatalogs()` — the last source that defines a given key + locale wins (see [Catalog Merging](#catalog-merging-with-mergecatalogs)). Sources are stateless from the plugin's perspective: `load()` receives no arguments and may perform any async I/O.

Error semantics differ by phase:

- **At startup**, an error thrown by `load()` rejects the plugin factory — plugin initialization fails, surfacing the problem immediately.
- **At reload**, errors are caught and logged by the plugin, which keeps the previous catalog, so a broken backend never takes down a running application.

Implementing a custom source is simply a matter of satisfying the contract and adding the instance to the `sources` array of the plugin config.

### Complete Example

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export class RemoteApiSource implements TranslationSource {
    readonly name = "RemoteApiSource";

    constructor(private readonly endpoint: string) {}

    async load(): Promise<TranslationCatalog> {
        const response = await fetch(this.endpoint);
        if (!response.ok) {
            throw new Error(`RemoteApiSource: HTTP ${response.status} from ${this.endpoint}`);
        }
        const catalog = (await response.json()) as TranslationCatalog;
        return catalog;
    }
}

export function createPluginWithRemoteSource(): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            new RemoteApiSource("https://translations.example.com/api/catalog"),
        ],
    });
}
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `TranslationSource.name` | `readonly string` | Source identifier used in log output (`I18n: loading from <name>...`) |
| `TranslationSource.load` | `() => Promise<TranslationCatalog>` | Returns this source's complete catalog; called at startup and on every reload |
| `TranslationCatalog` | `translation key → locale → value` | The complete translation data returned by a source |
| `TranslationEntry` | `locale → value` | All translations of a single key |
| `TranslationValue` | `string \| [string, string]` | Plain text, or a `[singular, plural]` tuple |

---

## `PostgreSQLSource`

### What It Is

`PostgreSQLSource` is the built-in database-backed `TranslationSource`. It reads a table with `key`, `locale`, and `value` columns and normalizes the rows into a `TranslationCatalog`. It never touches a database driver directly — it executes SQL through an injected `queryFn` callback, which keeps the source decoupled from any particular PostgreSQL client, including `blendsdk/postgresql`.

### How It Works

`load()` performs three steps:

1. **Build the query** — `SELECT key, locale, value FROM <tableName>`, plus ` WHERE <filter>` when a filter is configured, plus ` ORDER BY key, locale`. `tableName` defaults to `"translations"`.
2. **Execute it** — through `queryFn(sql)`; each returned row is mapped to `catalog[row.key][row.locale] = parseValue(row.value)`.
3. **Parse values** — `parseValue()` detects plural forms: a value starting with `[` is parsed as JSON, and when the result is an array of exactly two strings it becomes a `[singular, plural]` tuple. Anything else — plain text, invalid JSON, or an array of another length — is kept as a plain string.

Because `tableName` and `filter` are interpolated into the SQL text verbatim, keep them static and trusted — never build them from user input. `parseValue()` is `protected`, so subclasses can plug in additional value encodings.

How stored values map to `TranslationValue`:

| Stored `value` column | Resulting `TranslationValue` |
| --- | --- |
| `` `Hello` `` | `"Hello"` — plain string |
| `` `["${count} book","${count} books"]` `` | `["${count} book", "${count} books"]` — plural tuple |
| `` `["only one"]` `` | `["only one"]` kept as a plain string (not a two-element tuple) |
| `` `[not valid json` `` | `"[not valid json"` — not valid JSON, kept as a plain string |

### Complete Example

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export async function loadDatabaseTranslations(
    database: DatabaseClient
): Promise<TranslationCatalog> {
    const source = postgresqlSource({
        queryFn: (sql) => database.query(sql),
        tableName: "translations",
        filter: "active = true AND app = 'myapp'",
    });

    try {
        const catalog = await source.load();
        return catalog;
    } catch (error) {
        // Startup is the right place to surface database failures
        throw new Error(
            `PostgreSQLSource: could not load translations — ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `PostgreSQLSource.name` | `readonly string` = `"PostgreSQLSource"` | Source identifier used in logs |
| `load` | `() => Promise<TranslationCatalog>` | Builds the SQL, executes it, and normalizes rows into a catalog |
| `parseValue` | `protected (value: string) => string \| [string, string]` | Parses a stored value; override in a subclass to extend |
| `postgresqlSource` | `(config: PostgreSQLSourceConfig): PostgreSQLSource` | Factory — equivalent to `new PostgreSQLSource(config)` |

`PostgreSQLSourceConfig` options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `queryFn` | `(sql: string) => Promise<Array<{ key: string; locale: string; value: string }>>` | — (required) | Executes the generated SQL and returns rows |
| `tableName` | `string` | `"translations"` | Table containing the translations |
| `filter` | `string` | — | `WHERE` clause without the `WHERE` keyword (interpolated verbatim) |

---

## File Sources: `JsonFileSource` and `ContentFileSource`

### What It Is

`JsonFileSource` and `ContentFileSource` are the Node.js-only translation sources from `blendsdk/i18n-node`, re-exported by this package together with their factory functions `jsonFileSource` and `contentFileSource`, so a WebAFX plugin config needs a single import. `JsonFileSource` loads translations from JSON files matched by path patterns; `ContentFileSource` loads translations managed as content. Both implement the same `TranslationSource` contract and participate in the standard merge order.

### How It Works

Both sources read from disk when `load()` is called — at plugin startup and on every reload — and return a `TranslationCatalog` that joins the merge chain like any other source. They are exported from the `/node` subpath of the core package because they depend on the Node.js filesystem, so keep them out of browser bundles. In a WebAFX server (Node.js ≥ 22) that is never a problem; it only matters if you share modules between server and client code.

The factory pattern is the same across all built-in sources — `jsonFileSource(...)`, `contentFileSource(...)`, and `postgresqlSource(...)` — so plugin `sources` arrays read as a uniform list of backend specifications.

### Complete Example

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

// Load a catalog from translation files directly…
export async function loadFileCatalog(): Promise<TranslationCatalog> {
    const source = jsonFileSource({ paths: ["./translations/*.json"] });
    return source.load();
}

// …or hand the source to the plugin for lifecycle-managed loading:
export function createFileBasedPlugin(): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    });
}
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `JsonFileSource` | `implements TranslationSource` | Node.js-only source that loads translations from JSON files |
| `jsonFileSource` | `(config: JsonFileSourceConfig): JsonFileSource` | Factory — typical config: `{ paths: ["./translations/*.json"] }` |
| `JsonFileSourceConfig` | `interface` | Options for the JSON file source, including `paths: string[]` |
| `ContentFileSource` | `implements TranslationSource` | Node.js-only source that loads translations from content files |
| `contentFileSource` | `(config: ContentFileSourceConfig): ContentFileSource` | Factory |
| `ContentFileSourceConfig` | `interface` | Options for the content file source — see `blendsdk/i18n` for details |

---

## Catalog Merging with `mergeCatalogs`

### What It Is

`mergeCatalogs()` is the function the plugin uses to fold all loaded sources into the single catalog behind the `i18n` service. It is re-exported from `blendsdk/i18n` and can also be used directly — for example, to layer runtime overrides on top of loaded catalogs before constructing a `Translator` yourself.

### How It Works

Merge rules, applied left to right:

- The result contains the **union of all keys** from every catalog.
- For a given key + locale, **the last catalog that defines it wins**.
- Locales of a key that a later catalog does not redefine are **preserved** from earlier catalogs.

The plugin hands the sources' catalogs to `mergeCatalogs` in configuration order. That is why a typical setup of "files first, database second" gives database rows precedence for keys maintained by administrators, without losing file-only locales for the same key.

### Complete Example

```typescript
import { mergeCatalogs } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

const base: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye" },
};

const overrides: TranslationCatalog = {
    greeting: { en: "Hi there" },
};

const merged = mergeCatalogs([base, overrides]);

console.log(merged.greeting.en); // "Hi there" — later catalog wins for the same key + locale
console.log(merged.greeting.nl); // "Hallo" — locales the later catalog does not redefine survive
console.log(merged.farewell.en); // "Goodbye" — keys are the union of all catalogs
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `mergeCatalogs` | `(catalogs: TranslationCatalog[]): TranslationCatalog` | Merges catalogs left to right; later entries override earlier ones per key + locale |

---

## The `Translator` Service

### What It Is

The `Translator` is the object that actually answers translation lookups. The plugin creates one instance from the merged catalog and registers it as a `singleton` service — by default under `"i18n"` — so every request in the process shares one catalog. The class itself lives in `blendsdk/i18n` and is re-exported here for convenience and typing.

### How It Works

- **Creation** — at startup the plugin calls `new Translator({ defaultLocale, catalog, onMissingTranslation })`, where `catalog` is the merged result of all sources and `onMissingTranslation` mirrors the plugin config.
- **Registration** — the service is a singleton: its factory returns the already-created instance, and no per-request work happens on resolution. If you renamed the service via `serviceName`, retrieve it under the new name.
- **Lookup** — resolve the service from the container and call `translate(key, locale)`. The locale typically comes from the per-request `locale` service (see [Locale Resolution](#locale-resolution-and-the-locale-service)).
- **Missing keys** — when a key cannot be resolved, the configured `onMissingTranslation(key, locale)` callback runs, making it easy to log gaps or feed a metrics pipeline.
- **Catalog swaps** — reloads call `setCatalog()` with a freshly merged catalog; because the instance is shared, every subsequent `translate()` call sees the new data immediately.

### Complete Example

```typescript
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");

    res.json({
        greeting: translator.translate("greeting", locale),
        farewell: translator.translate("farewell", locale),
    });
}
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `i18n` service | `singleton` → `Translator` | Registered under `serviceName` (default `"i18n"`) |
| `Translator` | re-exported class from `blendsdk/i18n` | The translator implementation |
| `translate` | `(key: string, locale: string): string` | Resolves a translation from the merged catalog |
| `setCatalog` | `(catalog: TranslationCatalog): void` | Replaces the in-memory catalog (used by reloads) |
| `TranslatorConfig.defaultLocale` | `string` | Supplied from `I18nPluginConfig.defaultLocale` |
| `TranslatorConfig.catalog` | `TranslationCatalog` | The merged catalog from all sources |
| `TranslatorConfig.onMissingTranslation` | `(key: string, locale: string) => void` | Optional missing-key hook, forwarded from the plugin config |

---

## Locale Resolution and the `locale` Service

### What It Is

Locale resolution decides which language an incoming request should be served in. The pure functions `resolveLocale()` and `parseAcceptLanguage()` implement the priority chain; the plugin wraps `resolveLocale()` in a per-request service (default name `"locale"`) that additionally persists the resolved locale to a cookie so a user's choice sticks across visits.

### How It Works

`resolveLocale(req, defaultLocale, cookieName)` checks the request in this order — first match wins:

| # | Source | Example | Notes |
| --- | --- | --- | --- |
| 1 | Query parameter | `?locale=nl` | Must be a non-empty string; the value is trimmed and returned as-is |
| 2 | `Accept-Language` header | `Accept-Language: nl, en;q=0.8` | Parsed and quality-sorted; `en-US` is normalized to `en_US` |
| 3 | Cookie | `locale=nl` | Skipped when `cookieName` is `false`; the lookup is optional-chained |
| 4 | Default | — | The configured `defaultLocale` (`"en"` unless changed) |

`parseAcceptLanguage(header)` splits the header on `,`, reads each entry's `q=` quality (default `1.0`), discards wildcard (`*`), empty, and zero-quality entries, sorts by quality descending, and normalizes the winner's region separator (`en-US` → `en_US`). When nothing usable remains it returns `null`, and resolution falls through to the next step.

The per-request `locale` service calls exactly this logic and, when a cookie name is configured, writes the locale back to the response with:

| Cookie option | Value |
| --- | --- |
| `httpOnly` | `false` — the preference stays readable/writable from client-side JavaScript |
| `sameSite` | `"lax"` |
| `maxAge` | One year (`365 * 24 * 60 * 60 * 1000` ms), refreshed on every request |

### Complete Example

```typescript
import { resolveLocale, parseAcceptLanguage } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

// Standalone resolution — identical priority chain, no cookie side effects
export function chooseLocale(req: Request): string {
    return resolveLocale(req, "en", "locale");
}

// Inside a WebAFX handler the plugin has already resolved and cookie-persisted it
export async function greet(req: Request, res: Response): Promise<void> {
    const locale = await req.services.get<string>("locale");
    const translator = await req.services.get<Translator>("i18n");
    res.json({ message: translator.translate("greeting", locale) });
}

// Accept-Language parsing is also exported for custom negotiation logic
const best = parseAcceptLanguage("en-US,en;q=0.9,nl;q=0.8"); // "en_US"
const wildcard = parseAcceptLanguage("*"); // null
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `resolveLocale` | `(req: Request, defaultLocale: string, cookieName: string \| false) => string` | Applies the priority chain for one request |
| `parseAcceptLanguage` | `(header: string) => string \| null` | Returns the best locale, or `null` when none is usable |
| `locale` service | `per-request` → `string` | Registered under `localeServiceName` (default `"locale"`) |

---

## Catalog Reload: Manual and Distributed

### What It Is

Reload is the runtime refresh path: re-running every configured source and swapping the translator's catalog without restarting the application. It has two triggers — the manual `i18n:reload` service, registered on every installation, and an optional pub/sub channel for distributed setups where one instance (or an operator) tells all instances to refresh.

### How It Works

Both triggers funnel into the same internal routine, which:

1. Reloads every source in configuration order and merges the catalogs again (same merge rules as startup).
2. Calls `translator.setCatalog(merged)` — an atomic swap on the shared singleton, immediately visible to subsequent lookups.
3. Logs the key count on success. On failure it logs the error and **keeps the previous catalog** — a reload never throws to the caller and never leaves the app without translations.

The two triggers:

- **Manual** — the singleton `i18n:reload` service resolves to a `() => Promise<void>` function. Resolve it from the service container and `await` it. With a custom `serviceName`, the reload service is named `${serviceName}:reload`.
- **Distributed** — set `reloadChannel` in the plugin config. At startup the plugin looks up the pub/sub provider under `pubsubServiceName` (default `"pubsub"`), subscribes to the channel, and reloads on every message. The provider comes from `blendsdk/webafx-cache`; if it is not installed, the plugin logs that the channel is inactive and startup continues normally.

### Complete Example

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";
import type { Request, Response } from "express";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

// 1. Opt into distributed reload via a pub/sub channel
export function createReloadableI18n(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            postgresqlSource({ queryFn: (sql) => database.query(sql) }),
        ],
        reloadChannel: "i18n:reload",
        pubsubServiceName: "pubsub",
    });
}

// 2. Trigger a reload manually from any handler (admin endpoint, webhook, CLI)
export async function reloadTranslations(req: Request, res: Response): Promise<void> {
    const reload = await req.services.get<() => Promise<void>>("i18n:reload");
    await reload();
    res.json({ reloaded: true });
}
```

### Key Methods and Properties

| Name | Type/Signature | Description |
| --- | --- | --- |
| `i18n:reload` service | `singleton` → `() => Promise<void>` | Reloads all sources and swaps the catalog (`${serviceName}:reload` when renamed) |
| `reloadChannel` | `string` (config) | Pub/sub channel that triggers the same reload on every message |
| `pubsubServiceName` | `string` (config, default `"pubsub"`) | Container name of the pub/sub provider used for `reloadChannel` |

---

# webafx-i18n Basic Usage

---

This guide takes you from installation to a working multilingual WebAFX server. It assumes a WebAFX application instance (`app`) and Express-style `Request`/`Response` handlers, and it builds up the API in five small steps — each one adds a single concept. For the architecture behind these APIs, see Core Concepts.

---

## Installation

Install the package with npm or yarn:

```bash
# npm
npm install blendsdk/webafx-i18n

# yarn
yarn add blendsdk/webafx-i18n
```

The package is ESM-only (`"type": "module"`) and requires Node.js ≥ 22 — use `import`, never `require()`. `blendsdk/i18n` is installed automatically as a regular dependency; the following peer dependencies come from your application:

| Package | Required | Purpose |
| --- | --- | --- |
| `blendsdk/webafx` | Yes | The host framework: plugin pipeline, service container, logger |
| `blendsdk/webafx-cache` | Optional | Pub/sub provider needed only when you configure `reloadChannel` |
| `blendsdk/postgresql` | Optional | Convenience for wiring `PostgreSQLSource.queryFn` — any function that returns rows works |

The package re-exports the browser-safe i18n core (`Translator`, `mergeCatalogs`, and all translation types) plus the Node.js file sources (`JsonFileSource`, `ContentFileSource`), so a single import covers everything you need on the server.

---

## Quick Start

Create a translation file — for example `./translations/common.json`:

```json
{
    "greeting": {
        "en": "Hello",
        "nl": "Hallo"
    },
    "farewell": {
        "en": "Goodbye",
        "nl": "Tot ziens"
    }
}
```

Install the plugin on your WebAFX application (`app` is your WebAFX application instance):

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

app.use(
    createI18nPlugin({
        defaultLocale: "en",
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    })
);
```

That is the whole setup. At startup the plugin loads every source, merges the catalogs, and registers the `i18n` and `locale` services. Any handler can now translate:

```typescript
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");
    res.json({ message: translator.translate("greeting", locale) });
}
```

With the file above, `GET /greet?locale=nl` answers `{"message":"Hallo"}`, while an English browser gets `{"message":"Hello"}`.

---

## Fundamentals

### Step 1 — Create the plugin

`createI18nPlugin()` takes an `I18nPluginConfig` and returns a WebAFX `PluginDefinition`. Only `sources` is required — everything else has a default:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export function createTranslationsPlugin(): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    });
}
```

When the WebAFX pipeline runs the plugin factory at startup, three things happen in order:

1. Every source's `load()` is awaited in configuration order and the catalogs are merged — for the same key + locale, a later source overrides an earlier one.
2. A `Translator` is constructed from the merged catalog.
3. The following services are registered:

| Service name | Registration type | Resolves to |
| --- | --- | --- |
| `i18n` | `singleton` | `Translator` — one shared catalog for the whole process |
| `i18n:reload` | `singleton` | `() => Promise<void>` — reloads all sources (see Step 5) |
| `locale` | `per-request` | `string` — the locale resolved for the current request (see Step 4) |

The plugin installs with priority `40` and is named `"i18n"` by default; both are configurable. `jsonFileSource` reads JSON catalogs and any file matching the glob joins the merged catalog — split your strings into as many files as you like (one per domain is a common choice).

---

### Step 2 — Translate in a request handler

The simplest lookup resolves the singleton `Translator` and passes the locale explicitly:

```typescript
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function handler(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    res.json({ message: translator.translate("greeting", "en") });
}
```

That works, but hard-coding `"en"` serves everyone the same language. The next level is the per-request `locale` service, which resolves the caller's preferred locale (Step 4 explains the rules):

```typescript
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");

    res.json({
        locale,
        greeting: translator.translate("greeting", locale),
        farewell: translator.translate("farewell", locale),
    });
}
```

Resolving `i18n` is cheap: the translator is a singleton built once at startup, so `translate()` is a catalog lookup — no I/O and no per-request construction.

---

### Step 3 — Combine multiple sources

Real applications layer their translations: base strings shipped with the code in JSON files, and administrator-maintained overrides in a database. Add a `postgresqlSource` as the second source:

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createTranslationsPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            postgresqlSource({
                queryFn: (sql) => database.query(sql),
                tableName: "translations",
                filter: "active = true",
            }),
        ],
    });
}
```

`PostgreSQLSource` expects a table with `key`, `locale`, and `value` columns:

```sql
CREATE TABLE translations (
    key    TEXT NOT NULL,
    locale TEXT NOT NULL,
    value  TEXT NOT NULL
);
```

The merge rule is "later source wins, per key + locale, and untouched locales survive":

```typescript
import { mergeCatalogs } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

const fromFiles: TranslationCatalog = { greeting: { en: "Hello", nl: "Hallo" } };
const fromDatabase: TranslationCatalog = { greeting: { en: "Hi there" } };

const merged = mergeCatalogs([fromFiles, fromDatabase]);
console.log(merged.greeting.en); // "Hi there" — the database value wins
console.log(merged.greeting.nl); // "Hallo" — the file value survives
```

The `value` column may also hold plural forms: a JSON array of exactly two strings — for example `'["1 book","N books"]'` — is parsed into the `[singular, plural]` tuple.

---

### Step 4 — Let the client choose a locale

The `locale` service resolves each request with a fixed priority chain — the first match wins:

1. **Query parameter** — `?locale=nl`. Handy for testing and shareable links; the value is trimmed.
2. **`Accept-Language` header** — e.g. `nl, en;q=0.8`. Entries are sorted by their `q` quality, and regional codes are normalized (`en-US` becomes `en_US`).
3. **Cookie** — the previously persisted choice, named `"locale"` by default.
4. **`defaultLocale`** — the fallback from your plugin config.

The chain itself needs no configuration. What you can configure is cookie persistence — by default the resolved locale is written back to the response on every request, so a visitor's choice sticks:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export function createTranslationsPlugin(): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
        localeCookieName: "lang", // persist under "lang" instead of "locale"
    });
}
```

Set `localeCookieName: false` to disable persistence entirely — useful when privacy requirements forbid the cookie. Resolution still works; step 3 of the chain is simply skipped.

Both resolution functions are exported for custom use — middleware, tests, or your own negotiation logic:

```typescript
import { resolveLocale, parseAcceptLanguage } from "blendsdk/webafx-i18n";
import type { Request } from "express";

export function chooseLocale(req: Request): string {
    return resolveLocale(req, "en", "locale");
}

const bestMatch: string | null = parseAcceptLanguage("en-US,en;q=0.9,nl;q=0.8"); // "en_US"
const wildcardMatch: string | null = parseAcceptLanguage("*"); // null
```

`parseAcceptLanguage` returns `null` when the header contains nothing usable (for example only a wildcard), at which point resolution falls through to the cookie or the default.

---

### Step 5 — Reload translations without a restart

The `i18n:reload` service resolves to a function that re-runs every source, merges the catalogs again, and atomically swaps the translator's catalog. Trigger it from any handler — an admin endpoint, a webhook, a maintenance route:

```typescript
import type { Request, Response } from "express";

export async function reloadTranslations(req: Request, res: Response): Promise<void> {
    const reload = await req.services.get<() => Promise<void>>("i18n:reload");
    await reload();
    res.json({ reloaded: true });
}
```

If a source fails during reload, the error is logged and the previous catalog is kept — the reload function never rejects (see [Error Handling](#error-handling)).

For multi-instance deployments, set `reloadChannel` to refresh every instance at once through the pub/sub provider from `blendsdk/webafx-cache`:

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createReloadablePlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            postgresqlSource({ queryFn: (sql) => database.query(sql) }),
        ],
        reloadChannel: "i18n:reload",
    });
}
```

Distributed reload is opt-in and never blocks boot: if the pub/sub provider is not installed, the plugin logs that the channel is inactive and startup continues normally.

That completes the loop — startup loading, per-request translation, and runtime refresh. The sections below are reference material for the options and failure modes you will meet along the way.

---

## Configuration

### Plugin options (`I18nPluginConfig`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultLocale` | `string` | `"en"` | Fallback when no locale can be resolved; also the translator's default locale |
| `sources` | `TranslationSource[]` | required | Sources loaded in order; later sources override earlier ones per key + locale |
| `serviceName` | `string` | `"i18n"` | Name of the singleton `Translator` service; also the plugin name, and the reload service becomes `${serviceName}:reload` |
| `localeServiceName` | `string` | `"locale"` | Name of the per-request resolved-locale service |
| `localeCookieName` | `string \| false` | `"locale"` | Cookie used to persist the resolved locale; `false` disables persistence |
| `reloadChannel` | `string` | — | Pub/sub channel that triggers a full reload on every message |
| `pubsubServiceName` | `string` | `"pubsub"` | Container name of the pub/sub provider used by `reloadChannel` |
| `onMissingTranslation` | `(key: string, locale: string) => void` | — | Called whenever a translation key cannot be resolved |
| `priority` | `number` | `40` | Plugin installation priority — lower numbers install first |

### PostgreSQL source options (`PostgreSQLSourceConfig`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `queryFn` | `(sql: string) => Promise<Array<{ key: string; locale: string; value: string }>>` | required | Executes the generated SQL and returns rows; inject your database client here |
| `tableName` | `string` | `"translations"` | Table containing the `key`, `locale`, and `value` columns |
| `filter` | `string` | — | Extra `WHERE` clause, without the keyword; keep it static — the value is interpolated into the SQL verbatim |

### Locale cookie behavior

When persistence is enabled, the resolved locale is written to the response on every request with these options:

| Cookie option | Value | Notes |
| --- | --- | --- |
| `httpOnly` | `false` | Readable from client-side JavaScript |
| `sameSite` | `"lax"` | Sent on top-level navigations and same-site requests |
| `maxAge` | 1 year | Refreshed on every request |

### Complete configuration example

Remove `reloadChannel` and `pubsubServiceName` if you do not use `blendsdk/webafx-cache`:

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createTranslationsPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            postgresqlSource({
                queryFn: (sql) => database.query(sql),
                tableName: "translations",
                filter: "active = true",
            }),
        ],
        serviceName: "i18n",
        localeServiceName: "locale",
        localeCookieName: "locale",
        reloadChannel: "i18n:reload",
        pubsubServiceName: "pubsub",
        onMissingTranslation: (key, locale) => {
            // Forward to your logging or metrics pipeline
            console.warn(`[i18n] missing translation "${key}" for locale "${locale}"`);
        },
        priority: 40,
    });
}
```

---

## Error Handling

The package deliberately defines **no custom error classes**. Every failure surfaces as a standard `Error` — most commonly the original error thrown by a source (a failed database query, an unreadable file) — and the plugin's behavior depends on *when* it happens.

### Error behavior at a glance

| Situation | When it happens | Behavior | Recovery |
| --- | --- | --- | --- |
| A source's `load()` throws | Plugin startup | The plugin factory rejects — initialization fails, surfacing the problem immediately | Fix the source (file paths, database connectivity) and restart |
| A source's `load()` throws | Reload (`i18n:reload` or `reloadChannel`) | Logged as `I18n: reload failed, keeping previous catalog:`, followed by the error message; the previous catalog stays live; `reload()` still resolves | Check the log, fix the source, reload again |
| A translation key cannot be resolved | A `translate()` call | Your `onMissingTranslation(key, locale)` callback runs, if configured | Add the key to a source |
| The pub/sub provider is missing | Startup with `reloadChannel` configured | A log line states the service is not available and the reload channel will not be active; startup continues | Install `blendsdk/webafx-cache`, or ignore if distributed reload is not needed |

### Source loading errors at startup

Startup is where you *want* to hear about broken translation sources — failing fast beats serving untranslated pages. If any source throws during `load()`, plugin initialization fails with that error. You can also validate a source before handing it to the plugin:

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export async function loadDatabaseCatalog(database: DatabaseClient): Promise<TranslationCatalog> {
    const source = postgresqlSource({
        queryFn: (sql) => database.query(sql),
        tableName: "translations",
    });

    try {
        return await source.load();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Translation source "${source.name}" failed: ${message}`);
    }
}
```

Under the hood, `PostgreSQLSource.load()` simply rethrows whatever `queryFn` produced — a connection-refused error, an authentication failure, a missing table — so you always see the database's own message, wrapped with source context by the pattern above if you choose to add it.

### Reload failures are survivable

Reload is the safe phase: `i18n:reload` never rejects. Failures are caught inside the plugin, logged with the message `I18n: reload failed, keeping previous catalog:`, and the previously loaded catalog stays active. This means:

- A successful `await reload()` does not prove new data was loaded — if a reload matters, confirm success in your logs (`I18n: reload complete`).
- A broken backend can never take down a running application or leave it without translations.

### Missing translation keys

A missing key is not an exception — it is a signal you can observe. Provide `onMissingTranslation` to log gaps or feed a metrics pipeline:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

app.use(
    createI18nPlugin({
        defaultLocale: "en",
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
        onMissingTranslation: (key: string, locale: string) => {
            console.warn(`[i18n] missing translation "${key}" for locale "${locale}"`);
        },
    })
);
```

Keep the callback fast and never let it throw — it runs synchronously inside `translate()` and has no return value; use it for observation only, not for changing translation behavior.

### Missing pub/sub provider

Nothing to handle here. When `reloadChannel` is set but no provider is registered under `pubsubServiceName` (default `"pubsub"`), the plugin logs `not available — reload channel ... will not be active` and continues startup normally. The only consequence is that the channel is inactive: manual reloads via `i18n:reload` still work, and the startup log tells you what to install if you rely on distributed refresh.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
