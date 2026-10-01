> **Package**: `blendsdk/i18n`

# i18n Core Concepts

`blendsdk/i18n` is built from a handful of cooperating concepts: a runtime-agnostic translation engine, a normalized catalog data model, and a pluggable source layer that loads data from JSON files, localized content files, or custom backends. Data flows in one direction — sources normalize their backend into a `TranslationCatalog`, catalogs can be layered with `mergeCatalogs`, and the `Translator` resolves keys against the final catalog at request time:

```text
TranslationSource.load() ──▶ TranslationCatalog ──▶ mergeCatalogs([...]) ──▶ Translator.translate()
(JsonFileSource,              (normalized            (optional,               (fallback → plural →
 ContentFileSource,            key → { locale →       last wins)               interpolation)
 custom sources)               value } map)
```

The engine and `mergeCatalogs` are exported from the browser-safe entry point (`blendsdk/i18n`); `JsonFileSource` and `ContentFileSource` are exported from the Node.js entry point (`blendsdk/i18n-node`). See Basic Usage for a first-run walkthrough and Overview for the package-level summary.

Concepts covered in this document:

1. [Translator](#translator) — the engine that resolves keys at runtime
2. [The Catalog Data Model](#the-catalog-data-model) — `TranslationCatalog`, `TranslationEntry`, `TranslationValue`
3. [Locale Parsing and Fallback](#locale-parsing-and-fallback) — normalization and the exact → language chain
4. [Plural Selection](#plural-selection) — `[singular, plural]` tuples driven by `count`
5. [String Interpolation](#string-interpolation) — `${param}` substitution via `blendsdk/stdlib`
6. [Missing-Translation Handling](#missing-translation-handling) — callback reporting and key-as-fallback
7. [TranslationSource](#translationsource) — the pluggable source contract
8. [JsonFileSource](#jsonfilesource) — JSON catalogs with format auto-detection
9. [ContentFileSource](#contentfilesource) — one file per key per locale for rich content
10. [mergeCatalogs](#mergecatalogs) — layered composition, last wins
11. [Catalog Reload with setCatalog](#catalog-reload-with-setcatalog) — atomic swaps for runtime updates

---

## Translator

### What It Is

`Translator` is the core engine of the package: a small, framework-free class that holds a translation catalog and a default locale, and resolves translation keys to localized strings. It is runtime-agnostic — it imports nothing from `node:*` or the DOM — so the same logic runs in Node.js services and in browser bundles. Everything the library does at request time (locale fallback, plural selection, `${...}` interpolation, missing-key reporting) is coordinated by this single class.

### How It Works

You construct a translator with an optional `TranslatorConfig`. Defaults are `defaultLocale: "en"`, an empty catalog, and no missing-translation callback. The catalog is held by reference, so it can be swapped wholesale at runtime without reconstructing the translator (see [Catalog Reload with setCatalog](#catalog-reload-with-setcatalog)).

Each `translate(key, locale?, params?)` call runs a fixed pipeline:

1. **Resolve the locale** — `locale ?? defaultLocale` — then parse and cache it (see [Locale Parsing and Fallback](#locale-parsing-and-fallback)).
2. **Look up the key** in the catalog. A missing key invokes `onMissingTranslation` and returns the key unchanged (see [Missing-Translation Handling](#missing-translation-handling)).
3. **Resolve the value** for the locale through the fallback chain (exact locale first, then language).
4. **Select the plural form** when the value is a `[singular, plural]` tuple and `params.count` is a number (see [Plural Selection](#plural-selection)).
5. **Interpolate** `${...}` placeholders from `params` via `formatString` (see [String Interpolation](#string-interpolation)).

The class also exposes `getTranslationsForLocale()` to export a flat per-locale map for frontend clients, and `hasKey()` for existence checks. The `parseLocale`, `resolveValue`, and `selectPlural` members are `protected` — they are extension points for subclasses and are covered in their respective concept sections.

### Complete Example

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
        "auth.login": { en: "Log in", nl: "Inloggen" },
    },
});

const english = translator.translate("greeting", "en", { name: "Alice" });
const dutch = translator.translate("greeting", "nl", { name: "Alice" });
const dutchLogin = translator.translate("auth.login", "nl");
const defaultLocaleLogin = translator.translate("auth.login");

console.log(english);            // "Hello Alice"
console.log(dutch);              // "Hallo Alice"
console.log(dutchLogin);         // "Inloggen"
console.log(defaultLocaleLogin); // "Log in" — defaultLocale used when omitted
console.log(translator.getDefaultLocale()); // "en"
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `translate` | `(key: string, locale?: string, params?: Record<string, unknown>) => string` | Resolves a key to a translated string using locale fallback, plural selection (via `params.count`), and `${...}` interpolation. Returns the key itself when it cannot be resolved. |
| `getTranslationsForLocale` | `(locale: string) => Record<string, TranslationValue>` | Returns a flat `{ key: value }` map for one locale, with fallback applied per key. Plural tuples are returned as-is (clients select the form at render time); keys without a resolvable value are omitted. |
| `hasKey` | `(key: string, locale?: string) => boolean` | Returns `true` if the key exists. With `locale`, returns `true` only if a value resolves for that locale through the fallback chain. |
| `setCatalog` | `(catalog: TranslationCatalog) => void` | Atomically replaces the catalog by reference and clears the locale-parse cache. |
| `getCatalog` | `() => TranslationCatalog` | Returns the current catalog reference — useful for layering reloads and for tests. |
| `getDefaultLocale` | `() => string` | Returns the configured default locale (`"en"` unless configured otherwise). |
| `parseLocale` (protected) | `(locale: string) => LocaleParts` | Normalizes and caches a raw locale string into its parts. |
| `resolveValue` (protected) | `(entry: TranslationEntry, localeParts: LocaleParts) => TranslationValue \| undefined` | Applies the fallback chain to one entry. |
| `selectPlural` (protected) | `(value: TranslationValue, params?: Record<string, unknown>) => string` | Selects the singular or plural form based on `params.count`. |

Configuration (`TranslatorConfig`):

| Name | Type/Signature | Description |
|---|---|---|
| `defaultLocale` | `string` | Optional. Locale used when `translate()` omits it. Default: `"en"`. |
| `catalog` | `TranslationCatalog` | Optional. Initial catalog. Default: `{}`. |
| `onMissingTranslation` | `(key: string, locale: string) => void` | Optional. Callback invoked when a key or locale value cannot be resolved. |

---

## The Catalog Data Model

### What It Is

The catalog data model is the normalized representation of all translations in the system: three TypeScript types (`TranslationValue`, `TranslationEntry`, `TranslationCatalog`) that every source produces, `mergeCatalogs` combines, and the `Translator` consumes. Because everything funnels through this one model, sources and the engine never need to know about each other's formats.

### How It Works

- **`TranslationValue`** is the smallest unit: either a plain string or a two-element `[singular, plural]` tuple.
- **`TranslationEntry`** maps locale identifiers (`"en"`, `"en_GB"`, `"nl"`) to values for one translation key.
- **`TranslationCatalog`** is a flat map of keys to entries. Keys use dot notation by convention (`"auth.login"`) for namespacing, but the catalog itself is never nested.

Translation sources normalize their backend data into this shape: `JsonFileSource` converts two-string JSON arrays into tuples and other JSON scalars into strings, and `ContentFileSource` stores file content as raw strings. The engine never mutates entries; `mergeCatalogs` produces new entry copies when composing catalogs.

### Complete Example

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationEntry, TranslationValue } from "blendsdk/i18n";

const greeting: TranslationEntry = {
    en: "Hello ${name}",
    nl: "Hallo ${name}",
};

const book: TranslationEntry = {
    en: ["${count} book", "${count} books"],
    nl: ["${count} boek", "${count} boeken"],
};

const catalog: TranslationCatalog = {
    greeting,
    book,
    "auth.login": { en: "Log in", nl: "Inloggen" },
};

const display = (value: TranslationValue): string =>
    Array.isArray(value) ? value[0] : value;

const single: TranslationValue = "Hello";
const plural: TranslationValue = ["one item", "many items"];

console.log(display(single)); // "Hello"
console.log(display(plural)); // "one item"

const translator = new Translator({ defaultLocale: "en", catalog });

console.log(translator.translate("greeting", "en", { name: "Alice" })); // "Hello Alice"
console.log(translator.translate("book", "nl", { count: 2 }));          // "2 boeken"
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `TranslationValue` | `string \| [singular: string, plural: string]` | One translated value: a plain string, or a tuple with singular (index `0`) and plural (index `1`) forms. |
| `TranslationEntry` | `Record<string, TranslationValue>` | One translation key mapped to its per-locale values, e.g. `{ en: "Hello", nl: "Hallo" }`. |
| `TranslationCatalog` | `Record<string, TranslationEntry>` | The complete catalog: a flat map of translation keys to entries. Keys use dot notation by convention. |

---

## Locale Parsing and Fallback

### What It Is

Locale handling is the mechanism that accepts any locale string a caller provides — `en`, `en-GB`, `en_GB.UTF-8`, `nl_NL` — normalizes it into structured parts, and then selects the best available translation through a downward fallback chain. It is what makes lookups forgiving of formatting differences and incomplete translation coverage.

### How It Works

Every `translate()`, `hasKey()`, and `getTranslationsForLocale()` call parses its locale through `parseLocale()`:

1. **Strip the encoding** — everything after the first `.` is removed (`"en_GB.UTF-8"` → `"en_GB"`).
2. **Normalize the separator** — the first `-` becomes `_` (`"en-GB"` → `"en_GB"`).
3. **Split into parts** — `"en_GB"` becomes `{ full: "en_GB", language: "en", region: "GB" }`.

Results are cached in a `Map` keyed by the raw input string, so repeated calls are O(1) dictionary lookups rather than repeated parsing.

Value resolution (`resolveValue`) then walks the fallback chain **downward only**:

1. **Exact match** — `entry["en_GB"]` if the requested locale is `en_GB`.
2. **Language fallback** — `entry["en"]` if the entry has no `en_GB` value and the requested locale had a region.
3. **No match** — `undefined`, which triggers missing-translation handling (see [Missing-Translation Handling](#missing-translation-handling)).

A request for `en` never upgrades to a more specific entry such as `en_GB` — fallback only moves from specific to general.

### Complete Example

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate", nl: "Hallo" },
        farewell: { en: "Goodbye" },
        "cart.total": { nl: "Totaal" },
    },
});

console.log(translator.translate("greeting", "en_GB"));       // "Hello, mate" — exact match
console.log(translator.translate("greeting", "en-GB"));       // "Hello, mate" — dash normalized
console.log(translator.translate("greeting", "en_GB.UTF-8")); // "Hello, mate" — encoding stripped
console.log(translator.translate("farewell", "en_GB"));       // "Goodbye" — falls back to "en"
console.log(translator.translate("cart.total", "nl_NL"));     // "Totaal" — falls back to "nl"
console.log(translator.translate("greeting", "de"));          // "greeting" — no match, key returned
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `LocaleParts.full` | `string` | The normalized locale with encoding stripped and dashes replaced: `"en_GB"`. Used for exact-match lookups. |
| `LocaleParts.language` | `string` | The language segment: `"en"`. Used for the language fallback. |
| `LocaleParts.region` | `string \| undefined` | The region segment when present: `"GB"`. Fallback to language only happens when a region was requested. |
| `parseLocale` (protected) | `(locale: string) => LocaleParts` | Parses and caches a raw locale string. |
| `resolveValue` (protected) | `(entry: TranslationEntry, localeParts: LocaleParts) => TranslationValue \| undefined` | Applies the exact → language fallback chain to one entry. |

Normalization reference:

| Input | `full` | `language` | `region` |
|---|---|---|---|
| `"en"` | `"en"` | `"en"` | `undefined` |
| `"en_GB"` | `"en_GB"` | `"en"` | `"GB"` |
| `"en-GB"` | `"en_GB"` | `"en"` | `"GB"` |
| `"en_GB.UTF-8"` | `"en_GB"` | `"en"` | `"GB"` |

---

## Plural Selection

### What It Is

Plural selection is the mechanism that chooses between singular and plural wording based on a `count` parameter. A translation value can be declared as a `[singular, plural]` tuple, and `translate()` picks the correct form automatically before interpolating the count into the string.

### How It Works

When a resolved value is a tuple and `params.count` is a number:

- `count === 1` → the singular form (index `0`)
- any other number (including `0` and negatives) → the plural form (index `1`)

If `value` is a plain string, it is returned unchanged — the `count` parameter is ignored for plural selection, though it can still be interpolated. If `count` is missing, not a number, or `NaN`, the singular form is selected and the provided value is still interpolated into `${count}`.

Two important boundaries:

- **Plural selection happens only inside `translate()`.** `getTranslationsForLocale()` returns tuples as-is, because clients rendering dynamic counts need both forms available.
- **There are exactly two forms.** This is a simple singular/plural split, not a full ICU `Intl.PluralRules` implementation; languages with more complex plural categories are not modeled beyond the pair you provide.

Both forms of a tuple typically contain the `${count}` placeholder so the final string always shows the actual number.

### Complete Example

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "cart.items": {
            en: ["${count} item in your cart", "${count} items in your cart"],
            nl: ["${count} artikel in je winkelwagen", "${count} artikelen in je winkelwagen"],
        },
    },
});

console.log(translator.translate("cart.items", "en", { count: 1 })); // "1 item in your cart"
console.log(translator.translate("cart.items", "en", { count: 0 })); // "0 items in your cart"
console.log(translator.translate("cart.items", "nl", { count: 3 })); // "3 artikelen in je winkelwagen"

// The tuple form is preserved when exporting for clients:
console.log(translator.getTranslationsForLocale("en")["cart.items"]);
// → ["${count} item in your cart", "${count} items in your cart"]
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `selectPlural` (protected) | `(value: TranslationValue, params?: Record<string, unknown>) => string` | Returns a plain string from a value: selects tuple index `0` or `1` from `params.count`, or passes strings through unchanged. |
| `TranslationValue` (plural form) | `[singular: string, plural: string]` | Tuple with the singular form at index `0` and the plural form at index `1`. |
| `params.count` | `number` | The number that drives the selection. `1` selects singular; any other number selects plural. |

Selection reference for `["${count} book", "${count} books"]`:

| `count` value | Selected form | Result |
|---|---|---|
| `1` | singular | `"1 book"` |
| `0`, `2`, `-1`, … | plural | `"2 books"` |
| missing, non-number, or `NaN` | singular | singular form with the given value interpolated |

---

## String Interpolation

### What It Is

String interpolation replaces `${param}` placeholders inside translation values with values from the `params` argument of `translate()`. It lets a single translation template produce dynamic output — names, order numbers, counts — without any string concatenation at the call site. The substitution is performed by `formatString` from `blendsdk/stdlib`.

### How It Works

After locale resolution and plural selection produce a final template string, `translate()` calls `formatString(template, params)`. This means:

- Interpolation runs **after** plural selection, so only the chosen singular or plural form is processed.
- Both forms of a tuple can carry placeholders (typically `${count}`), and so can simple strings.
- String and number parameter values are rendered into the template; the same `params.count` used for plural selection is also available as a `${count}` placeholder.
- A parameter that has no matching placeholder is simply not used.

Interpolation is the last step of the `translate()` pipeline — the string returned to the caller is always fully resolved, with no placeholders left when all required parameters are supplied.

### Complete Example

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        welcome: { en: "Welcome back, ${name}!", nl: "Welkom terug, ${name}!" },
        "order.status": {
            en: "Order ${orderId} ships in ${days} days",
            nl: "Bestelling ${orderId} wordt binnen ${days} dagen verzonden",
        },
        "invoice.lines": {
            en: ["${count} line for ${customer}", "${count} lines for ${customer}"],
        },
    },
});

console.log(translator.translate("welcome", "en", { name: "Alice" }));
// "Welcome back, Alice!"

console.log(translator.translate("order.status", "nl", { orderId: "A-1024", days: 3 }));
// "Bestelling A-1024 wordt binnen 3 dagen verzonden"

console.log(translator.translate("invoice.lines", "en", { customer: "Acme", count: 2 }));
// "2 lines for Acme"
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `params` | `Record<string, unknown>` | Lookup table for placeholders passed to `translate()`. String and number values are rendered into the template. |
| `${param}` | placeholder inside translation values | Replaced with the value of `params.param`. May appear in simple strings and in either form of a plural tuple. |
| `formatString` | from `blendsdk/stdlib` | The interpolation routine `Translator` delegates to; invoked after plural selection with the chosen template string. |

---

## Missing-Translation Handling

### What It Is

Missing-translation handling defines what happens when a key cannot be resolved: `translate()` returns the key itself instead of throwing or returning an empty string, and an optional `onMissingTranslation` callback reports the gap. Returning the key keeps the application running and makes missing translations visible in the UI, while the callback gives you a hook for logging or telemetry.

### How It Works

There are exactly two situations that trigger missing handling:

1. **The key is not in the catalog at all** — no entry exists for the requested key.
2. **The key exists, but no value resolves** for the requested locale — the fallback chain (see [Locale Parsing and Fallback](#locale-parsing-and-fallback)) found neither an exact nor a language match.

In both cases `translate()` calls `onMissingTranslation?.(key, resolvedLocale)` — where `resolvedLocale` is the requested locale, or the `defaultLocale` when the call omitted the locale — and returns the key string unchanged. When the callback is not configured, resolution is simply silent.

`hasKey(key, locale?)` applies the same rules up front: without a locale it checks only that the key exists; with a locale it reports whether a value resolves through the fallback chain. Use it when you want to branch on availability instead of relying on the returned key.

### Complete Example

```typescript
import { Translator } from "blendsdk/i18n";

const missingKeys: string[] = [];

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
    },
    onMissingTranslation: (key: string, locale: string): void => {
        missingKeys.push(`${locale}:${key}`);
    },
});

console.log(translator.translate("greeting", "en")); // "Hello"
console.log(translator.translate("farewell", "en")); // "farewell" — key returned as-is
console.log(translator.translate("greeting", "de")); // "greeting" — no value for "de"

console.log(missingKeys); // ["en:farewell", "de:greeting"]

console.log(translator.hasKey("greeting", "nl")); // true
console.log(translator.hasKey("greeting", "de")); // false
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `onMissingTranslation` | `((key: string, locale: string) => void) \| undefined` | Config callback invoked with the requested key and the resolved locale whenever a lookup fails. |
| `hasKey` | `(key: string, locale?: string) => boolean` | Pre-flight existence check applying the same fallback rules as `translate()`. |

Resolution outcomes:

| Situation | `translate()` returns | Callback invoked |
|---|---|---|
| Key found, value resolves | Interpolated translation | No |
| Key not in catalog | The key itself | Yes, `(key, resolvedLocale)` |
| Key present, no value via fallback | The key itself | Yes, `(key, resolvedLocale)` |

---

## TranslationSource

### What It Is

`TranslationSource` is the interface every translation backend implements — file systems, databases, remote APIs, anything. It is deliberately minimal: a `name` for logging and an async `load()` that returns a complete `TranslationCatalog`. This is the seam that keeps the library open for extension while keeping the `Translator` closed against backend specifics.

### How It Works

A source is responsible for exactly three things:

1. **Connecting** to its backend (file system, database, HTTP endpoint).
2. **Reading** the translation data in whatever format the backend uses.
3. **Normalizing** that data into the `TranslationCatalog` shape — strings and `[singular, plural]` tuples keyed by locale (see [The Catalog Data Model](#the-catalog-data-model)).

`load()` is called at application startup and again on reload events; it must return a complete catalog and should throw a descriptive error when the backend is unavailable, so failures surface at the call site rather than degrading silently. Sources never resolve locale fallbacks or interpolate strings — that is exclusively the `Translator`'s job.

Sources compose naturally: load several, combine them with `mergeCatalogs` in priority order (see [mergeCatalogs](#mergecatalogs)), and hand the result to a `Translator`. Both built-in file sources implement this same interface.

### Complete Example

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/i18n";

/** A TranslationSource backed by an in-memory catalog (useful for tests and defaults). */
class InMemorySource implements TranslationSource {
    readonly name = "InMemorySource";

    private readonly data: TranslationCatalog;

    constructor(data: TranslationCatalog) {
        this.data = data;
    }

    async load(): Promise<TranslationCatalog> {
        return this.data;
    }
}

const source: TranslationSource = new InMemorySource({
    greeting: { en: "Hello", nl: "Hallo" },
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(source.name);                            // "InMemorySource"
console.log(translator.translate("greeting", "nl")); // "Hallo"
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `name` | `readonly string` | Human-readable identifier used for logging and diagnostics, e.g. `"JsonFileSource"` or `"PostgreSQLSource"`. |
| `load` | `() => Promise<TranslationCatalog>` | Loads the complete catalog from the backend. Called at startup and on reload; should throw a descriptive error when the source is unavailable. |

---

## JsonFileSource

### What It Is

`JsonFileSource` is a Node.js-only translation source that loads JSON files from disk and normalizes them into a `TranslationCatalog`. It supports two interchangeable file organizations — all locales in one file, or one file per locale — and auto-detects which one each file uses, so translation repositories can mix both styles without configuration.

### How It Works

`load()` processes each configured path as follows:

1. **Resolve paths** — each entry in `paths` is either a plain file path (read directly; a missing file throws) or a glob pattern. Globs support `*` (any run of characters) and `?` (one character) in the filename segment only; they scan a single directory, are not recursive, and a glob whose directory does not exist resolves to zero files without error.
2. **Sort** — all resolved files are processed in sorted order, so identical configuration always produces an identical catalog. When two files define the same key + locale, the file that sorts later wins.
3. **Parse** — each file is read as UTF-8 and passed through `JSON.parse`; a parse failure throws `Failed to parse JSON file "<path>": <reason>`.
4. **Detect the format per file** by inspecting the first value:
   - first value is a plain object → **multi-locale** (`{ key: { locale: value } }`, locales come from inside the file)
   - first value is a string or array → **single-locale** (flat `{ key: value }`, locale derived from the filename's last dot-segment, e.g. `en.json` → `"en"`, `strings.nl.json` → `"nl"`)
5. **Normalize values** — strings pass through as-is; arrays of exactly two strings become `[singular, plural]` tuples; any other value is converted with `String(value)`.
6. **Merge** every entry into one catalog; later files override earlier files for duplicate key + locale pairs.

The multi-locale format looks like this:

```json
{
    "greeting": { "en": "Hello ${name}", "nl": "Hallo ${name}" },
    "book": {
        "en": ["${count} book", "${count} books"],
        "nl": ["${count} boek", "${count} boeken"]
    }
}
```

### Complete Example

Given a project with these files:

```text
translations/
├── en.json
└── nl.json
```

`translations/en.json` (single-locale format — the first value is a string, so the locale comes from the filename):

```json
{
    "greeting": "Hello ${name}",
    "book": ["${count} book", "${count} books"]
}
```

`translations/nl.json`:

```json
{
    "greeting": "Hallo ${name}",
    "book": ["${count} boek", "${count} boeken"]
}
```

Load and use them:

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: ["./translations/*.json"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(translator.translate("greeting", "nl", { name: "Alice" })); // "Hallo Alice"
console.log(translator.translate("book", "en", { count: 3 }));          // "3 books"
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `name` | `readonly string` | Always `"JsonFileSource"`. |
| `constructor` | `new (config: JsonFileSourceConfig) => JsonFileSource` | Creates a source bound to the given paths. |
| `load` | `() => Promise<TranslationCatalog>` | Resolves paths, reads and parses each file, detects the format, normalizes values, and merges everything into one catalog. Throws on unreadable plain paths and invalid JSON. |
| `jsonFileSource` | `(config: JsonFileSourceConfig) => JsonFileSource` | Factory function with identical behavior, for declarative configuration (e.g. in a plugin `sources` array). |

Configuration (`JsonFileSourceConfig`):

| Name | Type/Signature | Description |
|---|---|---|
| `paths` | `string[]` | JSON file paths and/or glob patterns. Globs use `*` and `?` in the filename segment (single directory, non-recursive). |

Format detection reference:

| Format | Detection rule | Locale source | Typical value shapes |
|---|---|---|---|
| multi-locale | First value in the file is a plain object | Locale keys inside the file | string or `[singular, plural]` |
| single-locale | First value is a string or array | Last dot-segment of the filename | string or `[singular, plural]` |

---

## ContentFileSource

### What It Is

`ContentFileSource` is a Node.js-only translation source for rich, one-file-per-key content: HTML email templates, Markdown pages, plain-text legal copy, and anything else that deserves its own file per locale. Each file is a single translation value for a single key in a single locale, identified by the filename convention `<locale>.<key>.<ext>`.

### How It Works

1. **Resolve paths** — each entry in `paths` is either a directory (all matching files inside are considered; listing is non-recursive) or a glob pattern containing `*`/`?`. Missing directories and globs that match nothing contribute zero files without error.
2. **Sort** — resolved file paths are sorted for deterministic catalog output; on duplicate key + locale, the file that sorts later wins.
3. **Parse filenames** — the filename is split on `.` and must contain at least three segments: the first is the locale, the last is the extension, and everything in between is the key, joined with dots. Files with an empty locale (e.g. hidden dot-files) or fewer than three segments are silently skipped.
4. **Filter by extension** — only files whose extension is in the configured list are read. The default list is `[".html", ".md", ".txt"]`; configured extensions are normalized to a leading dot and lowercase, and a custom list *replaces* the defaults entirely.
5. **Read content** — each surviving file is read as UTF-8 and stored **as-is**, with no parsing or transformation. Whitespace, markup, and `${...}` placeholders all survive, which means the `Translator` can interpolate dynamic values into the content at render time.
6. **Assemble** — content becomes `catalog[key][locale]`. Files that cannot be read (e.g. permission errors) throw.

The filename convention in detail:

| Filename | Locale | Key | Outcome |
|---|---|---|---|
| `en.signup-email.html` | `en` | `signup-email` | Loaded |
| `nl.signup-email.html` | `nl` | `signup-email` | Loaded |
| `en.auth.welcome.md` | `en` | `auth.welcome` | Loaded — middle segments join with `.` to form dot-notation keys |
| `readme.txt` | — | — | Skipped — fewer than 3 dot-segments |
| `.hidden-file.html` | — | — | Skipped — empty locale segment |
| `en.notes.xml` | — | — | Skipped — extension not in the configured list |

### Complete Example

Given a project with these files:

```text
content/emails/
├── en.signup-email.html
└── nl.signup-email.html
```

`content/emails/en.signup-email.html`:

```html
<p>Welcome, ${name}!</p>
```

`content/emails/nl.signup-email.html`:

```html
<p>Welkom, ${name}!</p>
```

Load and render them:

```typescript
import { Translator, ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({
    paths: ["./content/emails"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

const email = translator.translate("signup-email", "en", { name: "Alice" });
console.log(email); // "<p>Welcome, Alice!</p>"

const dutchEmail = translator.translate("signup-email", "nl", { name: "Alice" });
console.log(dutchEmail); // "<p>Welkom, Alice!</p>"
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `name` | `readonly string` | Always `"ContentFileSource"`. |
| `constructor` | `new (config: ContentFileSourceConfig) => ContentFileSource` | Creates a source bound to the given paths and extension filter. |
| `load` | `() => Promise<TranslationCatalog>` | Lists and filters content files, parses the `<locale>.<key>.<ext>` filenames, reads content as UTF-8, and assembles the catalog. Throws when a matched file cannot be read. |
| `contentFileSource` | `(config: ContentFileSourceConfig) => ContentFileSource` | Factory function with identical behavior, for declarative configuration. |

Configuration (`ContentFileSourceConfig`):

| Name | Type/Signature | Description |
|---|---|---|
| `paths` | `string[]` | Directory paths and/or glob patterns to scan. Non-glob entries are treated as directories and listed (non-recursively). |
| `extensions` | `string[]` | Optional. Extensions to include, with or without the leading dot and case-insensitive (`".html"`, `"txt"`, `".HTML"` all work). Default: `[".html", ".md", ".txt"]`. Replaces the defaults when configured. |

---

## mergeCatalogs

### What It Is

`mergeCatalogs` is a pure utility function that combines multiple `TranslationCatalog` objects into one, applying them in priority order where later catalogs win. It is the composition primitive for layered translation setups — file-based defaults under database or API overrides — and for assembling a fresh catalog during reloads.

### How It Works

The function iterates the input array in order:

- The **first** time a key is encountered, its entry is shallow-copied into the result (`{ ...entry }`).
- On **later** encounters of the same key, locale values are merged into the existing entry with `Object.assign`, so the last catalog wins per key + locale while untouched locales from earlier catalogs are preserved. For example, if the base catalog has `{ en: "Hello", nl: "Hallo" }` and the override has `{ en: "Hi" }`, the result is `{ en: "Hi", nl: "Hallo" }`.

The inputs are never mutated, and the result's entry objects are copies — not shared references with the inputs. The function is synchronous and lives in the browser-safe core, so it can run in any runtime. It is also the natural companion to `setCatalog` for atomic reloads (see [Catalog Reload with setCatalog](#catalog-reload-with-setcatalog)).

### Complete Example

```typescript
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const defaults: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
};

const overrides: TranslationCatalog = {
    greeting: { en: "Hi there" },
    "cart.empty": { en: "Your cart is empty", nl: "Je winkelwagen is leeg" },
};

const merged: TranslationCatalog = mergeCatalogs([defaults, overrides]);

console.log(merged.greeting);
// → { en: "Hi there", nl: "Hallo" } — "en" overridden, "nl" preserved

console.log(merged.farewell);
// → { en: "Goodbye", nl: "Tot ziens" } — untouched

console.log(merged["cart.empty"]);
// → { en: "Your cart is empty", nl: "Je winkelwagen is leeg" } — added
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `mergeCatalogs` | `(catalogs: TranslationCatalog[]) => TranslationCatalog` | Merges catalogs in array order; for duplicate key + locale pairs the later catalog wins. Returns a new catalog with copied entries; inputs are not mutated. |

---

## Catalog Reload with setCatalog

### What It Is

Catalog reload is the runtime life cycle operation that swaps a `Translator`'s entire catalog while the application keeps serving requests. It is how content updates, database overrides, or pub/sub-triggered refreshes reach a running process without a restart and without locking translation reads.

### How It Works

`setCatalog()` performs a single reference assignment — the new catalog replaces the old one in one operation — and clears the internal locale-parse cache. Because every lookup reads the current catalog reference at call time, the swap is atomic from a caller's perspective: calls that begin before the swap resolve against the previous catalog, and calls that begin after it resolve against the new one. There is no intermediate state in which the catalog is partially updated. The previous catalog is simply dereferenced.

The typical reload flow is:

1. **Load** — call `load()` on one or more [sources](#translationsource) (optionally with retry and error handling).
2. **Compose** — layer the freshly loaded catalog over the existing one with [mergeCatalogs](#mergecatalogs) when only part of the data should change, or use the loaded catalog directly for a full replacement.
3. **Swap** — call `setCatalog()` with the finished catalog. `getCatalog()` is available to read the current reference before swapping.

Always finish constructing and validating the replacement catalog **before** calling `setCatalog()` — the swap itself is intentionally minimal so that a failed load never leaves the translator in a broken state.

### Complete Example

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
    },
});

console.log(translator.translate("greeting", "nl")); // "Hallo"

// Build the replacement catalog fully before swapping it in:
const overrides: TranslationCatalog = {
    greeting: { nl: "Hoi" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
};

const updated = mergeCatalogs([translator.getCatalog(), overrides]);
translator.setCatalog(updated);

console.log(translator.translate("greeting", "nl")); // "Hoi" — overridden
console.log(translator.translate("greeting", "en")); // "Hello" — untouched locale preserved
console.log(translator.translate("farewell", "nl")); // "Tot ziens" — newly added
```

### Key Methods and Properties

| Name | Type/Signature | Description |
|---|---|---|
| `setCatalog` | `(catalog: TranslationCatalog) => void` | Atomically replaces the catalog by reference and clears the locale-parse cache. Subsequent translations use the new catalog. |
| `getCatalog` | `() => TranslationCatalog` | Returns the current catalog reference — read it before swapping to layer new data over the existing catalog. |

---

# i18n Basic Usage

`blendsdk/i18n` is a runtime-agnostic internationalization library: a translation engine (`Translator`) for key lookup, locale fallback, plural selection, and `${param}` interpolation, plus pluggable sources for loading catalogs from JSON files and localized content files. This guide takes you from installing the package to a running translator, file-based catalogs, and runtime reloads. For the full concept reference, see Core Concepts.

In this document:

1. [Installation](#installation) — install commands and entry points
2. [Quick Start](#quick-start) — a working translator in a handful of lines
3. [Fundamentals](#fundamentals) — one new concept per subsection, from `new Translator()` to runtime reloads
4. [Configuration](#configuration) — all common options with their defaults
5. [Error Handling](#error-handling) — what throws, what doesn't, and how to recover

---

## Installation

Install the package with your package manager:

```bash
# npm
npm install blendsdk/i18n

# yarn
yarn add blendsdk/i18n

# pnpm
pnpm add blendsdk/i18n
```

The package has a single runtime dependency — `blendsdk/stdlib`, which provides the `${param}` interpolation — and it is installed automatically.

Two entry points are available, split so that browser bundles never pull in Node.js code:

| Import path | Works in | Exports |
|---|---|---|
| `blendsdk/i18n` | Browsers and Node.js | `Translator`, `mergeCatalogs`, and all shared types — no `node:*` imports |
| `blendsdk/i18n-node` | Node.js >= 22 | Everything from the core plus `JsonFileSource`, `jsonFileSource`, `ContentFileSource`, `contentFileSource` |

Start with the core entry point; switch to `blendsdk/i18n-node` only where you load translations from disk.

---

## Quick Start

The smallest useful setup — one catalog, two locales, one interpolated lookup:

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: { greeting: { en: "Hello ${name}", nl: "Hallo ${name}" } },
});

console.log(translator.translate("greeting", "en", { name: "Alice" })); // → "Hello Alice"
console.log(translator.translate("greeting", "nl", { name: "Alice" })); // → "Hallo Alice"
```

Three things happened here:

1. `new Translator(...)` created the engine with `"en"` as the default locale and the catalog seeded inline.
2. `translate("greeting", "nl", ...)` selected the `nl` value for the `greeting` key.
3. The `${name}` placeholder was replaced with the value of the `name` parameter.

Each of these steps gets its own subsection in [Fundamentals](#fundamentals) below.

---

## Fundamentals

Each subsection introduces exactly one new concept — the simple case first, then the next level of complexity:

1. [Creating a Translator](#creating-a-translator) — construction and defaults
2. [Translating and Interpolating](#translating-and-interpolating) — key lookup and `${param}` placeholders
3. [Plural Forms](#plural-forms) — `[singular, plural]` tuples driven by `count`
4. [Locale Fallback](#locale-fallback) — `en_GB` → `en` and locale normalization
5. [Missing Translations](#missing-translations) — key-as-fallback and `onMissingTranslation`
6. [Loading JSON Files](#loading-json-files) — `JsonFileSource` from `blendsdk/i18n-node`
7. [Loading Content Files](#loading-content-files) — `ContentFileSource` for HTML, Markdown, and text
8. [Merging Catalogs](#merging-catalogs) — layered composition with `mergeCatalogs`
9. [Exporting Translations for Clients](#exporting-translations-for-clients) — `getTranslationsForLocale`
10. [Reloading Without Restart](#reloading-without-restart) — atomic swaps with `setCatalog`

### Creating a Translator

A bare `Translator` is valid on its own: the default locale is `"en"`, and the catalog starts empty.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator();

console.log(translator.getDefaultLocale());    // → "en"
console.log(translator.translate("anything")); // → "anything" — empty catalog, key returned as-is
```

Next level — configure the default locale and seed the catalog:

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "nl",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
        "auth.login": { en: "Log in", nl: "Inloggen" },
    },
});

console.log(translator.getDefaultLocale()); // → "nl"
```

A catalog is a flat map: every translation key points to a `{ locale: value }` entry. Dot notation in keys (`"auth.login"`) is a naming convention for namespacing — the catalog itself is never nested.

### Translating and Interpolating

The simple case: a key plus a locale.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        farewell: { en: "Goodbye", nl: "Tot ziens" },
    },
});

console.log(translator.translate("farewell", "en")); // → "Goodbye"
console.log(translator.translate("farewell", "nl")); // → "Tot ziens"
console.log(translator.translate("farewell"));       // → "Goodbye" — defaultLocale used
```

Next level — add a params object to fill `${...}` placeholders:

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
        "order.status": {
            en: "Order ${orderId} ships in ${days} days",
            nl: "Bestelling ${orderId} wordt binnen ${days} dagen verzonden",
        },
    },
});

console.log(translator.translate("greeting", "en", { name: "Alice" }));
// → "Hello Alice"

console.log(translator.translate("order.status", "nl", { orderId: "A-1024", days: 3 }));
// → "Bestelling A-1024 wordt binnen 3 dagen verzonden"
```

Interpolation runs after the locale and plural decisions, so only the selected template is processed. String and number parameters both render; parameters without a matching placeholder are ignored.

### Plural Forms

The simple case: a value declared as `[singular, plural]` and a `count` parameter.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "cart.items": {
            en: ["${count} item", "${count} items"],
            nl: ["${count} artikel", "${count} artikelen"],
        },
    },
});

console.log(translator.translate("cart.items", "en", { count: 1 })); // → "1 item"
console.log(translator.translate("cart.items", "en", { count: 4 })); // → "4 items"
console.log(translator.translate("cart.items", "nl", { count: 2 })); // → "2 artikelen"
```

Next level — plurals and other placeholders combine inside the same value:

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "invoice.lines": {
            en: ["${count} line for ${customer}", "${count} lines for ${customer}"],
        },
    },
});

console.log(translator.translate("invoice.lines", "en", { count: 1, customer: "Acme" }));
// → "1 line for Acme"

console.log(translator.translate("invoice.lines", "en", { count: 2, customer: "Acme" }));
// → "2 lines for Acme"
```

The selection rules:

| `count` value | Selected form | Output |
|---|---|---|
| `1` | singular (index `0`) | `"1 item"` |
| any other number (e.g. `0`, `2`, `17`) | plural (index `1`) | `"4 items"` |
| missing or not a number | singular | singular form, with the given value interpolated |

Plural selection happens only inside `translate()`. `getTranslationsForLocale()` returns tuples as-is, because the client picks the form at render time (see [Exporting Translations for Clients](#exporting-translations-for-clients)).

### Locale Fallback

The simple case: an exact locale match wins; otherwise the language is used.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate" },
        farewell: { en: "Goodbye" },
    },
});

console.log(translator.translate("greeting", "en_GB")); // → "Hello, mate" — exact match
console.log(translator.translate("farewell", "en_GB")); // → "Goodbye" — falls back to "en"
```

Next level — locale strings are normalized before lookup:

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate" },
    },
});

console.log(translator.translate("greeting", "en-GB"));       // → "Hello, mate" — dash normalized
console.log(translator.translate("greeting", "en_GB.UTF-8")); // → "Hello, mate" — encoding stripped
```

Fallback only moves from specific to general (`en_GB` → `en`); a request for `en` never upgrades to an `en_GB` entry. When nothing matches, missing-translation handling kicks in — that's the next subsection.

### Missing Translations

The simple case: an unknown key never throws — it is returned as-is.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
    },
});

console.log(translator.translate("farewell")); // → "farewell" — unknown key, returned as-is
```

Next level — observe gaps with `onMissingTranslation`, and check availability with `hasKey`:

```typescript
import { Translator } from "blendsdk/i18n";

const missing: string[] = [];

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
    },
    onMissingTranslation: (key: string, locale: string): void => {
        missing.push(`${locale}:${key}`);
    },
});

console.log(translator.translate("farewell", "en")); // → "farewell"
console.log(translator.translate("greeting", "de")); // → "greeting" — no value for "de"
console.log(missing); // → ["en:farewell", "de:greeting"]

console.log(translator.hasKey("greeting"));       // → true — key exists
console.log(translator.hasKey("greeting", "nl")); // → true — value resolves
console.log(translator.hasKey("greeting", "de")); // → false — no value via fallback
```

There are exactly two triggers for missing handling: the key is not in the catalog, or the key exists but no value resolves for the requested locale. Both invoke the callback — if configured — and both return the key string, so applications keep rendering instead of failing.

### Loading JSON Files

The simple case: load one JSON file into a catalog. With `translations/app.json`:

```json
{
    "greeting": { "en": "Hello ${name}", "nl": "Hallo ${name}" }
}
```

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: ["./translations/app.json"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(translator.translate("greeting", "nl", { name: "Alice" }));
// → "Hallo Alice"
```

`JsonFileSource` lives in the Node.js entry point (`blendsdk/i18n-node`) because it uses `node:fs` and `node:path`. The core entry point stays browser-safe.

Next level — glob patterns and single-locale files. These two files use the flat format; the locale comes from the filename:

```text
translations/
├── en.json   → { "greeting": "Hello ${name}" }
└── nl.json   → { "greeting": "Hallo ${name}" }
```

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: ["./translations/*.json"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(translator.translate("greeting", "nl", { name: "Alice" }));
// → "Hallo Alice"
```

What's worth knowing:

- The format is auto-detected per file: `{ key: { locale: value } }` is multi-locale; a flat `{ key: value }` is single-locale, with the locale taken from the filename (`en.json` → `"en"`).
- Globs support `*` and `?` in the filename segment only — a single directory, non-recursive. A glob that matches nothing (or a missing directory) contributes zero files without error.
- Files are processed in sorted order; when two files define the same key + locale, the file that sorts later wins.
- `jsonFileSource(config)` is the factory equivalent when you prefer declarative configuration.

### Loading Content Files

The simple case: one file per key per locale for rich content such as email templates. With this layout:

```text
content/emails/
├── en.signup-email.html
└── nl.signup-email.html
```

`en.signup-email.html`:

```html
<p>Welcome, ${name}!</p>
```

`nl.signup-email.html`:

```html
<p>Welkom, ${name}!</p>
```

```typescript
import { Translator, ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({
    paths: ["./content/emails"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(translator.translate("signup-email", "en", { name: "Alice" }));
// → "<p>Welcome, Alice!</p>"

console.log(translator.translate("signup-email", "nl", { name: "Alice" }));
// → "<p>Welkom, Alice!</p>"
```

Next level — restrict the source to specific extensions, e.g. Markdown pages. With this layout:

```text
content/pages/
└── en.auth.welcome.md   → key "auth.welcome", locale "en"
```

`en.auth.welcome.md` contains:

```markdown
# Welcome to the auth section
```

```typescript
import { Translator, ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({
    paths: ["./content/pages"],
    extensions: [".md"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(translator.translate("auth.welcome", "en"));
// → "# Welcome to the auth section"
```

How filenames map to catalog entries:

| Filename | Locale | Key |
|---|---|---|
| `en.signup-email.html` | `en` | `signup-email` |
| `nl.signup-email.html` | `nl` | `signup-email` |
| `en.auth.welcome.md` | `en` | `auth.welcome` — middle segments join with `.` |

What's worth knowing:

- The convention is `<locale>.<key>.<ext>`; filenames with fewer than three dot-segments, an empty locale, or an unsupported extension are silently skipped.
- Content is read as-is — whitespace, markup, and `${...}` placeholders survive, and interpolation happens in `translate()` at render time.
- The default extensions are `[".html", ".md", ".txt"]`; a custom list replaces the defaults.
- `contentFileSource(config)` is the factory equivalent.

### Merging Catalogs

The simple case: merge two catalogs — for duplicate key + locale pairs, the later one wins.

```typescript
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const defaults: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
};

const overrides: TranslationCatalog = {
    greeting: { en: "Hey there" },
};

const merged = mergeCatalogs([defaults, overrides]);

console.log(merged.greeting); // → { en: "Hey there", nl: "Hallo" } — "en" overridden, "nl" preserved
console.log(merged.farewell); // → { en: "Goodbye", nl: "Tot ziens" } — untouched
```

Next level — layer file-based defaults under runtime overrides:

```typescript
import { Translator, JsonFileSource, mergeCatalogs } from "blendsdk/i18n-node";
import type { TranslationCatalog } from "blendsdk/i18n-node";

const fileSource = new JsonFileSource({ paths: ["./translations/*.json"] });
const fileCatalog = await fileSource.load();

const overrides: TranslationCatalog = {
    greeting: { en: "Hey there" },
};

const translator = new Translator({
    defaultLocale: "en",
    catalog: mergeCatalogs([fileCatalog, overrides]),
});

console.log(translator.translate("greeting", "en")); // → "Hey there"
console.log(translator.translate("greeting", "nl")); // → "Hallo" — from the JSON files, untouched by the overrides
```

What's worth knowing:

- Merging is per key + locale: only the locales present in a later catalog are overridden; the rest are preserved.
- Inputs are never mutated — the result contains copied entries, so it is safe to reuse catalogs.
- Priority is array order: the last catalog wins.
- `mergeCatalogs` lives in the browser-safe core and is re-exported from `blendsdk/i18n-node`, so it can share one import with the file sources.

### Exporting Translations for Clients

The simple case: export a flat `{ key: value }` map for one locale — ideal for serving translations to a frontend.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
        "cart.items": {
            en: ["${count} item", "${count} items"],
            nl: ["${count} artikel", "${count} artikelen"],
        },
    },
});

const dutch = translator.getTranslationsForLocale("nl");

console.log(dutch);
// → {
//     greeting: "Hallo ${name}",
//     "cart.items": ["${count} artikel", "${count} artikelen"]
//   }
```

Next level — build a payload for several locales at once:

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationValue } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
    },
});

const locales = ["en", "nl"];
const payload: Record<string, Record<string, TranslationValue>> = {};

for (const locale of locales) {
    payload[locale] = translator.getTranslationsForLocale(locale);
}

console.log(Object.keys(payload)); // → ["en", "nl"]
console.log(payload.nl.greeting);  // → "Hallo"
```

What's worth knowing:

- Strings are exported as templates: `${...}` placeholders stay intact, and the client interpolates them at render time.
- Plural tuples stay whole, so clients can select the form dynamically from `count`.
- Fallback is applied per key, and keys that cannot be resolved for the locale are omitted.
- Unknown locales return an empty object (`{}`) — omit them from the payload.

### Reloading Without Restart

The simple case: replace the whole catalog in one operation.

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: { greeting: { en: "Hello", nl: "Hallo" } },
});

const fresh: TranslationCatalog = { greeting: { en: "Hi", nl: "Hoi" } };
translator.setCatalog(fresh);

console.log(translator.translate("greeting", "nl")); // → "Hoi"
```

Next level — rebuild from the current catalog so untouched keys survive:

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
        farewell: { en: "Goodbye", nl: "Tot ziens" },
    },
});

const overrides: TranslationCatalog = { greeting: { nl: "Hoi" } };

// Build the replacement fully, then swap it in as one operation:
translator.setCatalog(mergeCatalogs([translator.getCatalog(), overrides]));

console.log(translator.translate("greeting", "nl")); // → "Hoi" — overridden
console.log(translator.translate("farewell", "nl")); // → "Tot ziens" — preserved
```

What's worth knowing:

- `setCatalog()` is a single reference swap: translations already in flight use the old catalog; calls that begin after the swap use the new one.
- Build and validate the replacement catalog **before** swapping — a failed load should never leave the translator in a partial state.
- The typical reload flow is: load from sources → layer with `mergeCatalogs` → `setCatalog`.

---

## Configuration

### Translator Options (`TranslatorConfig`)

| Name | Type | Default | Description |
|---|---|---|---|
| `defaultLocale` | `string` | `"en"` | Locale used when `translate()` is called without one. |
| `catalog` | `TranslationCatalog` | `{}` | Initial catalog. Can be empty when translations are loaded via sources. |
| `onMissingTranslation` | `(key: string, locale: string) => void` | `undefined` | Callback invoked whenever a key or locale value cannot be resolved. |

All three options together:

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
};

const translator = new Translator({
    defaultLocale: "nl",
    catalog,
    onMissingTranslation: (key: string, locale: string): void => {
        console.warn(`Missing translation "${key}" for locale "${locale}"`);
    },
});

console.log(translator.translate("greeting", undefined, { name: "Alice" }));
// → "Hallo Alice" — defaultLocale used because no locale was passed
```

### JsonFileSource Options (`JsonFileSourceConfig`)

| Name | Type | Default | Description |
|---|---|---|---|
| `paths` | `string[]` | required | JSON file paths and/or glob patterns. Globs use `*` and `?` in the filename segment (single directory, non-recursive). |

### ContentFileSource Options (`ContentFileSourceConfig`)

| Name | Type | Default | Description |
|---|---|---|---|
| `paths` | `string[]` | required | Directory paths and/or glob patterns to scan. Directory listings are non-recursive. |
| `extensions` | `string[]` | `[".html", ".md", ".txt"]` | File extensions to load, normalized to a leading dot and lowercase. A custom list replaces the defaults. |

Source configuration in practice:

```typescript
import { JsonFileSource, ContentFileSource } from "blendsdk/i18n-node";

const jsonSource = new JsonFileSource({
    paths: ["./translations/*.json", "./translations/overrides.json"],
});

const contentSource = new ContentFileSource({
    paths: ["./content/emails", "./content/pages/*.md"],
    extensions: [".html", ".md"],
});

console.log(jsonSource.name);    // → "JsonFileSource"
console.log(contentSource.name); // → "ContentFileSource"
```

---

## Error Handling

`blendsdk/i18n` defines no custom error classes. Loading failures surface as standard `Error` instances with descriptive messages — Node.js file-system errors keep their original error code (`ENOENT`, `EACCES`, …) — and translation lookups never throw: a key that cannot be resolved is returned as-is, with `onMissingTranslation` as the reporting hook.

### Errors You Can Catch

| Error | Thrown by | Message | Meaning |
|---|---|---|---|
| JSON parse failure | `JsonFileSource.load()` | `Failed to parse JSON file "<path>": <reason>` | A configured file is not valid JSON. |
| Locale not derivable | `JsonFileSource.load()` | `Cannot determine locale from filename "<filename>"` | A single-locale file has no usable locale segment before the `.json` extension. |
| File not found | `JsonFileSource.load()` | Node.js error with code `ENOENT` | A plain (non-glob) configured path does not exist. |
| File read failure | `JsonFileSource.load()`, `ContentFileSource.load()` | Node.js error (e.g. code `EACCES`) | A matched file exists but cannot be read — permissions or I/O. |

### Situations That Never Throw

| Situation | Behavior |
|---|---|
| Glob pattern matches no files, or the directory does not exist | `load()` resolves normally with no contributions from that path |
| Content filename does not match `<locale>.<key>.<ext>` | File is silently skipped |
| Content file extension is not in the configured list | File is silently skipped |
| `translate()` with an unknown key | Key returned as-is; `onMissingTranslation` invoked if configured |
| `translate()` with a locale that has no value | Key returned as-is; `onMissingTranslation` invoked if configured |
| `getTranslationsForLocale()` with an unknown locale | Returns `{}` |

### Failing Fast at Startup

When translations are essential, let the error propagate and stop the startup sequence:

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({ paths: ["./translations/en.json"] });

try {
    const catalog = await source.load();
    const translator = new Translator({ defaultLocale: "en", catalog });
    console.log(translator.translate("greeting", "en", { name: "Alice" }));
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not load translations from ${source.name}: ${message}`);
}
```

### Degrading Gracefully

When translations are an enhancement rather than a requirement, fall back to an empty catalog — the application keeps running, and unresolved keys render as their key names:

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";
import type { TranslationCatalog } from "blendsdk/i18n";

const source = new JsonFileSource({ paths: ["./translations/*.json"] });
let catalog: TranslationCatalog = {};

try {
    catalog = await source.load();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Falling back to an empty catalog (${source.name}): ${message}`);
}

const translator = new Translator({ defaultLocale: "en", catalog });

console.log(translator.translate("greeting", "en", { name: "Alice" }));
// → "greeting" when loading failed and the catalog is empty
```

Custom `TranslationSource` implementations should follow the same contract: throw a descriptive `Error` when the backend is unavailable, so failures surface at the call site instead of degrading silently. Pair `onMissingTranslation` with your logging setup to catch translation gaps that slip through at runtime.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
