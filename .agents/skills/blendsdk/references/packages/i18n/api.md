> **Package**: `blendsdk/i18n`

# i18n API Reference

This document is the complete API reference for `blendsdk/i18n` v5.54.0. It documents every public export from both entry points — the browser-safe core (`blendsdk/i18n`) and the Node.js entry (`blendsdk/i18n-node`) — including classes, methods, functions, configuration interfaces, and core types. All signatures match the shipped source code. For conceptual guides, see Overview and Core Concepts.

---

## Module Exports

### Core Entry Point — `blendsdk/i18n`

Browser-safe: this module contains no `node:*` imports and bundles cleanly with Webpack, Vite, and esbuild.

| Export | Kind | Description |
|--------|------|-------------|
| `Translator` | Class | Core translation engine: key lookup, locale fallback, plural selection, `${...}` interpolation |
| `mergeCatalogs` | Function | Merges `TranslationCatalog` objects in priority order (later catalogs win per key + locale) |
| `TranslationValue` | Type | `string \| [singular: string, plural: string]` — one translated value |
| `TranslationEntry` | Type | `Record<string, TranslationValue>` — one key mapped to its per-locale values |
| `TranslationCatalog` | Type | `Record<string, TranslationEntry>` — the complete catalog of all keys |
| `TranslatorConfig` | Interface | Construction options accepted by `new Translator(...)` |
| `LocaleParts` | Interface | Parsed locale components: `{ full, language, region? }` |
| `TranslationSource` | Interface | The contract every translation backend implements (`name`, `load()`) |

### Node.js Entry Point — `blendsdk/i18n-node`

Re-exports **every** symbol from the core entry point, plus the file-based sources (which import `node:fs/promises` and `node:path` — Node.js only):

| Export | Kind | Description |
|--------|------|-------------|
| `JsonFileSource` | Class | Loads JSON translation files (multi-locale and single-locale formats, auto-detected) |
| `JsonFileSourceConfig` | Interface | `{ paths: string[] }` — files and glob patterns for `JsonFileSource` |
| `jsonFileSource` | Function | Factory returning a pre-configured `JsonFileSource` |
| `ContentFileSource` | Class | Loads one-file-per-key-per-locale content using `<locale>.<key>.<ext>` filenames |
| `ContentFileSourceConfig` | Interface | `{ paths: string[]; extensions?: string[] }` for `ContentFileSource` |
| `contentFileSource` | Function | Factory returning a pre-configured `ContentFileSource` |

Import surface of both entry points:

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import { JsonFileSource, ContentFileSource } from "blendsdk/i18n-node";
```

> `JsonFileSource`, `ContentFileSource`, and their factories and config interfaces are **not** exported from the browser-safe core. In browsers, supply catalogs inline or implement a custom `TranslationSource`.

---

## Translator

`class Translator` — the core translation engine. Runtime-agnostic: it uses no Node.js or browser-specific APIs, so the same instance logic runs in servers and browser bundles. The catalog is held by reference and treated as immutable; use `setCatalog()` for atomic replacement (e.g., on reload).

### Constructor

```typescript
constructor(config?: TranslatorConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `TranslatorConfig` | No | `undefined` — applied defaults: `defaultLocale: "en"`, `catalog: {}`, no missing-translation callback | Construction options; every property of `TranslatorConfig` is optional. |

### Properties

All properties are `protected` — they are implementation state exposed to subclasses, not part of the day-to-day API.

| Property | Type | Description |
|----------|------|-------------|
| `defaultLocale` (protected) | `string` | Locale used when `translate()` or `hasKey()` is called without one. Set from `TranslatorConfig.defaultLocale`; defaults to `"en"`. |
| `catalog` (protected) | `TranslationCatalog` | The current catalog, held by reference. Every lookup reads it at call time; `setCatalog()` replaces it atomically. |
| `localeCache` (protected) | `Map<string, LocaleParts>` | Parsed locale cache keyed by the raw input string — makes repeated locale parsing O(1). Cleared by `setCatalog()`. |
| `onMissingTranslation` (protected) | `((key: string, locale: string) => void) \| undefined` | Optional callback from `TranslatorConfig`; invoked whenever a lookup cannot be resolved. |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `translate` | `(key: string, locale?: string, params?: Record<string, unknown>) => string` | `string` | Resolves a key with locale fallback, plural selection, and `${...}` interpolation. Returns the key itself when it cannot be resolved. |
| `getTranslationsForLocale` | `(locale: string) => Record<string, TranslationValue>` | `Record<string, TranslationValue>` | Flat `{ key: value }` map for one locale; fallback applied per key; plural tuples returned intact; unresolvable keys omitted. |
| `hasKey` | `(key: string, locale?: string) => boolean` | `boolean` | Key-existence check; when `locale` is provided, includes fallback resolution. |
| `setCatalog` | `(catalog: TranslationCatalog) => void` | `void` | Atomically replaces the catalog by reference and clears the locale cache. |
| `getCatalog` | `() => TranslationCatalog` | `TranslationCatalog` | Returns the current catalog reference (not a copy). |
| `getDefaultLocale` | `() => string` | `string` | Returns the configured default locale. |

#### translate(key, locale?, params?)

```typescript
translate(key: string, locale?: string, params?: Record<string, unknown>): string
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | Yes | — | Translation key, e.g. `"greeting"` or `"auth.login"`. |
| `locale` | `string` | No | The translator's `defaultLocale` (`"en"` unless configured) | Target locale, e.g. `"en_GB"`, `"en-GB"`, `"en_GB.UTF-8"`, `"nl"`. Normalized before lookup; parsing is cached. |
| `params` | `Record<string, unknown>` | No | `undefined` | Values for `${...}` placeholders. A numeric `count` property additionally drives plural selection. |

**Returns:** `string` — the fully resolved translation. Returns `key` verbatim when the key or a value for the locale cannot be found.

Resolution pipeline:

1. **Locale resolution** — `locale ?? defaultLocale`, then parsed and cached via `parseLocale()`.
2. **Key lookup** — `catalog[key]`. If no entry exists, `onMissingTranslation?.(key, resolvedLocale)` is invoked and `key` is returned.
3. **Value resolution** — exact locale match first (`entry[localeParts.full]`), then language fallback (`entry[localeParts.language]`) when the requested locale includes a region. If neither matches, the callback fires and `key` is returned.
4. **Plural selection** — when the value is a `[singular, plural]` tuple, a numeric (non-`NaN`) `params.count` selects the form: `1` → singular (index `0`), any other number → plural (index `1`). Without a valid numeric count, the singular form is used.
5. **Interpolation** — the chosen template is passed through `formatString` from `blendsdk/stdlib`, replacing `${...}` placeholders with `params` values. A non-numeric `count` (e.g. `"many"`) still interpolates into `${count}` even though selection defaulted to singular (`"many book"`).

Missing-translation outcomes:

| Situation | `translate()` returns | `onMissingTranslation` invoked |
|-----------|----------------------|--------------------------------|
| Key resolves for the locale | Interpolated translation | No |
| Key absent from the catalog | The key itself | Yes — `(key, resolvedLocale)` |
| Key present, no value via fallback | The key itself | Yes — `(key, resolvedLocale)` |

#### getTranslationsForLocale(locale)

```typescript
getTranslationsForLocale(locale: string): Record<string, TranslationValue>
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `locale` | `string` | Yes | — | Target locale, normalized the same way as in `translate()`. |

**Returns:** `Record<string, TranslationValue>` — one entry per key that resolves for the locale. Keys with no resolvable value are omitted entirely. Plural values are returned **as-is** (the tuple form), because clients rendering dynamic counts need both forms for count-based selection at render time.

#### hasKey(key, locale?)

```typescript
hasKey(key: string, locale?: string): boolean
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `key` | `string` | Yes | — | Translation key to check. |
| `locale` | `string` | No | `undefined` | When omitted, only key existence is checked. When provided, the check includes locale resolution through the exact → language fallback chain. |

**Returns:** `boolean` — `true` if the key exists (and, when `locale` is given, a value resolves for it).

#### setCatalog(catalog)

```typescript
setCatalog(catalog: TranslationCatalog): void
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `catalog` | `TranslationCatalog` | Yes | — | The replacement catalog. Swapped by reference; the previous catalog is dereferenced and the locale-parse cache is cleared. |

**Returns:** `void`. Calls that begin before the swap resolve against the previous catalog; calls that begin after it resolve against the new one. Build and validate the replacement catalog fully before calling this method.

#### getCatalog()

```typescript
getCatalog(): TranslationCatalog
```

**Returns:** `TranslationCatalog` — the live catalog reference, **not** a copy. Primarily useful for testing and for layering reload data (e.g., via `mergeCatalogs`). Treat the returned object as read-only and swap replacements through `setCatalog()`.

#### getDefaultLocale()

```typescript
getDefaultLocale(): string
```

**Returns:** `string` — the configured default locale (`"en"` unless `TranslatorConfig.defaultLocale` was set).

### Protected Members

These members are `protected` — extension points for subclasses, not part of the day-to-day API.

#### parseLocale (protected)

```typescript
protected parseLocale(locale: string): LocaleParts
```

Parses and caches a raw locale string. Normalization order: everything after the first `.` is stripped (POSIX encoding, e.g. `.UTF-8`), the first `-` is replaced with `_`, and the result is split on `_` into `language` and optional `region`. The raw input string is the cache key, so repeated parses are O(1).

#### resolveValue (protected)

```typescript
protected resolveValue(entry: TranslationEntry, localeParts: LocaleParts): TranslationValue | undefined
```

Applies the fallback chain to one entry:

1. Exact match: `entry[localeParts.full]` (e.g. `entry["en_GB"]`).
2. Language fallback: `entry[localeParts.language]` — attempted **only** when the requested locale has a region. A request for `"en"` never upgrades to `"en_GB"`; a request for `"en_GB"` falls back to `"en"`.
3. `undefined` when neither matches.

#### selectPlural (protected)

```typescript
protected selectPlural(value: TranslationValue, params?: Record<string, unknown>): string
```

| Input | Result |
|-------|--------|
| `value` is a plain string | Returned unchanged |
| Tuple + `params.count === 1` | Singular form (index `0`) |
| Tuple + any other numeric `count` | Plural form (index `1`) |
| Tuple + missing, non-numeric, or `NaN` count | Singular form (index `0`) |

### Complete Example

```typescript
import { Translator } from "blendsdk/i18n";

const missing: string[] = [];

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: {
            en: "Hello ${name}",
            nl: "Hallo ${name}",
            en_GB: "Hello ${name}, mate",
        },
        book: {
            en: ["${count} book", "${count} books"],
            nl: ["${count} boek", "${count} boeken"],
        },
    },
    onMissingTranslation: (key: string, locale: string): void => {
        missing.push(`${locale}:${key}`);
    },
});

console.log(translator.translate("greeting", "en_GB", { name: "Alice" }));
// "Hello Alice, mate" — exact locale match

console.log(translator.translate("greeting", "en-GB.UTF-8", { name: "Alice" }));
// "Hello Alice, mate" — dash normalized, encoding stripped

console.log(translator.translate("book", "nl", { count: 3 }));
// "3 boeken" — plural form selected and interpolated

console.log(translator.translate("farewell", "en"));
// "farewell" — missing key returned as-is

console.log(translator.hasKey("book", "nl"));
// true

console.log(translator.getTranslationsForLocale("en"));
// { greeting: "Hello ${name}", book: ["${count} book", "${count} books"] }

console.log(missing);
// ["en:farewell"]
```

---

## mergeCatalogs

```typescript
function mergeCatalogs(catalogs: TranslationCatalog[]): TranslationCatalog
```

Merges multiple `TranslationCatalog` objects into one. Catalogs are applied in array order; for duplicate key + locale pairs the later catalog wins, which enables layered loading where database overrides sit on top of file-based defaults.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `catalogs` | `TranslationCatalog[]` | Yes | — | Catalogs in priority order. For duplicate key + locale pairs, the catalog appearing later in the array wins. |

**Returns:** `TranslationCatalog` — a new catalog containing the union of all keys. The inputs are **not** mutated; result entry objects are fresh copies, not shared references with the inputs.

Behavior:

- The first catalog that contains a key provides its entry (shallow-copied into the result).
- Later catalogs merge locale values into the existing entry (assign semantics): matching locales are overridden, while locales the later catalog does not define are preserved.
- The function is synchronous and part of the browser-safe core, so it runs in any runtime.

```typescript
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const defaults: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
};

const overrides: TranslationCatalog = {
    greeting: { en: "Hi" },
    "cart.empty": { en: "Your cart is empty", nl: "Je winkelwagen is leeg" },
};

const merged: TranslationCatalog = mergeCatalogs([defaults, overrides]);

console.log(merged["greeting"]);
// { en: "Hi", nl: "Hallo" } — "en" overridden, "nl" preserved

console.log(merged["farewell"]);
// { en: "Goodbye", nl: "Tot ziens" } — untouched

console.log(merged["cart.empty"]);
// { en: "Your cart is empty", nl: "Je winkelwagen is leeg" } — added
```

---

## JsonFileSource

> **Entry point**: `blendsdk/i18n-node` (Node.js only — imports `node:fs/promises` and `node:path`).

`class JsonFileSource implements TranslationSource` — loads translation catalogs from JSON files on disk. Two file formats are supported and auto-detected per file:

- **Multi-locale** — `{ key: { locale: value } }`: all locales in one file.
- **Single-locale** — `{ key: value }`: one file per locale, with the locale derived from the filename.

### JsonFileSourceConfig

| Property | Type | Description |
|----------|------|-------------|
| `paths` | `string[]` | File paths and/or glob patterns. Plain paths are resolved and read directly — a missing file makes `load()` reject. Glob patterns use `*` and `?` in the filename segment of a single directory (non-recursive); a glob whose directory does not exist yields zero files without error. |

**Multi-locale format** — each key maps to a locale → value object:

```json
{
    "greeting": { "en": "Hello ${name}", "nl": "Hallo ${name}" },
    "book": {
        "en": ["${count} book", "${count} books"],
        "nl": ["${count} boek", "${count} boeken"]
    }
}
```

**Single-locale format** — flat key → value; the locale comes from the filename (e.g. `translations/en.json` → `"en"`):

```json
{
    "greeting": "Hello ${name}",
    "book": ["${count} book", "${count} books"]
}
```

### Constructor

```typescript
constructor(config: JsonFileSourceConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `JsonFileSourceConfig` | Yes | — | The file paths and glob patterns to load from. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `readonly string` | Always `"JsonFileSource"`. |
| `config` (protected) | `JsonFileSourceConfig` | The configuration object passed to the constructor. |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `load` | `() => Promise<TranslationCatalog>` | `Promise<TranslationCatalog>` | Resolves paths, reads and parses each JSON file, auto-detects its format, normalizes values, and merges everything into one catalog. |

#### load()

Loading pipeline:

1. **Resolve paths** — plain paths are resolved to absolute paths and read directly; glob patterns (`*` or `?` in the filename part) are expanded against the filenames of a single directory (non-recursive).
2. **Sort** — all resolved paths are sorted alphabetically, regardless of the order they appear in `paths`, so identical configuration always produces an identical catalog. When duplicate key + locale pairs occur, the file that sorts later wins.
3. **Read and parse** — each file is read as UTF-8 and parsed with `JSON.parse`. Invalid JSON rejects with `Failed to parse JSON file "<path>": <reason>`.
4. **Detect format** — per file, from the first value in the parsed object.
5. **Normalize values** — every raw JSON value becomes a `TranslationValue`.
6. **Merge** — all entries are merged into one `TranslationCatalog`; later files override earlier files per key + locale.

Format detection:

| First value in file | Detected format | Locale source |
|---------------------|-----------------|---------------|
| Plain object (`{ ... }`) | Multi-locale | Locale keys inside the file |
| String or array | Single-locale | Last dot-segment of the filename before `.json` (`en.json` → `"en"`, `nl_NL.json` → `"nl_NL"`, `strings.nl.json` → `"nl"`) |
| None (empty object) | Treated as multi-locale | None — produces no entries |
| Anything else (number, boolean, `null`) | Falls back to single-locale | Filename, as above |

Value normalization:

| Raw JSON value | Normalized `TranslationValue` |
|----------------|-------------------------------|
| String | The string, as-is (may contain `${...}` placeholders) |
| Array of exactly two strings | `[singular, plural]` tuple (index `0` singular, index `1` plural) |
| Any other value (numbers, booleans, objects, other arrays) | `String(value)` |

**Throws:** `Error` when a plain-path file cannot be read; `Error` with the message `Failed to parse JSON file "<path>": <reason>` on invalid JSON; `Error` when a single-locale filename yields no locale (empty locale segment).

### Example

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: ["./translations/*.json"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(source.name); // "JsonFileSource"
console.log(translator.translate("greeting", "nl", { name: "Alice" }));
// "Hallo Alice"
```

---

## ContentFileSource

> **Entry point**: `blendsdk/i18n-node` (Node.js only — imports `node:fs/promises` and `node:path`).

`class ContentFileSource implements TranslationSource` — loads rich content where each file represents one translation key for one locale, using the filename convention `<locale>.<key>.<ext>` (e.g. `nl.signup-email.html` → locale `"nl"`, key `"signup-email"`). Ideal for HTML email templates, Markdown pages, and plain-text legal copy. File content is read as UTF-8 and stored as-is — no transformation.

### ContentFileSourceConfig

| Property | Type | Description |
|----------|------|-------------|
| `paths` | `string[]` | Directory paths and/or glob patterns to scan. Non-glob entries are listed as directories (non-recursive); entries containing `*` or `?` are glob-expanded against filenames in a single directory. Missing directories yield zero files without error. Pass a directory or a glob (`./content/emails`, `./content/*.html`) — a plain file path is treated as a directory and yields no matches. |
| `extensions` | `string[]` | Optional. File extensions to include, with or without the leading dot and case-insensitive (`".html"`, `"txt"`, `".HTML"` are all valid). Defaults to `[".html", ".md", ".txt"]`. A configured list **replaces** the defaults entirely. |

### Constructor

```typescript
constructor(config: ContentFileSourceConfig)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `ContentFileSourceConfig` | Yes | — | Directory paths, glob patterns, and optional extension filter. Extensions are normalized here: a leading dot is added when missing and entries are lowercased. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `readonly string` | Always `"ContentFileSource"`. |
| `config` (protected) | `ContentFileSourceConfig` | The configuration object passed to the constructor. |
| `extensions` (protected) | `string[]` | Normalized (leading dot, lowercase) extension list used for filtering. Defaults to `[".html", ".md", ".txt"]`. |

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `load` | `() => Promise<TranslationCatalog>` | `Promise<TranslationCatalog>` | Resolves paths, parses `<locale>.<key>.<ext>` filenames, filters by extension, reads content as UTF-8, and assembles the catalog. |
| `resolveAllPaths` (protected) | `() => Promise<string[]>` | `Promise<string[]>` | Expands configured directories and globs to a sorted list of absolute file paths. |

#### load()

Loading pipeline:

1. **Resolve paths** — see `resolveAllPaths` below. Non-glob entries are directory listings; glob entries are expanded; missing directories contribute zero files.
2. **Sort** — resolved file paths are sorted alphabetically (regardless of the order they appear in `paths`), so identical configuration produces an identical catalog. On duplicate key + locale pairs, the file that sorts later wins.
3. **Parse filenames** — `<locale>.<key>.<ext>` requires at least three dot-separated segments: the first segment is the locale, the last is the extension, and the middle segments are joined with `.` to form the key (enabling dot-notation keys such as `auth.welcome`). Files with fewer than three segments, an empty locale, or an empty key are skipped silently.
4. **Filter by extension** — only files whose lowercased extension is in `extensions` are read; all others are skipped silently.
5. **Read content** — each surviving file is read as UTF-8 and stored as-is: whitespace, markup, and `${...}` placeholders all survive, so `Translator.translate()` can interpolate dynamic values into the content at render time.
6. **Assemble** — content is assigned as `catalog[key][locale]`.

Filename convention reference:

| Filename | Locale | Key | Outcome |
|----------|--------|-----|---------|
| `en.signup-email.html` | `en` | `signup-email` | Loaded |
| `nl.signup-email.html` | `nl` | `signup-email` | Loaded |
| `en.auth.welcome.md` | `en` | `auth.welcome` | Loaded — middle segments join with `.` |
| `readme.txt` | — | — | Skipped — fewer than 3 dot-segments |
| `.hidden-file.html` | — | — | Skipped — empty locale segment |
| `en.notes.xml` | — | — | Skipped — extension not in the configured list |

**Throws:** `Error` when a matched file cannot be read (e.g. permission denied).

#### resolveAllPaths() (protected)

```typescript
protected async resolveAllPaths(): Promise<string[]>
```

- Entries containing `*` or `?` are glob-expanded: the containing directory is listed and filenames are matched (`*` matches any run of characters, `?` matches exactly one character; no recursive `**`). A missing directory yields zero matches.
- All other entries are treated as directories and listed non-recursively. A missing or unreadable directory yields an empty list.
- All results are concatenated and sorted alphabetically for deterministic catalog output.

### Example

Given a project with these files:

```text
content/emails/
├── en.signup-email.html
└── nl.signup-email.html
```

`content/emails/en.signup-email.html` contains `<p>Welcome, ${name}!</p>` and `content/emails/nl.signup-email.html` contains `<p>Welkom, ${name}!</p>`:

```typescript
import { Translator, ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({
    paths: ["./content/emails"],
    extensions: [".html"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(source.name); // "ContentFileSource"

console.log(translator.translate("signup-email", "en", { name: "Alice" }));
// "<p>Welcome, Alice!</p>"

console.log(translator.translate("signup-email", "nl", { name: "Alice" }));
// "<p>Welkom, Alice!</p>"
```

---

## Factory Functions

### jsonFileSource()

```typescript
function jsonFileSource(config: JsonFileSourceConfig): JsonFileSource
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `JsonFileSourceConfig` | Yes | — | The same configuration accepted by the `JsonFileSource` constructor. |

**Returns:** `JsonFileSource` — a new instance, equivalent to `new JsonFileSource(config)`. Handy for declarative configuration (e.g. building a `sources: [...]` array).

```typescript
import { Translator, jsonFileSource } from "blendsdk/i18n-node";

const translator = new Translator({
    defaultLocale: "en",
    catalog: await jsonFileSource({ paths: ["./translations/*.json"] }).load(),
});

console.log(translator.translate("greeting", "en", { name: "Alice" }));
```

### contentFileSource()

```typescript
function contentFileSource(config: ContentFileSourceConfig): ContentFileSource
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `ContentFileSourceConfig` | Yes | — | The same configuration accepted by the `ContentFileSource` constructor. |

**Returns:** `ContentFileSource` — a new instance, equivalent to `new ContentFileSource(config)`.

```typescript
import { Translator, contentFileSource } from "blendsdk/i18n-node";

const translator = new Translator({
    defaultLocale: "en",
    catalog: await contentFileSource({ paths: ["./content/emails"] }).load(),
});

console.log(translator.translate("signup-email", "en", { name: "Alice" }));
```

---

## Types & Interfaces

### TranslationValue

```typescript
type TranslationValue = string | [singular: string, plural: string];
```

A single translation value.

| Variant | Type | Description |
|---------|------|-------------|
| Simple string | `string` | One value used for every count. May contain `${...}` placeholders. |
| Plural tuple | `[singular: string, plural: string]` | Index `0` is the singular form, index `1` the plural form. Selected by a numeric `params.count` in `translate()`; the singular form is the default. |

```typescript
import type { TranslationValue } from "blendsdk/i18n";

const simple: TranslationValue = "Hello ${name}";
const plural: TranslationValue = ["${count} book", "${count} books"];
```

### TranslationEntry

```typescript
type TranslationEntry = Record<string, TranslationValue>;
```

One translation key mapped to all its locale translations.

| Key | Value type | Description |
|-----|------------|-------------|
| Locale identifier (`"en"`, `"en_GB"`, `"nl"`, …) | `TranslationValue` | The value for that locale. Lookups try the exact `full` locale first, then the language-only fallback. |

```typescript
import type { TranslationEntry } from "blendsdk/i18n";

const greeting: TranslationEntry = {
    en: "Hello ${name}",
    nl: "Hallo ${name}",
};

const book: TranslationEntry = {
    en: ["${count} book", "${count} books"],
    nl: ["${count} boek", "${count} boeken"],
};
```

### TranslationCatalog

```typescript
type TranslationCatalog = Record<string, TranslationEntry>;
```

The complete catalog: a flat map of translation keys to their locale entries. Keys use dot notation by convention for namespacing (`"auth.login"`), but the catalog itself is never nested.

| Key | Value type | Description |
|-----|------------|-------------|
| Translation key (`"greeting"`, `"auth.login"`, …) | `TranslationEntry` | All locale values for that key. |

```typescript
import type { TranslationCatalog } from "blendsdk/i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    "auth.login": { en: "Log in", nl: "Inloggen" },
    "cart.items": {
        en: ["${count} item", "${count} items"],
    },
};
```

### TranslatorConfig

Configuration accepted by the `Translator` constructor. Every property is optional.

| Property | Type | Description |
|----------|------|-------------|
| `defaultLocale` | `string` | Optional. Locale applied when `translate()` or `hasKey()` is called without one. Default: `"en"`. |
| `catalog` | `TranslationCatalog` | Optional. Initial catalog. Default: `{}` — can be populated later via `setCatalog()` after loading sources. |
| `onMissingTranslation` | `(key: string, locale: string) => void` | Optional. Invoked whenever a lookup fails — the key is absent from the catalog, or no value resolves for the locale. Receives the requested key and the resolved locale. |

### LocaleParts

Parsed locale components, produced by `Translator.parseLocale()`.

| Property | Type | Description |
|----------|------|-------------|
| `full` | `string` | The normalized locale with encoding stripped and dashes replaced by underscores: `"en_GB"`. Used for exact-match lookups. |
| `language` | `string` | The language segment: `"en"`. Used for the language fallback. |
| `region` | `string \| undefined` | The region segment when present: `"GB"`. Language fallback only applies when a region was requested. |

Normalization reference:

| Input | `full` | `language` | `region` |
|-------|--------|------------|----------|
| `"en"` | `"en"` | `"en"` | `undefined` |
| `"en_GB"` | `"en_GB"` | `"en"` | `"GB"` |
| `"en-GB"` | `"en_GB"` | `"en"` | `"GB"` |
| `"en_GB.UTF-8"` | `"en_GB"` | `"en"` | `"GB"` |

### TranslationSource

The interface every translation backend implements. Implement it for databases, REST APIs, or any custom storage; built-in implementations are `JsonFileSource` and `ContentFileSource`.

| Member | Signature | Description |
|--------|-----------|-------------|
| `name` | `readonly string` | Human-readable identifier for logging and diagnostics, e.g. `"JsonFileSource"` or `"PostgreSQLSource"`. |
| `load` | `() => Promise<TranslationCatalog>` | Loads the complete catalog from the backend. Called at application startup and on reload events; should throw a descriptive error when the source is unavailable. |

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/i18n";

class InMemorySource implements TranslationSource {
    readonly name = "InMemorySource";

    constructor(private readonly data: TranslationCatalog) {}

    async load(): Promise<TranslationCatalog> {
        return this.data;
    }
}

const translator = new Translator({
    defaultLocale: "en",
    catalog: await new InMemorySource({ greeting: { en: "Hello", nl: "Hallo" } }).load(),
});

console.log(translator.translate("greeting", "nl")); // "Hallo"
```

---

## Constants and Defaults

The package exports no enums and no public constants. Two defaults are applied internally and can be overridden through configuration:

| Default | Value | Applied by | Overridable via |
|---------|-------|------------|-----------------|
| Default locale | `"en"` | `Translator` | `TranslatorConfig.defaultLocale` |
| Content file extensions | `[".html", ".md", ".txt"]` | `ContentFileSource` | `ContentFileSourceConfig.extensions` (a configured list replaces the defaults) |

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
