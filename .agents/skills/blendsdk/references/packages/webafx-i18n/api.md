> **Package**: `blendsdk/webafx-i18n`

# webafx-i18n API Reference

This document is the complete API reference for `blendsdk/webafx-i18n` v5.54.0 — every public class, function, interface, and type exported from the package root. Symbols marked as *re-exports* are defined in the sibling packages `blendsdk/i18n` (browser-safe core) and `blendsdk/i18n-node` (Node.js-only file sources) and are documented here at the level used by this package. For a conceptual introduction, see the Overview and Core Concepts.

---

## Export Summary

| Symbol | Kind | Defined in | Description |
|--------|------|------------|-------------|
| `createI18nPlugin` | Function | `./i18n-plugin.js` | Creates the WebAFX `PluginDefinition` for i18n |
| `I18nPluginConfig` | Interface | `./types.js` | Configuration object for `createI18nPlugin` |
| `PostgreSQLSource` | Class | `./postgresql-source.js` | Translation source that reads `key`/`locale`/`value` rows through `queryFn` |
| `PostgreSQLSourceConfig` | Interface | `./postgresql-source.js` | Configuration for `PostgreSQLSource` |
| `postgresqlSource` | Function | `./postgresql-source.js` | Factory for `PostgreSQLSource` |
| `resolveLocale` | Function | `./locale-resolver.js` | Resolves a request's locale: query → `Accept-Language` → cookie → default |
| `parseAcceptLanguage` | Function | `./locale-resolver.js` | Picks the highest-quality locale from an `Accept-Language` header |
| `Translator` | Class | `blendsdk/i18n` (re-export) | Translation lookup engine registered as the `i18n` service |
| `mergeCatalogs` | Function | `blendsdk/i18n` (re-export) | Merges catalogs left to right; later entries override earlier ones |
| `TranslationCatalog` | Type | `blendsdk/i18n` (re-export) | `Record<string, TranslationEntry>` — a complete set of translations |
| `TranslationEntry` | Type | `blendsdk/i18n` (re-export) | `Record<string, TranslationValue>` — one key's translations per locale |
| `TranslationValue` | Type | `blendsdk/i18n` (re-export) | `string \| [string, string]` — plain text or a `[singular, plural]` tuple |
| `TranslationSource` | Interface | `blendsdk/i18n` (re-export) | Contract implemented by every translation backend |
| `TranslatorConfig` | Interface | `blendsdk/i18n` (re-export) | Configuration accepted by the `Translator` constructor |
| `JsonFileSource` | Class | `blendsdk/i18n-node` (re-export) | Node.js-only source loading translations from JSON files |
| `JsonFileSourceConfig` | Interface | `blendsdk/i18n-node` (re-export) | Configuration for `JsonFileSource` |
| `jsonFileSource` | Function | `blendsdk/i18n-node` (re-export) | Factory for `JsonFileSource` |
| `ContentFileSource` | Class | `blendsdk/i18n-node` (re-export) | Node.js-only source loading translations from content files |
| `ContentFileSourceConfig` | Interface | `blendsdk/i18n-node` (re-export) | Configuration for `ContentFileSource` |
| `contentFileSource` | Function | `blendsdk/i18n-node` (re-export) | Factory for `ContentFileSource` |

---

## Plugin API

`createI18nPlugin()` is the package's entry point. It returns a WebAFX `PluginDefinition` whose `factory` runs once during application startup: it loads every configured source, merges the catalogs, creates a `Translator`, and registers the plugin's services (see [Registered Services](#registered-services)).

### `createI18nPlugin`

```typescript
function createI18nPlugin(config: I18nPluginConfig): PluginDefinition;
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `I18nPluginConfig` | Yes | — | Plugin configuration; only `sources` is required |

**Returns** — a `PluginDefinition` from `blendsdk/webafx`. The definition's `name` is `config.serviceName` (default `"i18n"`), its `priority` is `config.priority` (default `40`), and its `factory` performs the startup steps below.

**Startup behavior**

1. Load every source in `config.sources`, in order, and merge their catalogs with `mergeCatalogs()` — later sources override earlier ones for the same key + locale.
2. Create a `Translator` from the merged catalog, configured with `defaultLocale` and `onMissingTranslation`.
3. Register the translator as a `singleton` service under `serviceName`.
4. Register a reload function as a `singleton` service under `${serviceName}:reload`. Invoking it reloads all sources and atomically swaps the catalog via `Translator.setCatalog()`.
5. Register a per-request locale service under `localeServiceName`. Its factory resolves the request locale with `resolveLocale()` and writes it to a cookie, unless `localeCookieName` is `false`.
6. When `reloadChannel` is set, subscribe to that channel through the pub/sub provider registered under `pubsubServiceName` — every message triggers the same reload as step 4. If the provider is unavailable, a log message is emitted and startup continues with the reload channel inactive.
7. Return a `Plugin` whose `health()` hook always resolves to `true`.

If a source fails to load at startup, the factory rejects and plugin initialization fails. During a reload, failures are logged and the previous catalog is kept (the reload call does not throw).

**Example**

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

// `app` is your WebAFX application instance
app.use(
    createI18nPlugin({
        defaultLocale: "en",
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    })
);
```

### `I18nPluginConfig`

Configuration object accepted by `createI18nPlugin()`.

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `defaultLocale` | `string` | No | `"en"` | Fallback locale when no locale can be resolved; also the translator's default locale |
| `sources` | `TranslationSource[]` | Yes | — | Sources loaded in configuration order at startup and on every reload; later sources override earlier ones for the same key + locale |
| `serviceName` | `string` | No | `"i18n"` | Name of the singleton `Translator` service (also used as the plugin `name`) |
| `localeServiceName` | `string` | No | `"locale"` | Name of the per-request resolved-locale service |
| `reloadChannel` | `string` | No | — | Pub/sub channel for distributed reload. Requires the `blendsdk/webafx-cache` pub/sub plugin; when the provider is missing, startup continues and the channel stays inactive |
| `pubsubServiceName` | `string` | No | `"pubsub"` | Container name of the pub/sub provider used when `reloadChannel` is set |
| `onMissingTranslation` | `(key: string, locale: string) => void` | No | — | Called whenever a translation key is not found; forwarded to the `Translator` |
| `localeCookieName` | `string \| false` | No | `"locale"` | Cookie used to persist the resolved locale; `false` disables persistence |
| `priority` | `number` | No | `40` | Plugin install priority; lower numbers install first |

**Example**

```typescript
import { jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { I18nPluginConfig } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createConfig(database: DatabaseClient): I18nPluginConfig {
    return {
        defaultLocale: "en",
        sources: [
            // Base strings from files, loaded first
            jsonFileSource({ paths: ["./translations/*.json"] }),
            // Database rows override the base for the same key + locale
            postgresqlSource({
                queryFn: (sql) => database.query(sql),
                filter: "active = true",
            }),
        ],
        serviceName: "i18n",
        localeServiceName: "locale",
        localeCookieName: "locale",
        onMissingTranslation: (key, locale) => {
            console.warn(`Missing translation for "${key}" (${locale})`);
        },
        priority: 40,
    };
}
```

### Registered Services

The plugin's factory registers three services in the WebAFX service container:

| Service name | Registration type | Resolves to | Description |
|--------------|-------------------|-------------|-------------|
| `"i18n"` — or `serviceName` | `singleton` | `Translator` | The translator built from the merged catalog; shared by all requests |
| `"i18n:reload"` — or `${serviceName}:reload` | `singleton` | `() => Promise<void>` | Reloads every source and atomically swaps the catalog; a failed reload is logged and keeps the previous catalog |
| `"locale"` — or `localeServiceName` | `per-request` | `string` | The locale resolved for the current request (see [Locale Resolution](#locale-resolution)) |

Resolving the per-request locale also writes the locale to a cookie — unless `localeCookieName` is `false` — with these settings:

| Cookie setting | Value |
|----------------|-------|
| Name | `localeCookieName` — default `"locale"` |
| `httpOnly` | `false` |
| `sameSite` | `"lax"` |
| `maxAge` | 1 year (refreshed on every request) |

**Example**

```typescript
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function greet(req: Request, res: Response): Promise<void> {
    // The "locale" service has already resolved (and cookie-persisted) the request locale
    const locale = await req.services.get<string>("locale");
    const translator = await req.services.get<Translator>("i18n");
    res.json({ message: translator.translate("greeting", locale) });
}

export async function reloadTranslations(req: Request, res: Response): Promise<void> {
    const reload = await req.services.get<() => Promise<void>>("i18n:reload");
    await reload(); // reloads every source; a failure keeps the previous catalog
    res.json({ reloaded: true });
}
```

### Defaults

The plugin applies these defaults when the corresponding option is omitted. They are internal defaults — the package exports no public enums or constants.

| Default | Value | Applies to |
|---------|-------|------------|
| Default locale | `"en"` | `defaultLocale` |
| Service name | `"i18n"` | `serviceName` (also the plugin `name`) |
| Locale service name | `"locale"` | `localeServiceName` |
| Pub/sub service name | `"pubsub"` | `pubsubServiceName` |
| Locale cookie name | `"locale"` | `localeCookieName` |
| Plugin priority | `40` | `priority` |

---

## Translation Sources

All translation backends implement the `TranslationSource` interface. The plugin loads them in configuration order at startup — and again on every reload — then merges the resulting catalogs with `mergeCatalogs()`: for the same key + locale, later sources override earlier ones. Built-in sources are `PostgreSQLSource` (defined in this package) and the Node.js file sources (`JsonFileSource`, `ContentFileSource`), re-exported from `blendsdk/i18n-node`.

### `TranslationSource`

*Re-exported from `blendsdk/i18n`.*

| Member | Type | Description |
|--------|------|-------------|
| `name` | `readonly string` | Source identifier reported in log output when the source is loaded |
| `load` | `() => Promise<TranslationCatalog>` | Produces the source's complete catalog; called at startup and on every reload |

**Example**

```typescript
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";

export class InMemorySource implements TranslationSource {
    readonly name = "InMemorySource";

    constructor(private readonly catalog: TranslationCatalog) {}

    async load(): Promise<TranslationCatalog> {
        return this.catalog;
    }
}
```

### `PostgreSQLSource`

```typescript
class PostgreSQLSource implements TranslationSource
```

Database-backed translation source. It reads a table with `key`, `locale`, and `value` columns through an injected `queryFn` callback, so it stays decoupled from any concrete PostgreSQL client (including `blendsdk/postgresql`).

**Constructor**

```typescript
constructor(config: PostgreSQLSourceConfig)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config` | `PostgreSQLSourceConfig` | Yes | Query function, table name, and optional `WHERE` filter |

**Properties**

| Property | Type | Description |
|----------|------|-------------|
| `name` | `readonly string` | Always `"PostgreSQLSource"` — reported in log output as `I18n: loading from PostgreSQLSource...` |
| `config` | `protected PostgreSQLSourceConfig` | The configuration supplied to the constructor |

**Methods**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `load` | `load(): Promise<TranslationCatalog>` | `Promise<TranslationCatalog>` | Builds the query, executes it via `queryFn`, and normalizes the rows into a catalog. Rejects when `queryFn` rejects |
| `parseValue` | `protected parseValue(value: string): string \| [string, string]` | `string \| [string, string]` | Converts a stored `value` into a `TranslationValue`; `protected`, so subclasses can support additional encodings |

**Query construction**

```sql
-- without filter
SELECT key, locale, value FROM translations ORDER BY key, locale

-- with filter: "active = true"
SELECT key, locale, value FROM translations WHERE active = true ORDER BY key, locale
```

Each row is mapped to `catalog[row.key][row.locale] = parseValue(row.value)`. The `tableName` and `filter` values are interpolated into the statement verbatim — only ever pass static, trusted values.

**Value parsing** (`parseValue`):

| Stored `value` | Parsed result |
|----------------|---------------|
| `Hello` | `"Hello"` — plain string |
| `["1 book","N books"]` | `["1 book", "N books"]` — JSON array of exactly two strings becomes a plural tuple |
| `["only one"]` | Kept as a plain string — the array does not have exactly two elements |
| `[not valid json` | Kept as a plain string — not valid JSON |

**Example**

```typescript
import { PostgreSQLSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export async function loadFromDatabase(database: DatabaseClient): Promise<TranslationCatalog> {
    const source = new PostgreSQLSource({
        queryFn: (sql) => database.query(sql),
        tableName: "translations",
        filter: "active = true",
    });

    try {
        return await source.load();
    } catch (error) {
        throw new Error(
            `Failed to load translations from PostgreSQL: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}
```

### `PostgreSQLSourceConfig`

Configuration for [`PostgreSQLSource`](#postgresqlsource).

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `queryFn` | `(sql: string) => Promise<Array<{ key: string; locale: string; value: string }>>` | Yes | — | Executes the generated SQL and resolves to the translation rows |
| `tableName` | `string` | No | `"translations"` | Table containing the `key`, `locale`, and `value` columns |
| `filter` | `string` | No | — | Optional `WHERE` clause (without the `WHERE` keyword), interpolated into the query verbatim |

Keep `tableName` and `filter` static and trusted — they are concatenated directly into the SQL string, so never build them from user input.

**Example**

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";
import type { PostgreSQLSource } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createDatabaseSource(database: DatabaseClient): PostgreSQLSource {
    return postgresqlSource({
        queryFn: (sql) => database.query(sql),
        tableName: "translations",
        filter: "active = true AND app = 'myapp'",
    });
}
```

### `postgresqlSource`

```typescript
function postgresqlSource(config: PostgreSQLSourceConfig): PostgreSQLSource;
```

Convenience factory — equivalent to `new PostgreSQLSource(config)`.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `PostgreSQLSourceConfig` | Yes | — | Same configuration as the `PostgreSQLSource` constructor |

**Returns** — a new `PostgreSQLSource` instance.

**Example**

```typescript
import { createI18nPlugin, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createDatabaseBackedPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            postgresqlSource({
                queryFn: (sql) => database.query(sql),
                tableName: "translations",
            }),
        ],
    });
}
```

---

## File Sources

`JsonFileSource` and `ContentFileSource` are Node.js-only translation sources from `blendsdk/i18n-node`, re-exported through this package so plugin configurations need a single import path. They read from the filesystem on every `load()` call and participate in the normal source merge order. Use them in the Node.js server (Node.js ≥ 22) only — not in browser bundles.

### `JsonFileSource`

```typescript
class JsonFileSource implements TranslationSource
```

Loads translations from JSON files matched by path patterns.

**Constructor**

```typescript
constructor(config: JsonFileSourceConfig)
```

**Members**

| Member | Type | Description |
|--------|------|-------------|
| `name` | `readonly string` | Source identifier used in log output |
| `load` | `() => Promise<TranslationCatalog>` | Reads and parses the configured JSON files into a catalog |

**Example**

```typescript
import { JsonFileSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

export async function loadFileCatalog(): Promise<TranslationCatalog> {
    const source = new JsonFileSource({ paths: ["./translations/*.json"] });
    return source.load();
}
```

### `JsonFileSourceConfig`

| Property | Type | Description |
|----------|------|-------------|
| `paths` | `string[]` | Path patterns of the JSON translation files to load, e.g. `["./translations/*.json"]` |

`JsonFileSourceConfig` is defined in `blendsdk/i18n-node`; the full option set is documented with that package.

### `jsonFileSource`

```typescript
function jsonFileSource(config: JsonFileSourceConfig): JsonFileSource;
```

Factory for `JsonFileSource`.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `JsonFileSourceConfig` | Yes | — | File path patterns and related options |

**Returns** — a new `JsonFileSource` instance.

**Example**

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export function createFileBasedPlugin(): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    });
}
```

### `ContentFileSource`

```typescript
class ContentFileSource implements TranslationSource
```

Node.js-only translation source that loads translations from content files. It fulfills the same `TranslationSource` contract as every other source and participates in the standard merge order.

**Constructor**

```typescript
constructor(config: ContentFileSourceConfig)
```

**Members**

| Member | Type | Description |
|--------|------|-------------|
| `name` | `readonly string` | Source identifier used in log output |
| `load` | `() => Promise<TranslationCatalog>` | Loads the configured content files into a catalog |

**Example**

```typescript
import { ContentFileSource } from "blendsdk/webafx-i18n";
import type { ContentFileSourceConfig, TranslationCatalog } from "blendsdk/webafx-i18n";

export async function loadContentCatalog(
    config: ContentFileSourceConfig
): Promise<TranslationCatalog> {
    const source = new ContentFileSource(config);
    return source.load();
}
```

### `ContentFileSourceConfig`

`ContentFileSourceConfig` is defined in `blendsdk/i18n-node` and re-exported here. See the `blendsdk/i18n` API reference for the complete option set.

### `contentFileSource`

```typescript
function contentFileSource(config: ContentFileSourceConfig): ContentFileSource;
```

Factory for `ContentFileSource`.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `ContentFileSourceConfig` | Yes | — | Content file source options (defined in `blendsdk/i18n-node`) |

**Returns** — a new `ContentFileSource` instance.

**Example**

```typescript
import { contentFileSource } from "blendsdk/webafx-i18n";
import type { ContentFileSource, ContentFileSourceConfig } from "blendsdk/webafx-i18n";

export function createContentSource(config: ContentFileSourceConfig): ContentFileSource {
    return contentFileSource(config);
}
```

---

## Locale Resolution

The locale-resolution helpers are exported for testing and custom use — the plugin uses them internally for its per-request `locale` service and for cookie persistence.

### `resolveLocale`

```typescript
function resolveLocale(req: Request, defaultLocale: string, cookieName: string | false): string;
```

`Request` is the Express request type (`import type { Request } from "express"`); only `query`, `headers`, and `cookies` are read.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `req` | `Request` | Yes | — | The incoming request |
| `defaultLocale` | `string` | Yes | — | Returned when no other source supplies a locale |
| `cookieName` | `string \| false` | Yes | — | Cookie to read the locale from; `false` skips the cookie step entirely |

**Returns** — the resolved locale as a `string`.

**Resolution order** (first match wins):

1. **Query parameter** — `?locale=nl`; the value must be a non-empty string and is returned trimmed.
2. **`Accept-Language` header** — delegated to [`parseAcceptLanguage()`](#parseacceptlanguage); falls through when it returns `null`.
3. **Cookie** — `req.cookies[cookieName]`, returned verbatim; skipped when `cookieName` is `false`.
4. **Default** — the `defaultLocale` argument.

**Example**

```typescript
import { resolveLocale } from "blendsdk/webafx-i18n";
import type { Request } from "express";

// Same priority chain the plugin's per-request "locale" service applies
export function localeFor(req: Request): string {
    return resolveLocale(req, "en", "locale");
}

// Skip the cookie step entirely
export function localeWithoutCookies(req: Request): string {
    return resolveLocale(req, "en", false);
}
```

### `parseAcceptLanguage`

```typescript
function parseAcceptLanguage(header: string): string | null;
```

Parses an `Accept-Language` header and returns the highest-priority locale.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `header` | `string` | Yes | — | Raw `Accept-Language` header value, e.g. `"en-US,en;q=0.9,nl;q=0.8"` |

**Returns** — the best locale, or `null` when no locale can be determined.

**Parsing rules**

- Entries are split on commas; each entry is `locale` or `locale;q=<quality>`, where the quality defaults to `1.0`.
- Entries that are the wildcard (`*`), empty, or have a quality of `0` are discarded.
- Remaining entries are sorted by quality descending; entries with equal quality keep their order from the header.
- The winning locale is returned with its region separator normalized: `en-US` → `en_US`.
- When no entry remains, the result is `null`.

**Input → output examples**

| Header | Result |
|--------|--------|
| `"nl"` | `"nl"` |
| `"nl, en;q=0.8"` | `"nl"` |
| `"en;q=0.8, nl;q=0.9, de;q=0.7"` | `"nl"` |
| `"en-US,en;q=0.9"` | `"en_US"` |
| `"nl;q=0, en"` | `"en"` |
| `"*"` | `null` |
| `""` | `null` |

**Example**

```typescript
import { parseAcceptLanguage } from "blendsdk/webafx-i18n";

const best = parseAcceptLanguage("en-US,en;q=0.9,nl;q=0.8");
console.log(best); // "en_US"

const wildcard = parseAcceptLanguage("*");
console.log(wildcard); // null
```

---

## Core Re-exports from `blendsdk/i18n`

The browser-safe translation core is re-exported through this package so a plugin configuration needs only a single import. The symbols below are defined in `blendsdk/i18n`; this section documents the members used by `blendsdk/webafx-i18n`.

### `Translator`

```typescript
class Translator
```

The translation lookup engine. The plugin creates one instance from the merged catalog and registers it as the `singleton` service under `serviceName` (default `"i18n"`); all requests share it.

**Constructor**

```typescript
constructor(config: TranslatorConfig)
```

**Methods**

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `translate` | `translate(key: string, locale: string): string` | `string` | Returns the translation for `key` in `locale`. When the key cannot be resolved, the configured `onMissingTranslation` callback is invoked |
| `setCatalog` | `setCatalog(catalog: TranslationCatalog): void` | `void` | Replaces the in-memory catalog; used by the reload path, so subsequent lookups immediately see the new data |

**Example**

```typescript
import { Translator, mergeCatalogs } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    bookCount: { en: ["1 book", "N books"] },
};

const translator = new Translator({
    defaultLocale: "en",
    catalog,
    onMissingTranslation: (key: string, locale: string) => {
        console.warn(`Missing translation: ${key} (${locale})`);
    },
});

console.log(translator.translate("greeting", "nl")); // "Hallo"

// Swap the catalog — the same translator instance keeps serving lookups
translator.setCatalog(mergeCatalogs([catalog, { greeting: { en: "Hi there" } }]));
console.log(translator.translate("greeting", "en")); // "Hi there"
```

### `TranslatorConfig`

Configuration accepted by the `Translator` constructor. The plugin builds it from the plugin configuration:

| Property | Type | Description |
|----------|------|-------------|
| `defaultLocale` | `string` | Default locale for the translator; the plugin passes `I18nPluginConfig.defaultLocale` (`"en"` when unset) |
| `catalog` | `TranslationCatalog` | The catalog the translator serves translations from — the merged result of all sources |
| `onMissingTranslation` | `(key: string, locale: string) => void` | Optional callback invoked when a key is not found; forwarded from `I18nPluginConfig.onMissingTranslation` |

### `mergeCatalogs`

```typescript
function mergeCatalogs(catalogs: TranslationCatalog[]): TranslationCatalog;
```

Merges catalogs left to right. Merge rules:

- The result contains the union of all keys.
- For a given key + locale, the last catalog that defines it wins.
- Locales of a key that a later catalog does not redefine are preserved.

The plugin passes the loaded source catalogs in configuration order — which is why a setup of "files first, database second" gives database rows precedence.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `catalogs` | `TranslationCatalog[]` | Yes | — | Catalogs to merge, applied left to right |

**Returns** — `TranslationCatalog`, a new merged catalog.

**Example**

```typescript
import { mergeCatalogs } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

const base: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
};

const overrides: TranslationCatalog = {
    greeting: { en: "Hi there" },
};

const merged = mergeCatalogs([base, overrides]);

console.log(merged.greeting.en); // "Hi there" — later catalog wins per key + locale
console.log(merged.greeting.nl); // "Hallo" — not redefined, so preserved
```

### Translation Types

All translation data in the package is expressed through three re-exported types that form a key → locale → value map. They are defined in `blendsdk/i18n`; structurally:

```typescript
type TranslationValue = string | [string, string];
type TranslationEntry = Record<string, TranslationValue>;
type TranslationCatalog = Record<string, TranslationEntry>;
```

| Type | Description |
|------|-------------|
| `TranslationValue` | A plain string, or a `[singular, plural]` tuple for pluralized entries |
| `TranslationEntry` | Every translation of one key, keyed by locale |
| `TranslationCatalog` | The complete translation data: translation key → `TranslationEntry` |

**Example**

```typescript
import type { TranslationCatalog, TranslationValue } from "blendsdk/webafx-i18n";

const plural: TranslationValue = ["1 book", "N books"];

export const catalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    bookCount: { en: plural, nl: ["1 boek", "N boeken"] },
};
```

---

## See Also

- Overview — what the package is, key features, architecture, and dependencies
- Core Concepts — deep dive into the plugin, sources, merging, locale resolution, and reload
- Basic Usage — step-by-step setup guide

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
