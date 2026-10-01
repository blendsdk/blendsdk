> **Package**: `blendsdk/i18n`

# i18n Best Practices

This guide collects the practices that keep `blendsdk/i18n` usage correct, performant, and safe — from matching imports to the right runtime, to treating catalogs as immutable snapshots, to handling the library's deliberately silent failure modes. Each pair below shows the problematic pattern (❌ Wrong), the recommended pattern (✅ Correct), and the reason the recommendation exists. A consolidated anti-pattern list, performance guidance, and security considerations follow.

---

## Do / Don't Pairs

### Import file-based sources from the Node.js entry point only

**❌ Wrong**

```typescript
// frontend/catalog.ts — bundled for the browser
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({ paths: ["./translations/*.json"] });
const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });

console.log(translator.translate("greeting", "en"));
```

**✅ Correct**

```typescript
// frontend/catalog.ts — browser bundle, core entry point only
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
    },
});

console.log(translator.translate("greeting", "nl")); // "Hallo"
```

```typescript
// server/translations.ts — Node.js entry point for file-based sources
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({ paths: ["./translations/*.json"] });
const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });

console.log(translator.translate("greeting", "nl"));
```

**Why it matters:** `blendsdk/i18n-node` imports `node:fs/promises` and `node:path`. Pulling it into a browser bundle either fails the build (Webpack 5, Vite, and esbuild do not resolve `node:*` by default) or ships polyfills you do not want. The file-based sources can never work in a browser anyway. The reverse mistake — importing `JsonFileSource` from the core entry point — fails at compile time because it is not exported there. In browsers, provide catalogs inline (server-rendered or embedded) or implement a fetch-backed `TranslationSource`.

---

### Create one Translator per application, not per call

**❌ Wrong**

```typescript
import { Translator } from "blendsdk/i18n";

// A fresh instance — and a fresh catalog — on every call
export function formatGreeting(locale: string, name: string): string {
    const translator = new Translator({
        defaultLocale: "en",
        catalog: {
            greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
        },
    });
    return translator.translate("greeting", locale, { name });
}
```

**✅ Correct**

```typescript
import { Translator } from "blendsdk/i18n";

// One instance, created once, shared by all call sites
export const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
    },
});

export function formatGreeting(locale: string, name: string): string {
    return translator.translate("greeting", locale, { name });
}

console.log(formatGreeting("nl", "Alice")); // "Hallo Alice"
```

**Why it matters:** every per-call instance re-allocates the catalog object and starts with an empty locale-parse cache, so every call pays the locale-parsing cost again. Worse, when a reload calls `setCatalog()`, only the instance that was swapped sees the update — per-call instances keep constructing translations from the old literal, and different parts of the app silently serve different vintages of content.

---

### Treat the catalog as immutable — update it with setCatalog

**❌ Wrong**

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: { greeting: { en: "Hello", nl: "Hallo" } },
});

// Reaching into the live catalog and editing it in place
const catalog = translator.getCatalog();
catalog.greeting.en = "Hi";
catalog.farewell = { en: "Goodbye" };

console.log(translator.translate("greeting", "en")); // "Hi" — live, but by accident
```

**✅ Correct**

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: { greeting: { en: "Hello", nl: "Hallo" } },
});

const updates: TranslationCatalog = {
    greeting: { en: "Hi" },
    farewell: { en: "Goodbye" },
};

// Build the complete replacement first; swap it in with one reference assignment
translator.setCatalog(mergeCatalogs([translator.getCatalog(), updates]));

console.log(translator.translate("greeting", "en")); // "Hi"
console.log(translator.translate("greeting", "nl")); // "Hallo" — preserved
console.log(translator.translate("farewell", "en")); // "Goodbye" — added
```

**Why it matters:** in-place mutation technically "works" — the translator holds the same object reference — which is exactly the hazard. There is no atomic boundary: a request that resolves several keys can render a mix of old and new values. Nothing signals components that cache derived data (such as per-locale client exports) that the catalog changed, and `getCatalog()` is documented as a testing/debugging accessor, not a mutable handle. `setCatalog()` makes updates explicit, complete, and atomic.

---

### Ship a base-language entry and layer regional variants on top

**❌ Wrong**

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en_GB: "Hello, mate" },
    },
});

console.log(translator.translate("greeting", "en_GB")); // "Hello, mate"
console.log(translator.translate("greeting", "en"));    // "greeting" — key returned!
```

**✅ Correct**

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate" },
    },
});

console.log(translator.translate("greeting", "en_GB")); // "Hello, mate" — exact match wins
console.log(translator.translate("greeting", "en_AU")); // "Hello" — region falls back
console.log(translator.translate("greeting", "en"));    // "Hello"
```

**Why it matters:** the fallback chain moves from specific to general only (`en_GB` → `en`). It never upgrades: a request for `en` can never reach an `en_GB`-only entry. If regional entries are the *only* entries, every base-language request misses and the raw key leaks into the UI. Treat regional entries as sparse overrides; keep the base language complete so fallback always lands on something.

---

### Keep translation keys flat with dot notation, never nested objects

**❌ Wrong**

`translations/nested.json`:

```json
{
    "auth": {
        "login": "Log in",
        "logout": "Log out"
    }
}
```

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({ paths: ["./translations/nested.json"] });
const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });

console.log(JSON.stringify(translator.getCatalog()));
// {"auth":{"login":"Log in","logout":"Log out"}} — "login"/"logout" were read as locales
console.log(translator.translate("auth.login", "en")); // "auth.login" — never resolves
```

**✅ Correct**

`translations/app.json`:

```json
{
    "auth.login": { "en": "Log in", "nl": "Inloggen" },
    "auth.logout": { "en": "Log out", "nl": "Uitloggen" }
}
```

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({ paths: ["./translations/app.json"] });
const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });

console.log(translator.translate("auth.login", "nl")); // "Inloggen"
```

**Why it matters:** the catalog is a flat map by definition, and `JsonFileSource` detects the multi-locale format by inspecting the first value — a plain object means "this is a locale map". Nested JSON therefore parses without error but produces garbage: `auth` becomes a key whose "locales" are `login` and `logout`. Nothing throws; the structure is simply misinterpreted. Namespace with dot notation in the key instead (the same applies to flat single-locale files: `{ "auth.login": "Log in" }`).

---

### Name single-locale JSON files after their locale

**❌ Wrong**

```text
translations/
└── strings.json
```

```json
{
    "greeting": "Hello"
}
```

```typescript
import { JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({ paths: ["./translations/strings.json"] });
const catalog = await source.load();

console.log(JSON.stringify(catalog.greeting));
// {"strings":"Hello"} — the locale is literally "strings"
```

**✅ Correct**

```text
translations/
├── en.json
└── nl.json
```

```typescript
import { JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({ paths: ["./translations/*.json"] });
const catalog = await source.load();

console.log(JSON.stringify(catalog.greeting));
// {"en":"Hello","nl":"Hallo"} — locale from each filename
```

**Why it matters:** in single-locale format the locale is derived from the filename's last dot-segment (`en.json` → `"en"`, `strings.nl.json` → `"nl"`). A file named `strings.json` silently registers every value under the locale `"strings"` — the catalog looks plausible, but every `translate(..., "en")` call misses. If you cannot encode the locale in the filename, use multi-locale format instead.

---

### Never mix multi-locale and single-locale values in one file

**❌ Wrong**

```json
{
    "greeting": { "en": "Hello", "nl": "Hallo" },
    "farewell": "Goodbye"
}
```

**✅ Correct**

```json
{
    "greeting": { "en": "Hello", "nl": "Hallo" },
    "farewell": { "en": "Goodbye", "nl": "Tot ziens" }
}
```

**Why it matters:** format detection examines only the **first** value in the file. Here the first value is an object, so the whole file is treated as multi-locale — and the string `"Goodbye"` is then iterated as if it were a locale map, producing character-indexed garbage (`{ "0": "G", "1": "o", ... }`). No error is raised. Keep every file internally consistent: either all values are `{ locale: value }` objects (multi-locale), or all values are flat scalars with the locale coming from the filename.

---

### Follow the `<locale>.<key>.<ext>` convention for content files

**❌ Wrong**

```text
content/emails/
├── signup-email.en.html   ← locale in the wrong position
└── welcome.html           ← only two segments: silently skipped
```

```typescript
import { ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({ paths: ["./content/emails"] });
const catalog = await source.load();

console.log(JSON.stringify(catalog));
// {"en":{"signup-email":"<p>Welcome!</p>"}}
// key "en", locale "signup-email" — and welcome.html vanished without an error
```

**✅ Correct**

```text
content/emails/
├── en.signup-email.html
└── nl.signup-email.html
```

```typescript
import { Translator, ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({ paths: ["./content/emails"] });
const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });

console.log(translator.translate("signup-email", "nl", { name: "Alice" }));
// "<p>Welkom, Alice!</p>"
```

**Why it matters:** `ContentFileSource` parses the filename mechanically: first dot-segment is the locale, last is the extension, and everything in between joins with dots to form the key (so `en.auth.welcome.md` correctly maps to key `auth.welcome`). Getting the order wrong produces a valid-looking but useless catalog, and files with fewer than three segments — or an empty first segment, like dot-files — are skipped without any error. After adding or renaming content files, assert that the expected keys appear in the loaded catalog.

---

### Translate whole sentences with placeholders, not fragments

**❌ Wrong**

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        hello: { en: "Hello", nl: "Hallo" },
        "you-have": { en: "you have", nl: "je hebt" },
        items: { en: "items", nl: "artikelen" },
    },
});

const name = "Alice";
const message =
    translator.translate("hello", "nl") + " " + name + ", " +
    translator.translate("you-have", "nl") + " 3 " +
    translator.translate("items", "nl");

console.log(message); // "Hallo Alice, je hebt 3 artikelen"
```

**✅ Correct**

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "cart.summary": {
            en: "Hello ${name}, you have ${count} items",
            nl: "Hallo ${name}, je hebt ${count} artikelen",
        },
    },
});

console.log(translator.translate("cart.summary", "nl", { name: "Alice", count: 3 }));
// "Hallo Alice, je hebt 3 artikelen"
```

**Why it matters:** this example happens to read correctly in Dutch and English, but the concatenation order is fixed by the English source. Languages with different constituent order, case inflection, or grammatical gender cannot be assembled from fragments — translators see words, not sentences, and have no control over the result. Keep one key per complete sentence and let `${...}` placeholders carry the dynamic parts.

---

### Drive plural selection with a numeric count parameter

**❌ Wrong**

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        book: { en: ["${count} book", "${count} books"] },
    },
});

// count arrived from a query string — a string, not a number
console.log(translator.translate("book", "en", { count: "5" }));
// "5 book" — non-numeric count selects the singular form
```

**✅ Correct**

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        book: { en: ["${count} book", "${count} books"] },
    },
});

function translateBooks(rawCount: string): string {
    const count = Number(rawCount);
    if (!Number.isFinite(count)) {
        throw new Error(`Invalid count: "${rawCount}"`);
    }
    return translator.translate("book", "en", { count });
}

console.log(translateBooks("1")); // "1 book"
console.log(translateBooks("5")); // "5 books"

try {
    translateBooks("many");
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // 'Invalid count: "many"'
}
```

**Why it matters:** plural selection reads exactly one thing — `params.count` — and only acts on it when it is a valid number. A string `"5"` still interpolates into `${count}`, so the output *looks* plausible while always using the singular form. `NaN` is worse: it selects singular and prints the literal text "NaN" into the sentence. Validate and convert numeric input at the boundary; never pass raw user input into a plural argument.

---

### Handle missing translations deliberately — the key is returned, never an empty string

**❌ Wrong**

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: { greeting: { en: "Hello", nl: "Hallo" } },
});

const label = translator.translate("farewell", "de");

if (label === "") {
    console.error("Missing translation!");
} else {
    console.log(label); // "farewell" — the raw key is shown to the user
}
```

**✅ Correct**

```typescript
import { Translator } from "blendsdk/i18n";

const missingKeys = new Set<string>();

const translator = new Translator({
    defaultLocale: "en",
    catalog: { greeting: { en: "Hello", nl: "Hallo" } },
    onMissingTranslation: (key: string, locale: string): void => {
        missingKeys.add(`${locale}:${key}`);
    },
});

const label = translator.translate("farewell", "de");
console.log(label); // "farewell" — key returned as the built-in fallback

if (!translator.hasKey("farewell", "de")) {
    // Branch deliberately: hide the label, render an icon, or flag the gap to tooling
    console.log("no translation available — render the component without it");
}

console.log([...missingKeys]); // ["de:farewell"]
```

**Why it matters:** a failed lookup never returns `""` — it returns the key itself, by design, so the app keeps running and gaps are visible. Checking for an empty string therefore never fires, and the raw key silently reaches production UI. Use the `onMissingTranslation` callback to collect gaps (log them in development, count them in production), and `hasKey(key, locale)` when a component must branch on availability. Note that `hasKey` applies the same fallback chain as `translate`, so it will not report a key as missing when it can legitimately fall back.

---

### Order mergeCatalogs inputs from least to most authoritative

**❌ Wrong**

```typescript
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const fileDefaults: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
};

const databaseOverrides: TranslationCatalog = {
    greeting: { en: "Hi there" },
};

// Overrides listed first — they lose to the defaults
const merged = mergeCatalogs([databaseOverrides, fileDefaults]);

console.log(merged.greeting.en); // "Hello" — the override was silently discarded
```

**✅ Correct**

```typescript
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const fileDefaults: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
};

const databaseOverrides: TranslationCatalog = {
    greeting: { en: "Hi there" },
};

// Priority order: most authoritative catalog last
const merged = mergeCatalogs([fileDefaults, databaseOverrides]);

console.log(merged.greeting.en); // "Hi there"
console.log(merged.greeting.nl); // "Hallo" — untouched locales are preserved
```

**Why it matters:** `mergeCatalogs` is last-wins per key + locale. If the array order does not match the intended priority, overrides are silently discarded — no warning, no error, just the wrong string in production. Always read the array as a priority ladder: file defaults first, then API layers, then database overrides.

---

## Anti-Patterns

Most of these fail silently by design: sources skip non-matching files without complaining, and the translator returns the key instead of throwing. Quick reference first, then the three failure modes that cause the most debugging time.

| Anti-pattern | What actually happens | Do instead |
|---|---|---|
| Passing a single file path to `ContentFileSource.paths` | The path is treated as a directory; `readdir` fails and the error is swallowed → empty catalog | Pass the directory or a glob (`./content/*.html`) — see below |
| Passing a mutable catalog object to the constructor | The translator keeps the reference; later mutations change live translations | Hand over a catalog you never touch again — see below |
| `setCatalog(partialData)` on reload | Wholesale replacement: any key not in the partial data is gone (returned as the key) | Layer partial data with `mergeCatalogs` — see below |
| Nested JSON translation files | First-value object detection reads inner keys as locales | Flat, dot-notation keys |
| Mixing multi-locale and single-locale values in one file | Only the first value is inspected; string values get exploded into character maps | One consistent format per file |
| Content filenames not matching `<locale>.<key>.<ext>` | Two-segment names are skipped; swapped segments map to the wrong locale/key | Fix the filename convention; assert loaded keys |
| Setting `ContentFileSource.extensions` | The list replaces the defaults, so `.md`/`.txt` files silently drop out | List every extension you need (the default set is not additive) |
| Expecting `**` or multi-directory globs | Only single-directory `*`/`?` patterns are supported; non-existent pattern dirs yield zero files silently | Enumerate each directory explicitly |
| Naming the numeric parameter anything but `count` | Plural selection never triggers; the tuple always resolves to singular | Name it exactly `count` |
| Feeding raw `Accept-Language` headers or arbitrary strings as locales | Works by language fallback, but the per-instance locale cache accumulates every unique string forever | Canonicalize to a small supported set at the edge |
| Relying on `getTranslationsForLocale()` to pick plural forms | `[singular, plural]` tuples are returned as arrays | Select the form in the client, or use `translate()` server-side |
| Ignoring `NaN` counts | `count: NaN` selects singular and interpolates the literal `"NaN"` into the output | Validate with `Number.isFinite` before translating |

### Silent Empty Catalog: File Paths in ContentFileSource

```typescript
import { ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({
    paths: ["./content/emails/en.signup-email.html"], // a file, not a directory
});

const catalog = await source.load();
console.log(JSON.stringify(catalog)); // {} — the file path was treated as a directory
```

Non-glob entries in `paths` are treated as directories and listed. Listing a file path fails, the failure is caught, and you get `{}` with no error. Use the directory (`./content/emails`) or a glob (`./content/emails/*.html`). Note the asymmetry: `JsonFileSource` accepts plain file paths and *throws* when one is missing, while a glob that matches nothing contributes zero files silently — handle both behaviors explicitly around `load()`.

### Mutation-by-Reference: The Catalog You Hand Over Is Shared

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const sharedCatalog: TranslationCatalog = {
    greeting: { en: "Hello" },
};

const translator = new Translator({
    defaultLocale: "en",
    catalog: sharedCatalog,
});

// Somewhere else in the codebase, long after startup:
sharedCatalog.greeting.en = "Hi";

console.log(translator.translate("greeting", "en")); // "Hi" — live translation changed
```

The constructor stores the catalog by reference (that is what makes `setCatalog` atomic), so any code that retained the original object can mutate live translations without validation, ordering, or cache invalidation. Treat anything passed to the constructor as ownership-transferred: build fresh objects for updates and apply them with `setCatalog(mergeCatalogs([...]))`.

### Partial Reload: setCatalog Replaces, It Does Not Merge

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello" },
        farewell: { en: "Goodbye" },
    },
});

// A reload event that delivered only the override slice…
const overrides: TranslationCatalog = { greeting: { en: "Hi" } };
translator.setCatalog(overrides);

// …deletes everything the slice did not contain:
console.log(translator.translate("farewell", "en")); // "farewell" — key returned
```

If the catalog you are swapping in is complete, plain replacement is correct and cheapest. If it is partial — overrides, a single source, an incremental update — layer it instead:

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello" },
        farewell: { en: "Goodbye" },
    },
});

const overrides: TranslationCatalog = { greeting: { en: "Hi" } };

// Layer the partial update on top of the current catalog
translator.setCatalog(mergeCatalogs([translator.getCatalog(), overrides]));

console.log(translator.translate("greeting", "en")); // "Hi"
console.log(translator.translate("farewell", "en")); // "Goodbye" — preserved
```

---

## Performance Tips

The translation hot path is intentionally minimal: with a warm locale cache and a present key, `translate()` is a couple of object lookups plus string interpolation. The costs worth managing sit around the hot path:

| Operation | Cost profile | Guidance |
|---|---|---|
| `translate()` warm hit | Map/object lookups + `formatString` | Call freely |
| `translate()` with a never-seen locale string | Parse + `Map` insert (never evicted) | Pass canonical locale strings from a small set |
| `translate()` miss | `onMissingTranslation` callback invoked per call | Wire it in development; throttle/aggregate in production |
| `hasKey()` before every `translate()` | Doubles lookups on the common path | Use `hasKey` only when branching on availability |
| `setCatalog()` | Reference swap + clears the locale cache | Batch and coalesce reloads; never per-request |
| `getTranslationsForLocale()` | Full catalog walk on **every** call | Compute once per locale, cache, invalidate on reload |
| `JsonFileSource/ContentFileSource.load()` | Directory scan + `readFile` + parse per file | Startup/reload only |
| `mergeCatalogs()` | One pass per catalog, shallow entry copies | Load/reload time only |
| `new Translator()` | Allocates catalog ref, locale `Map`, config | Once per process |

### Keep one warm Translator per process

The locale-parse cache lives on the instance (see the Do/Don't pair above). Reusing a single translator keeps that cache warm for the lifetime of the process; constructing per request re-parses every locale string on every call and discards the cache immediately after.

### Canonicalize locale strings at the edge

The cache is keyed by the **raw input string**. `"en-GB"`, `"en_GB"`, and `"en_GB.UTF-8"` are three separate entries for the same locale, and raw `Accept-Language` headers or free-form user input create a new entry for every distinct string — the `Map` only shrinks when `setCatalog()` clears it, so a long-running process accumulates entries indefinitely. Normalize once, at the request boundary:

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate", nl: "Hallo" },
    },
});

const SUPPORTED_LOCALES = ["en", "en_GB", "nl"] as const;

/** Reduce arbitrary user input to a small, supported set of locale strings. */
function canonicalLocale(input: string): string {
    const requested = input.split(",")[0].trim().split(".")[0].replace("-", "_");
    const exact = SUPPORTED_LOCALES.find((locale) => locale === requested);
    if (exact) {
        return exact;
    }
    const language = requested.split("_")[0];
    const base = SUPPORTED_LOCALES.find((locale) => locale === language);
    return base ?? "en";
}

console.log(canonicalLocale("en-GB,en;q=0.9")); // "en_GB"
console.log(canonicalLocale("nl_NL"));           // "nl"
console.log(canonicalLocale("fr-FR"));           // "en" — unsupported → default

console.log(translator.translate("greeting", canonicalLocale("en-GB,en;q=0.9")));
// "Hello, mate" — one canonical cache entry, reused on every request
```

### Cache getTranslationsForLocale per locale

`getTranslationsForLocale()` resolves every key in the catalog on every call — the right shape for building client bundles, the wrong shape for a per-request API path. Compute it once per locale and invalidate when the catalog changes:

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationValue } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
        book: {
            en: ["${count} book", "${count} books"],
            nl: ["${count} boek", "${count} boeken"],
        },
    },
});

/** Per-locale flat exports, rebuilt only when the catalog changes. */
const clientCatalogs = new Map<string, Record<string, TranslationValue>>();

function catalogForClient(locale: string): Record<string, TranslationValue> {
    const cached = clientCatalogs.get(locale);
    if (cached) {
        return cached;
    }
    const built = translator.getTranslationsForLocale(locale);
    clientCatalogs.set(locale, built);
    return built;
}

function reload(overrides: TranslationCatalog): void {
    clientCatalogs.clear(); // invalidate every cached export in one step
    translator.setCatalog(mergeCatalogs([translator.getCatalog(), overrides]));
}

console.log(catalogForClient("nl").greeting); // "Hallo"

reload({ farewell: { en: "Goodbye", nl: "Tot ziens" } });
console.log(catalogForClient("nl").farewell); // "Tot ziens" — rebuilt on demand
```

The invalidation must be attached to `setCatalog` — which is another reason never to mutate the catalog in place (see Anti-Patterns): in-place edits bypass this cache and serve stale exports.

### Coalesce reloads; keep file I/O at startup

`setCatalog()` clears the locale cache, so each reload forces locale re-parsing on subsequent calls, and each `load()` re-reads and re-parses every matched file from disk. Reload storms — for example, one pub/sub message per changed translation file — multiply both costs and can interleave so that a slow load overwrites a newer one. Coalesce bursts into a single reload, build the replacement catalog completely before swapping, and keep the steady state in memory: load at startup, reload on explicit triggers, never in a request handler.

---

## Security Considerations

The library is deliberately small and does no escaping, no sanitization, and no sandboxing — those responsibilities sit with the caller. The considerations below follow directly from that design.

### Escape interpolated parameters for the output context

`translate()` performs plain textual substitution: `${param}` is replaced with the string form of the value, and `ContentFileSource` returns HTML, Markdown, or text exactly as stored. If any parameter is user-controlled and the result is rendered as HTML (emails being the most common case), you have a template-injection vector unless you escape first:

```typescript
import { Translator } from "blendsdk/i18n";

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "signup-email": { en: "<p>Welcome, ${name}!</p>" },
    },
});

const userName = '<img src=x onerror="alert(1)">';
const html = translator.translate("signup-email", "en", { name: escapeHtml(userName) });

console.log(html);
// "<p>Welcome, &lt;img src=x onerror=&quot;alert(1)&quot;&gt;!</p>"
```

Escape per context (HTML body, attribute, URL) before passing values as parameters — not the whole rendered output, which would escape the template's own markup. For non-HTML outputs, apply the escaping the target format requires.

### Validate catalogs from external sources before swapping

Catalogs loaded from a database, CMS, or remote API flow directly into rendered pages and emails. Treat them as untrusted input: bound their size, reject prototype-interacting keys (`__proto__`, `constructor`), and validate before calling `setCatalog()`. Catalog objects that carry such keys can interact with object-prototype semantics during merging and normalization, and an oversized feed is a cheap denial-of-service vector:

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: { greeting: { en: "Hello" } },
});

const MAX_KEYS = 10_000;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Reject catalogs that look malformed or that carry prototype-interacting keys. */
function validateCatalog(catalog: TranslationCatalog): TranslationCatalog {
    const keys = Object.keys(catalog);
    if (keys.length > MAX_KEYS) {
        throw new Error(`Rejected catalog: ${keys.length} keys exceeds limit of ${MAX_KEYS}`);
    }
    for (const key of keys) {
        if (UNSAFE_KEYS.has(key)) {
            throw new Error(`Rejected catalog: unsafe translation key "${key}"`);
        }
    }
    return catalog;
}

function applyReload(incoming: TranslationCatalog): void {
    const validated = validateCatalog(incoming);
    translator.setCatalog(mergeCatalogs([translator.getCatalog(), validated]));
}

applyReload({ farewell: { en: "Goodbye" } });
console.log(translator.translate("farewell", "en")); // "Goodbye"
```

Translation values from such sources are content: review them like code, because they render verbatim.

### Keep source paths static; never build them from request input

`JsonFileSource` and `ContentFileSource` resolve their `paths` with `resolve()` and read them with `readFile()` — `../` sequences are followed without complaint. Never interpolate request data (a locale from a query parameter, a tenant id from a header) into source paths. Keep the configured paths fully static, and if per-tenant directories are unavoidable, validate each segment against a strict allowlist before joining:

```typescript
function safeLocaleSegment(value: string): string {
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(value)) {
        throw new Error(`Rejected locale segment: "${value}"`);
    }
    return value;
}
```

### Protect the reload trigger and mind what you log

Reloads are typically triggered by pub/sub or an endpoint. Anyone who can publish on that channel can inject rendered content into your pages and emails — authenticate the channel, verify the publisher, and pass every incoming catalog through `validateCatalog` (above) before swapping. Logging hygiene follows the same reasoning: `onMissingTranslation` receives only the key and locale, which is safe to log, but if you extend that logging to include `params`, remember they routinely contain names, email addresses, and order identifiers — do not write them to shared logs.

---

## Related Documents

- Overview — package summary, entry points, and architecture
- Core Concepts — catalogs, locale fallback, plurals, sources
- Basic Usage — first-run walkthrough

---

# i18n Testing Patterns

This document shows how to test application code built on `blendsdk/i18n`. Every pattern here mirrors the package's own Vitest suite — `tests/translator.test.ts`, `tests/translator-catalog.test.ts`, `tests/merge-catalogs.test.ts`, `tests/json-file-source.test.ts`, and `tests/content-file-source.test.ts` — which is the source of truth for behavior. Because the package is runtime-agnostic, its tests are plain in-process tests: no Docker containers, no network access, and no external services are required. The only infrastructure used is local fixture directories for the two Node.js file sources.

---

## Test Setup

### Test Framework and Scripts

The package runs on **Vitest ^4.1.10** with ESM (`"type": "module"`) and TypeScript strict mode. The `test` and `test:fast` scripts are equivalent single runs; `test:watch` is for development.

| Script | Command | Purpose |
|---|---|---|
| `test` | `vitest run --reporter=verbose` | Single verbose run |
| `test:fast` | `vitest run --reporter=verbose` | Alias of `test` |
| `test:watch` | `vitest watch --reporter=verbose` | Re-run on file changes |

No custom Vitest configuration is required: tests are discovered with Vitest's default pattern (`**/*.test.ts`), relative imports use ESM `.js` specifiers (Vitest resolves them to the TypeScript sources, exactly like the package suite does with `../src/translator.js`), and the default Node test environment supports `node:fs/promises` and `node:path`. Consumer code should import the published entry points (`blendsdk/i18n` or `blendsdk/i18n-node`), never internal `src` paths.

### Required Imports

All imports your test files can draw from:

```typescript
// Test framework
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Browser-safe core — works in any environment
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type {
    TranslationCatalog,
    TranslationSource,
    TranslatorConfig,
} from "blendsdk/i18n";

// Node.js-only file sources — require the Node environment (the Vitest default)
import { JsonFileSource, jsonFileSource, ContentFileSource, contentFileSource } from "blendsdk/i18n-node";
import type { JsonFileSourceConfig, ContentFileSourceConfig } from "blendsdk/i18n-node";

// Fixture path resolution and temp directories
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
```

The package also exports the types `TranslationValue`, `TranslationEntry`, and `LocaleParts` (from both entry points) if your assertions need them.

### Test File Layout

The package's own suite maps one test file per module and shows which patterns to follow:

| Test file | Patterns it demonstrates |
|---|---|
| `tests/translator.test.ts` | Synchronous assertions, locale fallback, default locale, missing keys with a `vi.fn()` callback, plurals |
| `tests/translator-catalog.test.ts` | `getTranslationsForLocale()`, `hasKey()`, `setCatalog()`, `getCatalog()`, `getDefaultLocale()` |
| `tests/merge-catalogs.test.ts` | Pure-function tests, override order, copy semantics |
| `tests/json-file-source.test.ts` | Async `load()` against JSON fixtures, multi/single-locale format detection, globs, rejection |
| `tests/content-file-source.test.ts` | Async `load()` against content fixtures, filename convention, extension filtering, pipeline integration |

Conventions used throughout:

- One `describe` per unit under test (`describe("Translator", ...)`), nested `describe` blocks per behavior group (`"plural support"`, `"locale fallback"`).
- Test names read as specifications: `"should select singular for count=1"`.
- A fresh instance is constructed inside each `it` — never share a mutable `Translator` across tests (the package tests do this so `setCatalog()` calls cannot leak state).

| Component | Test style |
|---|---|
| `Translator`, `mergeCatalogs` | **Synchronous** — call, then assert directly (no `await`) |
| `TranslationSource.load()` implementations | **Asynchronous** — `await source.load()`, error paths via `await expect(...).rejects.toThrow(...)` |

### ESM Fixture Path Resolution

The package suite resolves fixture paths relative to each test file, since ESM has no `__dirname`. This block is repeated at the top of both file-source test files:

```typescript
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve fixture path relative to this test file */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, "fixtures");
const contentFixturesDir = resolve(__dirname, "content-fixtures");
```

### Shared Test Helpers

The package tests repeat a handful of setups — a shared catalog, a translator factory, and fixture directory resolution. Extract them into `tests/helpers.ts` to keep consumer test files short:

```typescript
// tests/helpers.ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource, TranslatorConfig } from "blendsdk/i18n";

/** Shared catalog mirroring the package's own test data. */
export const testCatalog: TranslationCatalog = {
    greeting: { en: "Hello ${name}", nl: "Hallo ${name}", en_GB: "Hello ${name}, mate" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
    book: {
        en: ["${count} book", "${count} books"],
        nl: ["${count} boek", "${count} boeken"],
    },
    "auth.login": { en: "Log in", nl: "Inloggen" },
};

/** Create a Translator pre-wired with the shared test catalog. */
export function createTranslator(config: TranslatorConfig = {}): Translator {
    return new Translator({
        defaultLocale: config.defaultLocale ?? "en",
        catalog: config.catalog ?? testCatalog,
        onMissingTranslation: config.onMissingTranslation,
    });
}

/** Minimal TranslationSource stub — no file system, no network. */
export class InMemorySource implements TranslationSource {
    readonly name = "InMemorySource";

    private readonly catalog: TranslationCatalog;

    constructor(catalog: TranslationCatalog) {
        this.catalog = catalog;
    }

    async load(): Promise<TranslationCatalog> {
        return this.catalog;
    }
}

/** Temporary directory helper for file-based integration tests. */
export interface TempFixtureDir {
    readonly path: string;
    write(fileName: string, content: string): Promise<string>;
    remove(): Promise<void>;
}

export async function createTempFixtureDir(): Promise<TempFixtureDir> {
    const path = await mkdtemp(join(tmpdir(), "blendsdk-i18n-test-"));
    return {
        path,
        async write(fileName: string, content: string): Promise<string> {
            const filePath = join(path, fileName);
            await writeFile(filePath, content, "utf-8");
            return filePath;
        },
        async remove(): Promise<void> {
            await rm(path, { recursive: true, force: true });
        },
    };
}
```

Import helpers with a `.js` specifier: `import { createTempFixtureDir, type TempFixtureDir } from "./helpers.js";`. One caution: if a test file mocks the `blendsdk/i18n` module with `vi.mock`, do not import helpers that construct real `Translator` instances in that same file.

### Environment Notes

| Requirement | Detail |
|---|---|
| Runtime | Node.js >= 22.0.0 for tests exercising `JsonFileSource` / `ContentFileSource` |
| Docker / services | **Not required** — no containers, databases, or network access |
| Filesystem | File-source tests need readable fixture directories (checked in, or created via `mkdtemp`) |
| Environment variables | None |
| Test environment | Vitest's default Node environment; `Translator` and `mergeCatalogs` tests are pure and would also run in browser-like environments |

---

## Unit Testing

### Synchronous Units: Translator and mergeCatalogs

Both are pure and synchronous — construct them with inline catalog literals and assert directly. This is the fastest possible test style and the one used throughout `tests/translator.test.ts`. The pattern is: **fresh instance per test, inline catalog, single expectation per behavior**.

```typescript
import { describe, expect, it } from "vitest";
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

describe("Translator", () => {
    it("should translate a simple key", () => {
        const translator = new Translator({
            catalog: { farewell: { en: "Goodbye", nl: "Tot ziens" } },
        });
        expect(translator.translate("farewell", "en")).toBe("Goodbye");
    });

    it("should interpolate parameters", () => {
        const translator = new Translator({
            catalog: { greeting: { en: "Hello ${name}", nl: "Hallo ${name}" } },
        });
        expect(translator.translate("greeting", "nl", { name: "Alice" })).toBe("Hallo Alice");
    });
});

describe("mergeCatalogs", () => {
    it("should merge catalogs with different keys", () => {
        const base: TranslationCatalog = { greeting: { en: "Hello" } };
        const extra: TranslationCatalog = { farewell: { en: "Goodbye" } };

        expect(mergeCatalogs([base, extra])).toEqual({
            greeting: { en: "Hello" },
            farewell: { en: "Goodbye" },
        });
    });
});
```

### Testing a Consumer Service with a Real Translator

For application code that consumes the package, prefer a **real** `Translator` over a mock — construction is cheap and the test exercises real fallback, plural, and interpolation behavior. Inject the translator through the constructor so tests control the catalog:

```typescript
// src/greeting-service.ts
import { Translator } from "blendsdk/i18n";

export class GreetingService {
    private readonly translator: Translator;

    constructor(translator: Translator) {
        this.translator = translator;
    }

    greet(name: string, locale: string): string {
        return this.translator.translate("greeting", locale, { name });
    }
}
```

```typescript
// tests/greeting-service.test.ts
import { describe, expect, it } from "vitest";
import { GreetingService } from "../src/greeting-service.js";
import { createTranslator } from "./helpers.js";

describe("GreetingService", () => {
    it("should greet in the requested locale", () => {
        const service = new GreetingService(
            createTranslator({
                catalog: { greeting: { en: "Hello ${name}", nl: "Hallo ${name}" } },
            })
        );

        expect(service.greet("Alice", "en")).toBe("Hello Alice");
        expect(service.greet("Alice", "nl")).toBe("Hallo Alice");
    });
});
```

### Asynchronous Units: Translation Sources

Every `TranslationSource.load()` returns a `Promise<TranslationCatalog>`, so source tests are async. Even in unit tests, stubs should return a promise (`async load()`) to match the contract:

```typescript
import { describe, expect, it } from "vitest";
import { Translator } from "blendsdk/i18n";
import { InMemorySource } from "./helpers.js";

describe("translation loading", () => {
    it("should build a translator from a source catalog", async () => {
        const source = new InMemorySource({ greeting: { en: "Hello", nl: "Hallo" } });
        const catalog = await source.load();
        const translator = new Translator({ defaultLocale: "en", catalog });

        expect(translator.translate("greeting", "nl")).toBe("Hallo");
    });
});
```

### Error Paths

Two rules of thumb, straight from the package behavior:

- **`Translator` never throws.** When a key or locale cannot be resolved it returns the key itself and (optionally) fires `onMissingTranslation`. Assert the returned key and the callback invocation — do not write rejection tests for `translate()`.
- **Sources throw on failure.** `JsonFileSource` rejects for missing plain paths and unparseable JSON; `ContentFileSource` rejects when a matched file cannot be read. Assert with `rejects.toThrow()`.

```typescript
import { describe, expect, it } from "vitest";
import { JsonFileSource } from "blendsdk/i18n-node";

describe("source failure handling", () => {
    it("should reject when a plain JSON path does not exist", async () => {
        const source = new JsonFileSource({ paths: ["./does-not-exist.json"] });
        await expect(source.load()).rejects.toThrow();
    });
});
```

---

## Integration Testing

Integration tests for `blendsdk/i18n` mean: **real source instances reading real files**, and the **full pipeline** of sources → `mergeCatalogs` → `Translator`. There is no external infrastructure to stand up — fixtures are plain files next to the tests.

### Fixture Layout

The package keeps two fixture directories beside its test files. Create an equivalent set in your own project:

```text
tests/
├── translator.test.ts
├── translator-catalog.test.ts
├── merge-catalogs.test.ts
├── json-file-source.test.ts
├── content-file-source.test.ts
├── fixtures/                      ← JSON fixtures for JsonFileSource tests
│   ├── multi-locale.json
│   ├── override.json
│   ├── en.json
│   └── nl.json
└── content-fixtures/              ← content files for ContentFileSource tests
    ├── en.signup-email.html
    ├── nl.signup-email.html
    ├── en.auth.welcome.html
    ├── en.welcome-page.md
    ├── nl.welcome-page.md
    ├── en.privacy-policy.txt
    ├── en.some-data.json
    ├── readme.txt                 ← intentionally 2 segments (skipped)
    └── .hidden-file.html          ← intentionally hidden (skipped)
```

`tests/fixtures/multi-locale.json` (multi-locale format — first value is an object):

```json
{
    "greeting": { "en": "Hello ${name}", "nl": "Hallo ${name}" },
    "farewell": { "en": "Goodbye", "nl": "Tot ziens" },
    "book": {
        "en": ["${count} book", "${count} books"],
        "nl": ["${count} boek", "${count} boeken"]
    }
}
```

`tests/fixtures/en.json` (single-locale format — first value is a string, locale from filename):

```json
{
    "greeting": "Hello",
    "farewell": "Goodbye",
    "welcome": "Welcome to our app"
}
```

`tests/fixtures/nl.json`:

```json
{
    "greeting": "Hallo",
    "farewell": "Tot ziens",
    "welcome": "Welkom bij onze app"
}
```

`tests/fixtures/override.json` (used to test last-wins merge order):

```json
{
    "greeting": { "en": "Hi ${name}", "nl": "Hoi ${name}" }
}
```

`tests/content-fixtures/en.signup-email.html`:

```html
<html>
<body>
<p>Welcome, ${name}!</p>
<a href="${activationUrl}">Activate your account</a>
</body>
</html>
```

`tests/content-fixtures/nl.signup-email.html`:

```html
<p>Welkom, ${name}!</p>
```

`tests/content-fixtures/en.welcome-page.md` (and `nl.welcome-page.md` with `# Welkom`):

```markdown
# Welcome

Welcome to our app.
```

`tests/content-fixtures/en.privacy-policy.txt`:

```text
Privacy Policy

Your privacy is important to us.
```

### JsonFileSource Integration Tests

These mirror `tests/json-file-source.test.ts` — async tests against real fixture files, including format auto-detection, glob resolution, override order, and error paths:

```typescript
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonFileSource } from "blendsdk/i18n-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

describe("JsonFileSource integration", () => {
    it("should load a multi-locale file into normalized entries", async () => {
        const source = new JsonFileSource({
            paths: [resolve(fixturesDir, "multi-locale.json")],
        });
        const catalog = await source.load();

        expect(catalog.greeting).toEqual({ en: "Hello ${name}", nl: "Hallo ${name}" });
        expect(catalog.book).toEqual({
            en: ["${count} book", "${count} books"],
            nl: ["${count} boek", "${count} boeken"],
        });
    });

    it("should derive the locale from the filename for single-locale files", async () => {
        const source = new JsonFileSource({
            paths: [resolve(fixturesDir, "en.json"), resolve(fixturesDir, "nl.json")],
        });
        const catalog = await source.load();

        expect(catalog.greeting).toEqual({ en: "Hello", nl: "Hallo" });
        expect(catalog.welcome).toEqual({
            en: "Welcome to our app",
            nl: "Welkom bij onze app",
        });
    });

    it("should resolve *.json glob patterns", async () => {
        const source = new JsonFileSource({ paths: [resolve(fixturesDir, "*.json")] });
        const catalog = await source.load();

        expect(Object.keys(catalog).length).toBeGreaterThan(0);
        expect(catalog.greeting).toBeDefined();
    });

    it("should merge multiple files with later files overriding earlier ones", async () => {
        const source = new JsonFileSource({
            paths: [
                resolve(fixturesDir, "multi-locale.json"),
                resolve(fixturesDir, "override.json"),
            ],
        });
        const catalog = await source.load();

        expect(catalog.greeting.en).toBe("Hi ${name}");
        expect(catalog.greeting.nl).toBe("Hoi ${name}");
        expect(catalog.farewell.en).toBe("Goodbye");
    });

    it("should return an empty catalog when a glob matches nothing", async () => {
        const source = new JsonFileSource({
            paths: [resolve(fixturesDir, "nonexistent/*.json")],
        });
        await expect(source.load()).resolves.toEqual({});
    });

    it("should reject when a plain file path does not exist", async () => {
        const source = new JsonFileSource({
            paths: [resolve(fixturesDir, "does-not-exist.json")],
        });
        await expect(source.load()).rejects.toThrow();
    });
});
```

Note the asymmetry to test explicitly: a **glob whose directory does not exist** yields `{}` (no error), while a **plain path to a missing file** rejects.

### ContentFileSource Integration Tests

These mirror `tests/content-file-source.test.ts` — filename convention parsing, extension filtering, skipped files, and determinism:

```typescript
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentFileSource, contentFileSource } from "blendsdk/i18n-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentFixturesDir = resolve(__dirname, "content-fixtures");

describe("ContentFileSource integration", () => {
    it("should load the same key for multiple locales", async () => {
        const source = new ContentFileSource({
            paths: [contentFixturesDir],
            extensions: [".html"],
        });
        const catalog = await source.load();

        expect(catalog["signup-email"]["en"]).toContain("Welcome, ${name}!");
        expect(catalog["signup-email"]["nl"]).toContain("Welkom, ${name}!");
    });

    it("should join middle filename segments into dot-notation keys", async () => {
        const source = new ContentFileSource({
            paths: [contentFixturesDir],
            extensions: [".html"],
        });
        const catalog = await source.load();

        expect(catalog["auth.welcome"]).toBeDefined();
        expect(catalog["auth.welcome"]["en"]).toContain("Welcome to the auth section");
    });

    it("should preserve content as-is, including markup and placeholders", async () => {
        const source = new ContentFileSource({
            paths: [contentFixturesDir],
            extensions: [".html"],
        });
        const catalog = await source.load();

        const english = catalog["signup-email"]["en"];
        expect(english).toContain("<html>");
        expect(english).toContain("${activationUrl}");
        expect(english).toContain("\n");
    });

    it("should skip files without a key segment and hidden dot-files", async () => {
        const txtSource = new ContentFileSource({
            paths: [contentFixturesDir],
            extensions: [".txt"],
        });
        const txtCatalog = await txtSource.load();
        expect(txtCatalog["readme"]).toBeUndefined(); // only 2 segments
        expect(txtCatalog["privacy-policy"]).toBeDefined();

        const htmlSource = new ContentFileSource({
            paths: [contentFixturesDir],
            extensions: [".html"],
        });
        const htmlCatalog = await htmlSource.load();
        expect(htmlCatalog["hidden-file"]).toBeUndefined(); // empty locale segment
    });

    it("should return an empty catalog for non-existent directories and unmatched globs", async () => {
        const missingDir = new ContentFileSource({
            paths: [resolve(contentFixturesDir, "no-such-dir")],
        });
        const noMatch = new ContentFileSource({
            paths: [resolve(contentFixturesDir, "*.xml")],
        });

        await expect(missingDir.load()).resolves.toEqual({});
        await expect(noMatch.load()).resolves.toEqual({});
    });

    it("should produce identical catalogs for repeated loads (deterministic ordering)", async () => {
        const first = await new ContentFileSource({ paths: [contentFixturesDir] }).load();
        const second = await new ContentFileSource({ paths: [contentFixturesDir] }).load();

        expect(first).toEqual(second);
    });

    it("should create a working source via contentFileSource()", () => {
        const source = contentFileSource({ paths: [contentFixturesDir] });

        expect(source).toBeInstanceOf(ContentFileSource);
        expect(source.name).toBe("ContentFileSource");
    });
});
```

One behavioral trap worth encoding as a test (the package suite calls it out in a comment): **plain, non-glob `paths` entries are always treated as directories**. Pointing `paths` at a single content file yields an empty catalog — use a directory or a glob:

```typescript
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentFileSource } from "blendsdk/i18n-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentFixturesDir = resolve(__dirname, "content-fixtures");

describe("ContentFileSource path semantics", () => {
    it("should treat a single file path as a directory and find no matches", async () => {
        const source = new ContentFileSource({
            paths: [resolve(contentFixturesDir, "en.signup-email.html")],
        });
        await expect(source.load()).resolves.toEqual({});
    });
});
```

### Temp-Directory Fixtures

Checked-in fixtures cover stable content; when a test generates its own data (invalid JSON, dynamic locales), use the `createTempFixtureDir()` helper with `beforeEach`/`afterEach`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileSource, ContentFileSource, Translator } from "blendsdk/i18n-node";
import { createTempFixtureDir, type TempFixtureDir } from "./helpers.js";

describe("file sources with generated fixtures", () => {
    let fixture: TempFixtureDir;

    beforeEach(async () => {
        fixture = await createTempFixtureDir();
    });

    afterEach(async () => {
        await fixture.remove();
    });

    it("should load a generated single-locale JSON file", async () => {
        const filePath = await fixture.write(
            "en.json",
            JSON.stringify({
                greeting: "Hello ${name}",
                book: ["${count} book", "${count} books"],
            })
        );
        const source = new JsonFileSource({ paths: [filePath] });
        const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });

        expect(translator.translate("greeting", "en", { name: "Alice" })).toBe("Hello Alice");
        expect(translator.translate("book", "en", { count: 2 })).toBe("2 books");
    });

    it("should load generated content files from a temp directory", async () => {
        await fixture.write("en.signup-email.html", "<p>Welcome, ${name}!</p>");
        await fixture.write("nl.signup-email.html", "<p>Welkom, ${name}!</p>");

        const source = new ContentFileSource({ paths: [fixture.path], extensions: [".html"] });
        const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });

        expect(translator.translate("signup-email", "en", { name: "Alice" })).toBe(
            "<p>Welcome, Alice!</p>"
        );
        expect(translator.translate("signup-email", "nl", { name: "Alice" })).toBe(
            "<p>Welkom, Alice!</p>"
        );
    });

    it("should reject with a descriptive error when a JSON file cannot be parsed", async () => {
        const filePath = await fixture.write("en.json", "{ not valid json");
        const source = new JsonFileSource({ paths: [filePath] });

        await expect(source.load()).rejects.toThrow(/Failed to parse JSON file/);
    });
});
```

### End-to-End Pipeline

The highest-value integration test wires the whole flow — sources loaded from disk, composed with `mergeCatalogs`, served by one `Translator`, and refreshed via `setCatalog`:

```typescript
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Translator, JsonFileSource, ContentFileSource, mergeCatalogs } from "blendsdk/i18n-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");
const contentFixturesDir = resolve(__dirname, "content-fixtures");

describe("translation pipeline", () => {
    it("should load sources, merge them, and translate through one Translator", async () => {
        const jsonSource = new JsonFileSource({
            paths: [resolve(fixturesDir, "multi-locale.json")],
        });
        const contentSource = new ContentFileSource({
            paths: [contentFixturesDir],
            extensions: [".html"],
        });

        const merged = mergeCatalogs([await jsonSource.load(), await contentSource.load()]);
        const translator = new Translator({ defaultLocale: "en", catalog: merged });

        expect(translator.translate("greeting", "nl", { name: "Alice" })).toBe("Hallo Alice");
        expect(translator.translate("book", "en", { count: 3 })).toBe("3 books");
        expect(translator.translate("signup-email", "en", { name: "Alice" })).toContain(
            "Welcome, Alice!"
        );
    });

    it("should apply runtime overrides with mergeCatalogs + setCatalog", () => {
        const translator = new Translator({
            defaultLocale: "en",
            catalog: { greeting: { en: "Hello", nl: "Hallo" } },
        });

        translator.setCatalog(
            mergeCatalogs([translator.getCatalog(), { greeting: { nl: "Hoi" } }])
        );

        expect(translator.translate("greeting", "nl")).toBe("Hoi");
        expect(translator.translate("greeting", "en")).toBe("Hello");
    });
});
```

---

## Mocking & Stubbing

### When to Mock (and When Not To)

`Translator` and `mergeCatalogs` are small, pure, fast, and dependency-free — **use real instances**. The natural seams for test doubles are:

| Seam | Technique | Use when |
|---|---|---|
| `onMissingTranslation` callback | `vi.fn()` | Asserting that missing keys are reported, with which key/locale |
| `TranslationSource` interface | In-memory stub class | Application code accepts an injected source and you want no file system |
| A concrete source's `load()` | `vi.spyOn(source, "load")` | Simulating reload failures or slow backends |
| The `blendsdk/i18n` module itself | `vi.mock(...)` | Your code constructs its own `Translator` and you cannot inject one |

### Mocking the Missing-Translation Callback

The callback is the package's built-in observability hook; `vi.fn()` verifies exactly what the translator reports:

```typescript
import { describe, expect, it, vi } from "vitest";
import { Translator } from "blendsdk/i18n";

describe("missing translation reporting", () => {
    it("should invoke the callback with the key and the resolved locale", () => {
        const callback = vi.fn<(key: string, locale: string) => void>();
        const translator = new Translator({
            catalog: { greeting: { en: "Hello" } },
            onMissingTranslation: callback,
        });

        expect(translator.translate("farewell", "de")).toBe("farewell");
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith("farewell", "de");
    });
});
```

Unlike an untyped `vi.fn()`, the generic signature `vi.fn<(key: string, locale: string) => void>()` keeps `toHaveBeenCalledWith` checked under TypeScript strict mode.

### Stubbing the TranslationSource Interface

The `InMemorySource` helper from [Shared Test Helpers](#shared-test-helpers) is the recommended stub. It proves its value when the code under test depends on the `TranslationSource` abstraction rather than a concrete file source:

```typescript
import { describe, expect, it } from "vitest";
import { Translator } from "blendsdk/i18n";
import type { TranslationSource } from "blendsdk/i18n";
import { InMemorySource } from "./helpers.js";

/** Application code under test — accepts any TranslationSource. */
async function createTranslatorFromSource(
    source: TranslationSource,
    defaultLocale: string
): Promise<Translator> {
    const catalog = await source.load();
    return new Translator({ defaultLocale, catalog });
}

describe("createTranslatorFromSource", () => {
    it("should build a working translator from an injected source", async () => {
        const source = new InMemorySource({
            greeting: { en: "Hello", nl: "Hallo" },
        });

        const translator = await createTranslatorFromSource(source, "en");

        expect(translator.translate("greeting", "nl")).toBe("Hallo");
    });
});
```

### Spying on load() to Simulate Failures

To test how your reload logic reacts to a failing backend, stub a real source's `load()` with `vi.spyOn` and restore afterwards:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonFileSource } from "blendsdk/i18n-node";

describe("reload failure handling", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should surface a rejected load with the original message", async () => {
        const source = new JsonFileSource({ paths: ["./translations/*.json"] });
        vi.spyOn(source, "load").mockRejectedValue(new Error("backend unavailable"));

        await expect(source.load()).rejects.toThrow("backend unavailable");
    });
});
```

### Mocking the Module Boundary

When your code constructs its own `Translator` internally, mock `blendsdk/i18n` with Vitest's factory form. `vi.mock` is hoisted above imports, so shared mock functions must be created with `vi.hoisted`:

```typescript
// src/welcome.ts — module under test
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: { welcome: { en: "Welcome, ${name}!" } },
});

export function buildWelcomeMessage(name: string): string {
    return translator.translate("welcome", undefined, { name });
}
```

```typescript
// tests/welcome.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { translateMock } = vi.hoisted(() => ({
    translateMock: vi.fn<(key: string, locale?: string, params?: Record<string, unknown>) => string>(
        (key: string): string => `[${key}]`
    ),
}));

vi.mock("blendsdk/i18n", () => ({
    Translator: class {
        translate = translateMock;
    },
}));

// Vitest hoists vi.mock above this import, so the module gets the mock
import { buildWelcomeMessage } from "../src/welcome.js";

describe("buildWelcomeMessage", () => {
    beforeEach(() => {
        translateMock.mockClear();
    });

    it("should delegate to Translator.translate with the welcome key", () => {
        const message = buildWelcomeMessage("Alice");

        expect(message).toBe("[welcome]");
        expect(translateMock).toHaveBeenCalledWith("welcome", undefined, { name: "Alice" });
    });
});
```

If the module under test uses more than `Translator` (for example `mergeCatalogs`), keep the real exports with the `importOriginal` variant:

```typescript
import { describe, expect, it, vi } from "vitest";

const { translateMock } = vi.hoisted(() => ({
    translateMock: vi.fn<(key: string, locale?: string, params?: Record<string, unknown>) => string>(
        (key: string): string => `[${key}]`
    ),
}));

vi.mock("blendsdk/i18n", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/i18n")>();
    return {
        ...actual,
        Translator: class {
            translate = translateMock;
        },
    };
});

import { buildWelcomeMessage } from "../src/welcome.js";

describe("buildWelcomeMessage with a partially mocked module", () => {
    it("should delegate through the mocked Translator while other exports stay real", () => {
        expect(buildWelcomeMessage("Alice")).toBe("[welcome]");
        expect(translateMock).toHaveBeenCalledWith("welcome", undefined, { name: "Alice" });
    });
});
```

### What Not to Mock

- **Do not mock `mergeCatalogs`** — it is a pure function; call it for real and assert on the output catalog.
- **Do not stub `Translator`** unless it is constructed internally and uninjectable — a real instance with a small inline catalog is just as fast and tests real fallback/plural behavior.
- **Do not mock `node:fs/promises`** to test the file sources — use checked-in fixtures or `createTempFixtureDir()`; mocking `readFile` couples tests to implementation details.
- **Do not mock `blendsdk/stdlib`** — interpolation is verified by supplying `params` and asserting the returned string.

---

## Test Patterns by Feature

Each pattern below is a complete, runnable test file mirroring the corresponding section of the package's own suite.

### Translator: Translation and Interpolation

Basic lookups, dot-notation keys, and multi-parameter `${...}` substitution:

```typescript
import { describe, expect, it } from "vitest";
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
    "auth.login": { en: "Log in", nl: "Inloggen" },
    "order.status": { en: "Order ${orderId} ships in ${days} days" },
};

describe("Translator — translation and interpolation", () => {
    it("should translate a simple key", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("auth.login", "en")).toBe("Log in");
    });

    it("should translate dot-notation keys per locale", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("auth.login", "nl")).toBe("Inloggen");
    });

    it("should interpolate multiple parameters", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("order.status", "en", { orderId: "A-1024", days: 3 })).toBe(
            "Order A-1024 ships in 3 days"
        );
    });
});
```

### Translator: Locale Fallback and Defaults

Exercise the full normalization and fallback chain: exact match, language fallback, dash normalization, encoding stripping, downward-only fallback, and default-locale behavior when the locale argument is omitted:

```typescript
import { describe, expect, it } from "vitest";
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello", en_GB: "Hello, mate", nl: "Hallo" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
    "cart.total": { nl: "Totaal" },
};

describe("Translator — locale fallback and defaults", () => {
    it("should prefer the exact locale over the language fallback", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("greeting", "en_GB")).toBe("Hello, mate");
    });

    it("should fall back to the language when the exact locale is absent", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("farewell", "en_GB")).toBe("Goodbye");
    });

    it("should normalize dash-separated locales (en-GB)", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("greeting", "en-GB")).toBe("Hello, mate");
    });

    it("should strip POSIX encodings (en_GB.UTF-8)", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("greeting", "en_GB.UTF-8")).toBe("Hello, mate");
    });

    it("should fall back from a regional locale to its language entry", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("cart.total", "nl_NL")).toBe("Totaal");
    });

    it("should never upgrade a language request to a regional entry", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("greeting", "en")).toBe("Hello");
    });

    it("should use the configured defaultLocale when translate() omits the locale", () => {
        const translator = new Translator({ catalog, defaultLocale: "nl" });
        expect(translator.translate("farewell")).toBe("Tot ziens");
        expect(translator.getDefaultLocale()).toBe("nl");
    });

    it("should default to en when no defaultLocale is configured", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("farewell")).toBe("Goodbye");
    });
});
```

### Translator: Plural Selection

Tuple selection is driven entirely by `params.count` — test the boundaries (`1` vs everything else), non-numeric input, and plain strings that must ignore `count`:

```typescript
import { describe, expect, it } from "vitest";
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const catalog: TranslationCatalog = {
    book: {
        en: ["${count} book", "${count} books"],
        nl: ["${count} boek", "${count} boeken"],
    },
    farewell: { en: "Goodbye" },
};

describe("Translator — plural selection", () => {
    it("should select the singular form for count = 1", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("book", "en", { count: 1 })).toBe("1 book");
    });

    it("should select the plural form for count = 0", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("book", "en", { count: 0 })).toBe("0 books");
    });

    it("should select the plural form for counts greater than one", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("book", "nl", { count: 3 })).toBe("3 boeken");
    });

    it("should default to the singular form for a non-numeric count", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("book", "en", { count: "many" })).toBe("many book");
    });

    it("should default to the singular form for NaN and still interpolate", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("book", "en", { count: NaN })).toBe("NaN book");
    });

    it("should ignore count for plain string values", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("farewell", "en", { count: 5 })).toBe("Goodbye");
    });
});
```

Selection reference for `["${count} book", "${count} books"]`:

| `count` value | Selected form | Result |
|---|---|---|
| `1` | singular | `"1 book"` |
| `0`, `3`, `-1`, … | plural | `"0 books"` |
| `"many"`, missing, `NaN` | singular (interpolated) | `"many book"` / `"NaN book"` |

### Translator: Missing Translations

Assert the returned key and the `onMissingTranslation` callback payload; use a collector array for multi-lookup flows:

```typescript
import { describe, expect, it, vi } from "vitest";
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
};

describe("Translator — missing translations", () => {
    it("should return the key unchanged when the key does not exist", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("nonexistent", "en")).toBe("nonexistent");
    });

    it("should return the key when no value resolves for the locale", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("farewell", "de")).toBe("farewell");
    });

    it("should invoke onMissingTranslation with the requested key and locale", () => {
        const onMissing = vi.fn<(key: string, locale: string) => void>();
        const translator = new Translator({ catalog, onMissingTranslation: onMissing });

        translator.translate("farewell", "de");

        expect(onMissing).toHaveBeenCalledTimes(1);
        expect(onMissing).toHaveBeenCalledWith("farewell", "de");
    });

    it("should invoke the callback with the default locale when the locale argument is omitted", () => {
        const onMissing = vi.fn<(key: string, locale: string) => void>();
        const translator = new Translator({
            defaultLocale: "en",
            catalog,
            onMissingTranslation: onMissing,
        });

        translator.translate("nonexistent");

        expect(onMissing).toHaveBeenCalledWith("nonexistent", "en");
    });

    it("should collect missing keys across a render pass", () => {
        const missing: string[] = [];
        const translator = new Translator({
            catalog,
            onMissingTranslation: (key: string, locale: string): void => {
                missing.push(`${locale}:${key}`);
            },
        });

        translator.translate("greeting", "en");
        translator.translate("farewell", "en");
        translator.translate("greeting", "de");

        expect(missing).toEqual(["de:greeting"]);
    });
});
```

### Translator: Catalog Exchange

`getTranslationsForLocale()` returns plural tuples intact for client-side selection; `hasKey()` applies the same fallback rules as `translate()`; `setCatalog()` swaps the catalog atomically and drops keys from the previous catalog:

```typescript
import { describe, expect, it } from "vitest";
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello", en_GB: "Hello, mate" },
    farewell: { en: "Goodbye" },
    book: { en: ["${count} book", "${count} books"] },
};

describe("Translator — catalog exchange", () => {
    it("should return a flat per-locale map with plural tuples preserved", () => {
        const translator = new Translator({ catalog });
        expect(translator.getTranslationsForLocale("en")).toEqual({
            greeting: "Hello",
            farewell: "Goodbye",
            book: ["${count} book", "${count} books"],
        });
    });

    it("should return an empty object for a locale with no resolvable values", () => {
        const translator = new Translator({ catalog });
        expect(translator.getTranslationsForLocale("de")).toEqual({});
    });

    it("should check key existence with and without locale fallback", () => {
        const translator = new Translator({ catalog });
        expect(translator.hasKey("greeting")).toBe(true);
        expect(translator.hasKey("greeting", "en_GB")).toBe(true);
        expect(translator.hasKey("farewell", "en_GB")).toBe(true); // language fallback
        expect(translator.hasKey("greeting", "de")).toBe(false);
        expect(translator.hasKey("missing")).toBe(false);
    });

    it("should replace the catalog atomically via setCatalog", () => {
        const translator = new Translator({ catalog });
        expect(translator.translate("greeting", "en")).toBe("Hello");

        translator.setCatalog({ greeting: { en: "Hi there" } });

        expect(translator.translate("greeting", "en")).toBe("Hi there");
        expect(translator.translate("farewell", "en")).toBe("farewell"); // no longer exists
    });

    it("should return the current catalog reference via getCatalog", () => {
        const translator = new Translator({ catalog });
        expect(translator.getCatalog()).toBe(catalog);
    });
});
```

### mergeCatalogs

Pure synchronous tests: override precedence, locale preservation, copy semantics (results must not share entry references with inputs), and the empty-array edge case:

```typescript
import { describe, expect, it } from "vitest";
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

describe("mergeCatalogs", () => {
    it("should merge catalogs with different keys", () => {
        const a: TranslationCatalog = { greeting: { en: "Hello" } };
        const b: TranslationCatalog = { farewell: { en: "Goodbye" } };

        expect(mergeCatalogs([a, b])).toEqual({
            greeting: { en: "Hello" },
            farewell: { en: "Goodbye" },
        });
    });

    it("should override duplicate key+locale with the later catalog", () => {
        const base: TranslationCatalog = { greeting: { en: "Hello", nl: "Hallo" } };
        const override: TranslationCatalog = { greeting: { en: "Hi" } };

        expect(mergeCatalogs([base, override])).toEqual({
            greeting: { en: "Hi", nl: "Hallo" }, // en overridden, nl preserved
        });
    });

    it("should apply three catalogs in progressive priority order", () => {
        const base: TranslationCatalog = { greeting: { en: "Hello", nl: "Hallo" } };
        const middle: TranslationCatalog = { greeting: { en: "Hi" }, farewell: { en: "Bye" } };
        const top: TranslationCatalog = { greeting: { en: "Hey" } };

        expect(mergeCatalogs([base, middle, top])).toEqual({
            greeting: { en: "Hey", nl: "Hallo" },
            farewell: { en: "Bye" },
        });
    });

    it("should return copies, not references to the input entries", () => {
        const base: TranslationCatalog = { greeting: { en: "Hello" } };
        const result = mergeCatalogs([base]);

        expect(result).toEqual({ greeting: { en: "Hello" } });
        expect(result).not.toBe(base);
        expect(result.greeting).not.toBe(base.greeting);
    });

    it("should return an empty catalog for an empty input array", () => {
        expect(mergeCatalogs([])).toEqual({});
    });

    it("should keep plural tuples intact through a merge", () => {
        const a: TranslationCatalog = { book: { en: ["${count} book", "${count} books"] } };
        const b: TranslationCatalog = { book: { nl: ["${count} boek", "${count} boeken"] } };

        expect(mergeCatalogs([a, b])).toEqual({
            book: {
                en: ["${count} book", "${count} books"],
                nl: ["${count} boek", "${count} boeken"],
            },
        });
    });
});
```

### Custom TranslationSource Implementations

Test the contract itself: a `name` for logging, an async `load()` returning the full catalog, and failure propagation with a descriptive error:

```typescript
import { describe, expect, it } from "vitest";
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/i18n";

class InMemorySource implements TranslationSource {
    readonly name = "InMemorySource";

    private readonly catalog: TranslationCatalog;

    constructor(catalog: TranslationCatalog) {
        this.catalog = catalog;
    }

    async load(): Promise<TranslationCatalog> {
        return this.catalog;
    }
}

class FailingSource implements TranslationSource {
    readonly name = "FailingSource";

    async load(): Promise<TranslationCatalog> {
        throw new Error("translation backend unavailable");
    }
}

describe("custom TranslationSource implementations", () => {
    it("should expose a descriptive source name", () => {
        expect(new InMemorySource({}).name).toBe("InMemorySource");
    });

    it("should load its catalog asynchronously into a Translator", async () => {
        const source = new InMemorySource({ greeting: { en: "Hello" } });
        const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });

        expect(translator.translate("greeting", "en")).toBe("Hello");
    });

    it("should propagate backend failures from load()", async () => {
        const source = new FailingSource();
        await expect(source.load()).rejects.toThrow("translation backend unavailable");
    });
});
```

### JsonFileSource

Feature checklist to cover: `name`, multi-locale loading, single-locale loading (locale from filename), glob resolution, deterministic merging (sorted files, later wins), empty results for unmatched globs, and rejection for unreadable plain paths. Format detection is per file, based on the **first value**: an object means multi-locale, a string or array means single-locale. The complete integration examples appear in [JsonFileSource Integration Tests](#jsonfilesource-integration-tests); this condensed set shows the essential shape:

```typescript
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonFileSource, jsonFileSource } from "blendsdk/i18n-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "fixtures");

describe("JsonFileSource", () => {
    it("should have name JsonFileSource", () => {
        const source = new JsonFileSource({ paths: [] });
        expect(source.name).toBe("JsonFileSource");
    });

    it("should load plural tuples from a multi-locale file", async () => {
        const source = new JsonFileSource({
            paths: [resolve(fixturesDir, "multi-locale.json")],
        });
        const catalog = await source.load();

        expect(catalog.book).toEqual({
            en: ["${count} book", "${count} books"],
            nl: ["${count} boek", "${count} boeken"],
        });
    });

    it("should merge multi-locale and single-locale files in sorted order", async () => {
        const source = new JsonFileSource({
            paths: [resolve(fixturesDir, "*.json")],
        });
        const catalog = await source.load();

        expect(catalog.greeting).toBeDefined();
        expect(catalog.farewell).toBeDefined();
    });

    it("should create a working source via jsonFileSource()", async () => {
        const source = jsonFileSource({
            paths: [resolve(fixturesDir, "multi-locale.json")],
        });

        expect(source).toBeInstanceOf(JsonFileSource);
        const catalog = await source.load();
        expect(catalog.greeting).toBeDefined();
    });
});
```

### ContentFileSource

Feature checklist to cover: `name`, the `<locale>.<key>.<ext>` convention (including multi-dot keys), extension defaults and normalization, skipped files (fewer than 3 segments, hidden dot-files), directory-vs-glob path handling, and deterministic ordering. The full integration examples appear in [ContentFileSource Integration Tests](#contentfilesource-integration-tests); this condensed set shows the essential shape:

```typescript
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentFileSource } from "blendsdk/i18n-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentFixturesDir = resolve(__dirname, "content-fixtures");

describe("ContentFileSource", () => {
    it("should use default extensions (.html, .md, .txt) when none are configured", async () => {
        const source = new ContentFileSource({ paths: [contentFixturesDir] });
        const catalog = await source.load();

        expect(catalog["signup-email"]).toBeDefined(); // .html
        expect(catalog["welcome-page"]).toBeDefined(); // .md
        expect(catalog["privacy-policy"]).toBeDefined(); // .txt
        expect(catalog["some-data"]).toBeUndefined(); // .json excluded by default
    });

    it("should load markdown and plain text content as-is", async () => {
        const markdown = new ContentFileSource({
            paths: [contentFixturesDir],
            extensions: [".md"],
        });
        const markdownCatalog = await markdown.load();
        expect(markdownCatalog["welcome-page"]["en"]).toContain("# Welcome");
        expect(markdownCatalog["welcome-page"]["nl"]).toContain("# Welkom");

        const text = new ContentFileSource({
            paths: [contentFixturesDir],
            extensions: [".txt"],
        });
        const textCatalog = await text.load();
        expect(textCatalog["privacy-policy"]["en"]).toContain("Your privacy is important to us.");
    });

    it("should normalize configured extensions (case and missing dot)", async () => {
        const source = new ContentFileSource({
            paths: [contentFixturesDir],
            extensions: ["HTML"],
        });
        const catalog = await source.load();

        expect(catalog["signup-email"]).toBeDefined();
        expect(catalog["welcome-page"]).toBeUndefined(); // .md not in the custom list
    });

    it("should resolve glob patterns for a specific extension", async () => {
        const source = new ContentFileSource({
            paths: [resolve(contentFixturesDir, "*.html")],
        });
        const catalog = await source.load();

        expect(catalog["signup-email"]).toBeDefined();
        expect(catalog["auth.welcome"]).toBeDefined();
        expect(catalog["welcome-page"]).toBeUndefined();
    });
});
```

### End-to-End and Reload Flows

Cover reload behavior end-to-end: load fresh data from a source, layer it over the existing catalog with `mergeCatalogs`, and swap it in with `setCatalog` — asserting both the overridden and the preserved values:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Translator, JsonFileSource, mergeCatalogs } from "blendsdk/i18n-node";
import { createTempFixtureDir, type TempFixtureDir } from "./helpers.js";

describe("translation reload", () => {
    let fixture: TempFixtureDir;

    beforeEach(async () => {
        fixture = await createTempFixtureDir();
    });

    afterEach(async () => {
        await fixture.remove();
    });

    it("should layer reloaded source data over the running catalog", async () => {
        const initialFile = await fixture.write(
            "en.json",
            JSON.stringify({ greeting: "Hello", farewell: "Goodbye" })
        );
        const source = new JsonFileSource({ paths: [initialFile] });

        const translator = new Translator({
            defaultLocale: "en",
            catalog: await source.load(),
        });
        expect(translator.translate("greeting", "en")).toBe("Hello");

        // Backend delivers an override for one key
        const overrideFile = await fixture.write(
            "en-override.json",
            JSON.stringify({ greeting: "Hi there" })
        );
        const overrideCatalog = await new JsonFileSource({ paths: [overrideFile] }).load();

        translator.setCatalog(mergeCatalogs([translator.getCatalog(), overrideCatalog]));

        expect(translator.translate("greeting", "en")).toBe("Hi there"); // overridden
        expect(translator.translate("farewell", "en")).toBe("Goodbye"); // preserved
    });
});
```

---

# i18n Troubleshooting

This document covers the errors, symptoms, and pitfalls most commonly encountered when using `blendsdk/i18n`:

- **Common Errors** — exact error messages and observable symptoms, each with cause and a working fix
- **Debugging Strategies** — step-by-step procedures for diagnosing missing or wrong translations
- **Known Pitfalls** — behaviors that are technically correct but easy to misread

Error messages are the exact strings produced by the package; file paths, JSON parser reasons, and position numbers vary per environment.

---

## Common Errors

Errors are grouped into four areas: [file loading](#file-loading-errors), [imports and bundling](#import--bundling-errors), [translation resolution](#translation-resolution-problems), and [TypeScript compiler errors](#typescript-compiler-errors).

### File Loading Errors

#### Error: Failed to parse JSON file

**Error message**:

```text
Error: Failed to parse JSON file "/app/translations/en.json": Unexpected token '}', "{ "greeting": "Hello", }" is not valid JSON
```

**Cause**: `JsonFileSource.load()` reads every resolved file as UTF-8 and passes it through `JSON.parse()`. This error means the file's content is not valid JSON — typically trailing commas, `//` comments, single-quoted strings, unquoted property names, or a file that is actually JavaScript. The path in the message is absolute, and the parser reason that follows comes from V8.

**Fix**:

1. Open the exact file named in the error message.
2. Repair the JSON — remove trailing commas and comments, use double quotes only.
3. Re-run; wrap the load in a `try`/`catch` so the offending path is always visible in logs.

```typescript
import { JsonFileSource } from "blendsdk/i18n-node";
import type { TranslationCatalog } from "blendsdk/i18n";

try {
    const source = new JsonFileSource({ paths: ["./translations/*.json"] });
    const catalog: TranslationCatalog = await source.load();
    console.log(`Loaded ${Object.keys(catalog).length} keys`);
} catch (error) {
    // The absolute path of the offending file is part of the message
    console.error(error instanceof Error ? error.message : String(error));
}
```

Corrected file (`translations/en.json`):

```json
{
    "greeting": "Hello ${name}",
    "book": ["${count} book", "${count} books"]
}
```

---

#### Error: ENOENT — a plain JSON path does not exist

**Error message**:

```text
Error: ENOENT: no such file or directory, open '/app/translations/custom.json'
```

**Cause**: Any entry in `JsonFileSource.paths` without `*` or `?` is treated as a concrete file and read directly, so a missing file rejects the load. A second, sneakier cause: relative paths are resolved against the process working directory at load time — if the app starts from a different `cwd` than expected (systemd, Docker `WORKDIR`, a monorepo script), the file exists but the resolved path does not.

**Fix**:

1. Decide whether the file is required or optional.
2. For required files: resolve paths against the module location, not `process.cwd()`.
3. For optional files: catch the error (or use a glob — a glob over a missing directory returns zero files instead of throwing).

```typescript
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Translator, JsonFileSource, mergeCatalogs } from "blendsdk/i18n-node";
import type { TranslationCatalog } from "blendsdk/i18n";

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Required defaults — resolved against this module, not process.cwd()
const defaultsSource = new JsonFileSource({
    paths: [resolve(moduleDir, "translations/*.json")],
});
const defaults = await defaultsSource.load();

if (Object.keys(defaults).length === 0) {
    throw new Error(`No translations loaded from ${resolve(moduleDir, "translations")}`);
}

// Optional overrides — a missing file must not stop the application
let overrides: TranslationCatalog = {};
try {
    const overridesSource = new JsonFileSource({
        paths: [resolve(moduleDir, "overrides/custom.json")],
    });
    overrides = await overridesSource.load();
} catch (error) {
    console.warn("Overrides not loaded:", error instanceof Error ? error.message : String(error));
}

const translator = new Translator({
    defaultLocale: "en",
    catalog: mergeCatalogs([defaults, overrides]),
});
```

---

#### Error: EISDIR — directory passed to JsonFileSource

**Error message**:

```text
Error: EISDIR: illegal operation on a directory, read
```

**Cause**: `JsonFileSource` expects file paths or glob patterns. A bare directory such as `"./translations"` contains no glob characters, so it is passed straight to `readFile()` — which fails on a directory. This is the opposite of `ContentFileSource`, where a bare path *is* a directory.

**Fix**: point at files: use a glob for the directory contents, or list the files explicitly. Remember globs are single-directory and non-recursive.

```typescript
import { JsonFileSource } from "blendsdk/i18n-node";

// Wrong: a bare directory is treated as a file and readFile() fails with EISDIR
// new JsonFileSource({ paths: ["./translations"] });

// Right: point at the files inside the directory with a glob
const source = new JsonFileSource({ paths: ["./translations/*.json"] });
const catalog = await source.load();
console.log(Object.keys(catalog));
```

---

#### Error: Cannot determine locale from filename

**Error message**:

```text
Error: Cannot determine locale from filename ".json"
```

**Cause**: `JsonFileSource` detected a file as *single-locale* (its first value is a string or array) and then tried to extract the locale from the last dot-segment of the filename before `.json`. Names like `.json` (hidden file) or `en..json` leave that segment empty, so extraction throws. Note this only fires for single-locale content — an empty or multi-locale `.json` file never reaches this code path.

**Fix**:

1. Remove or rename the offending file — translation directories should contain only real `<locale>.json` (or `<prefix>.<locale>.json`) files.
2. Scan for offenders with a small script that mirrors the extraction rule.

```typescript
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const dir = resolve("./translations");
const offenders = (await readdir(dir)).filter((name) => {
    if (!/\.json$/i.test(name)) return false;
    const lastSegment = name.replace(/\.json$/i, "").split(".").pop() ?? "";
    return lastSegment === "";
});

console.log(offenders); // e.g. [".json", "en..json"] — rename or delete these
```

---

#### Error: EACCES — permission denied

**Error message**:

```text
Error: EACCES: permission denied, open '/app/content/emails/en.signup-email.html'
```

**Cause**: A file that matched the configured paths exists but cannot be read — typically root-owned files in a container image or a restrictive CI checkout. Both file sources *skip missing directories silently*, but an existing unreadable matched file always throws, so this error only appears when the file is really there.

**Fix**:

1. Fix ownership/permissions for the offending path (for Docker, use `COPY --chown=<user>` or set the runtime user's access).
2. If the file set is not fully under your control, catch the error and log which source failed.

```typescript
import { ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({ paths: ["./content/emails"] });

try {
    const catalog = await source.load();
    console.log(`ContentFileSource loaded ${Object.keys(catalog).length} keys`);
} catch (error) {
    // EACCES messages name the exact file and operation
    console.error(`[${source.name}] load failed:`, error instanceof Error ? error.message : String(error));
}
```

---

#### Symptom: ContentFileSource loads nothing and throws nothing

**Symptom**: `load()` resolves `{}` (or misses expected keys) with no error at all.

**Cause**: `ContentFileSource` silently skips anything that does not fit its conventions. Common reasons:

| Observation | Cause | Fix |
|---|---|---|
| Key missing entirely | Filename is not `<locale>.<key>.<ext>` (fewer than 3 dot-segments, or empty locale such as a dotfile) | Rename to `en.welcome.md` |
| Only some files load | A custom `extensions` array **replaces** the defaults instead of extending them | List every needed extension |
| Passing a single file path yields nothing | Plain paths are treated as directories and listed — `readdir` on a file silently produces zero entries | Pass the directory or a glob |
| Files in subdirectories are ignored | Directory listing is non-recursive, and globs are single-directory | Add each directory (or a glob per directory) |

**Fix**: match the conventions explicitly and keep a default extension list that covers everything the project uses.

```typescript
import { ContentFileSource } from "blendsdk/i18n-node";

// One entry per directory (or per-directory glob). Note: a single FILE path
// here would be listed as if it were a directory and silently contribute nothing.
const source = new ContentFileSource({
    paths: ["./content/emails", "./content/pages/*.md"],
    extensions: [".html", ".md", ".txt"], // custom list REPLACES the defaults
});

const catalog = await source.load();
console.log(Object.keys(catalog));
```

---

### Import & Bundling Errors

#### Error: no exported member 'JsonFileSource'

**Error messages** — TypeScript:

```text
error TS2305: Module '"blendsdk/i18n"' has no exported member 'JsonFileSource'.
```

Node.js ESM at runtime:

```text
SyntaxError: The requested module 'blendsdk/i18n' does not provide an export named 'JsonFileSource'
```

**Cause**: There are two entry points by design. `blendsdk/i18n` is the browser-safe core and deliberately excludes `JsonFileSource` and `ContentFileSource` (they import `node:fs` and `node:path`). The file-based sources exist only on `blendsdk/i18n-node`.

**Fix**: import from the correct entry point. Server-side modules may use `/node`; shared or browser modules must use the core.

```typescript
// Browser-safe core — works in every runtime
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/i18n";

// Node.js-only — adds file-based sources (imports node:fs / node:path)
import { JsonFileSource, ContentFileSource } from "blendsdk/i18n-node";
```

---

#### Error: Module "node:fs/promises" has been externalized for browser compatibility

**Error message** (Vite):

```text
Module "node:fs/promises" has been externalized for browser compatibility. Cannot access "node:fs.promises" in client code.
```

Webpack reports the equivalent as `Module not found: Can't resolve 'node:fs/promises'`.

**Cause**: Something in the browser bundle — directly or transitively — imports `blendsdk/i18n-node`. That entry pulls `node:fs/promises` and `node:path` into code that runs in a browser, where those modules do not exist.

**Fix**:

1. Load translations on the server with `JsonFileSource` / `ContentFileSource`.
2. Serve a flat per-locale map with `getTranslationsForLocale()`.
3. Rebuild a `TranslationCatalog` in the browser and use the core `Translator`.

Server:

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const translator = new Translator({
    defaultLocale: "en",
    catalog: await new JsonFileSource({ paths: ["./translations/*.json"] }).load(),
});

// Serve a flat per-locale map to the client (e.g. GET /api/translations)
const payload = {
    en: translator.getTranslationsForLocale("en"),
    nl: translator.getTranslationsForLocale("nl"),
};

console.log(Object.keys(payload.en).length);
```

Client (browser-safe):

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationValue } from "blendsdk/i18n";

const response = await fetch("/api/translations");
const perLocale = (await response.json()) as Record<string, Record<string, TranslationValue>>;

const catalog: TranslationCatalog = {};
for (const [locale, values] of Object.entries(perLocale)) {
    for (const [key, value] of Object.entries(values)) {
        if (!catalog[key]) {
            catalog[key] = {};
        }
        catalog[key][locale] = value;
    }
}

const translator = new Translator({ defaultLocale: "en", catalog });
console.log(translator.translate("greeting", "en", { name: "Alice" }));
```

---

#### Error: TS2307 — Cannot find module 'blendsdk/i18n-node'

**Error message**:

```text
error TS2307: Cannot find module 'blendsdk/i18n-node' or its corresponding type declarations.
```

**Cause**: The package resolves exclusively through its `exports` map. Classic TypeScript module resolution (`"node"` / `"node10"`) ignores `exports` maps entirely, so neither the package nor its `/node` subpath can be resolved.

**Fix**: use a resolution mode that honors `exports` — `"nodenext"` for Node.js projects, `"bundler"` for bundler-driven projects. Do not add `paths` workarounds.

```json
{
    "compilerOptions": {
        "target": "es2022",
        "module": "nodenext",
        "moduleResolution": "nodenext",
        "strict": true,
        "skipLibCheck": true
    }
}
```

For bundler-based projects use `"module": "esnext"` with `"moduleResolution": "bundler"`.

---

#### Error: ERR_PACKAGE_PATH_NOT_EXPORTED on deep imports

**Error message**:

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/translator.js' is not defined by "exports" in /app/node_modules/blendsdk/i18n/package.json
```

**Cause**: The `exports` map intentionally exposes only two subpaths: `.` and `./node`. Deep imports into `dist/` are blocked, so internal file layout cannot become a de-facto API.

**Fix**: import only from the public entry points. Everything needed is exported there — the engine, `mergeCatalogs`, the types, `TranslationSource`, and (on `/node`) both file sources plus their factories.

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import { JsonFileSource, ContentFileSource } from "blendsdk/i18n-node";
```

---

#### Error: TS1479 — CommonJS import of an ESM-only package

**Error message**:

```text
error TS1479: The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module and cannot be imported with 'require'. Consider writing a dynamic import('blendsdk/i18n-node') call instead.
```

**Cause**: The package is `"type": "module"` and publishes only `import` conditions. A file compiled to CommonJS (`"module": "commonjs"`) cannot statically import it.

**Fix**, option 1 (recommended): compile the project as ESM — set `"module": "nodenext"` in tsconfig and `"type": "module"` in `package.json`.

**Fix**, option 2: use a dynamic `import()` from the CommonJS file:

```typescript
export async function loadTranslator() {
    const { Translator, JsonFileSource } = await import("blendsdk/i18n-node");

    return new Translator({
        defaultLocale: "en",
        catalog: await new JsonFileSource({ paths: ["./translations/*.json"] }).load(),
    });
}
```

---

### Translation Resolution Problems

#### Symptom: translate() returns the key itself

**Symptom**: The UI shows `auth.login` (the raw key) instead of "Log in".

**Cause**: `translate()` returns the key unchanged — and invokes `onMissingTranslation` — in exactly two cases: the key is not in the catalog at all, or the key exists but no value resolves for the requested locale. Resolution only ever falls back *downward*: exact locale (`en_GB`) → language (`en`) → give up. A request for `en` never falls back *upward* to `en_GB`, and case or naming mismatches block every step of the chain.

**Fix**:

1. Wire `onMissingTranslation` to log key + locale.
2. Inspect the catalog entry to see which locales actually exist.
3. Add the missing locale value (or fix the requested locale string).

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "auth.login": { en_GB: "Log in" }, // no "en" entry
    },
    onMissingTranslation: (key: string, locale: string): void => {
        console.error(`[i18n] missing: key="${key}" locale="${locale}"`);
    },
});

// Symptom: "en" never falls back upward to "en_GB"
console.log(translator.translate("auth.login", "en")); // "auth.login" (+ error log)
console.log(translator.hasKey("auth.login", "en"));    // false

// Diagnosis: inspect the entry to see which locales actually exist
console.log(translator.getCatalog()["auth.login"]);    // { en_GB: "Log in" }

// Fix: add the missing locale (or request "en_GB" instead)
translator.setCatalog(
    mergeCatalogs([translator.getCatalog(), { "auth.login": { en: "Log in" } }])
);
console.log(translator.translate("auth.login", "en")); // "Log in"
```

---

#### Symptom: [object Object] appears in translated output

**Symptom**: After loading JSON files, some values render as literally `[object Object]`.

**Cause**: Format auto-detection looks **only at the first value** in each file. If that value is a string or an array, the whole file is treated as single-locale — and every object-valued key is normalized with `String(value)`. Example file:

```json
{
    "brand": "Acme",
    "greeting": { "en": "Hello ${name}", "nl": "Hallo ${name}" }
}
```

The first value `"Acme"` is a string, so the file is single-locale and `greeting` becomes `"[object Object]"` under the filename-derived locale. The reverse direction bites too: in a file detected as multi-locale, a stray flat string value is iterated as a locale map and produces one entry per character (`"0": "G"`, `"1": "o"`, …).

**Fix**: keep every JSON file in exactly one format, and make the first key representative (a locale map for multi-locale files).

```json
{
    "brand": { "en": "Acme", "nl": "Acme" },
    "greeting": { "en": "Hello ${name}", "nl": "Hallo ${name}" }
}
```

Scan for corrupted values after loading:

```typescript
import { JsonFileSource } from "blendsdk/i18n-node";

const catalog = await new JsonFileSource({ paths: ["./translations/*.json"] }).load();

for (const [key, entry] of Object.entries(catalog)) {
    for (const [locale, value] of Object.entries(entry)) {
        const strings = Array.isArray(value) ? value : [value];
        if (strings.some((text) => text.includes("[object Object]"))) {
            console.warn(`Corrupted value at ${key} / ${locale}`);
        }
    }
}
```

---

#### Symptom: singular form is always selected

**Symptom**: `"5 book"` is rendered instead of `"5 books"`.

**Cause**: Plural selection only triggers when `params.count` is an actual `number`. Values arriving from query strings, JSON payloads, or headers are strings (`"5"`), so the singular form is selected — and the string is still interpolated, which makes the result look almost right. Passing no `count` at all also selects the singular by design.

**Fix**: convert to a number before translating. If you serve `getTranslationsForLocale()` output to a client, select the tuple form there yourself.

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationValue } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        book: { en: ["${count} book", "${count} books"] },
    },
});

// Symptom: count arrived as a string (query parameter, JSON payload, header)
console.log(translator.translate("book", "en", { count: "5" })); // "5 book" — singular!

// Fix: convert to a number before calling translate()
const count = Number("5");
console.log(translator.translate("book", "en", { count })); // "5 books"

// Client-side consumption keeps both forms, so the client selects and interpolates:
const renderCount = (value: TranslationValue, renderedCount: number): string => {
    const template = Array.isArray(value) ? (renderedCount === 1 ? value[0] : value[1]) : value;
    return template.replaceAll("${count}", String(renderedCount));
};

const value: TranslationValue = translator.getTranslationsForLocale("en")["book"];
console.log(renderCount(value, 3)); // "3 books"
```

---

#### Symptom: NaN appears in the output

**Symptom**: A translation renders as `"NaN book"`.

**Cause**: `count` is `NaN` — a failed `Number()` parse that was never validated. `NaN` is not a valid number for plural selection (so the singular form is chosen), but it is still interpolated into `${count}`, which leaks the literal text `NaN` into user-visible output.

**Fix**: validate the count where untrusted input enters the system, before it reaches `translate()`.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        book: { en: ["${count} book", "${count} books"] },
    },
});

// Symptom: NaN is interpolated into the output
console.log(translator.translate("book", "en", { count: NaN })); // "NaN book"

// Fix: validate and normalize at the boundary where user input enters
const parsed = Number("not-a-number");
const count = Number.isFinite(parsed) ? parsed : 0;

console.log(translator.translate("book", "en", { count })); // "0 books"
```

---

#### Symptom: dashed or cased locale files never resolve

**Symptom**: `translations/en-US.json` exists and loads without error, but `translate("greeting", "en-US")` still returns the key.

**Cause**: Catalog locale keys are matched **exactly**; only the *requested* locale is normalized. A file named `en-US.json` stores its values under the key `en-US`, while a request for `en-US` is normalized to `full: "en_US"` — and the fallback chain checks `en_US`, then `en`, hitting neither. The same applies to casing: `EN.json` stores `EN`, which no normalized request will ever match.

**Fix**: name single-locale files with lower-case underscore locales (`en_US.json`), and use the same convention for locale keys inside multi-locale JSON files.

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

// The file is named en_US.json and contains: { "greeting": "Hi" }
const source = new JsonFileSource({
    paths: ["./translations/en_US.json"],
});
const catalog = await source.load();

const translator = new Translator({ defaultLocale: "en_US", catalog });

console.log(translator.getCatalog()["greeting"]);        // { en_US: "Hi" }
console.log(translator.translate("greeting", "en-US"));  // "Hi" — dashes normalized
console.log(translator.translate("greeting", "en_US"));  // "Hi"
```

---

### TypeScript Compiler Errors

#### TS2322: Type 'string' is not assignable to type 'TranslationEntry'

**Error message**:

```text
error TS2322: Type 'string' is not assignable to type 'TranslationEntry'.
```

**Cause**: A flat key→value pair was written where the catalog expects key→locale-map. The catalog is always two levels deep.

**Fix**: wrap each value in its locale map.

```typescript
import type { TranslationCatalog } from "blendsdk/i18n";

// Fails: "Hello" is a string, but a catalog value must be a locale map
const broken: TranslationCatalog = {
    greeting: "Hello",
};

// Fixed: each key maps to per-locale values
const catalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
};
```

---

#### TS2322: Type 'string[]' is not assignable to type 'TranslationValue'

**Error message**:

```text
error TS2322: Type 'string[]' is not assignable to type 'TranslationValue'.
```

**Cause**: Plural pairs must be typed as a two-element tuple `[singular, plural]`. When an array literal is first assigned to an unannotated intermediate variable, TypeScript widens it to `string[]`, which is no longer assignable to the tuple.

**Fix**: annotate the intermediate as `TranslationEntry` (or annotate the whole catalog so the literal is contextually checked against the tuple type).

```typescript
import type { TranslationCatalog, TranslationEntry } from "blendsdk/i18n";

// Fails: the array widens to string[] before it reaches the catalog
const brokenEntry = { en: ["${count} book", "${count} books"] };
const brokenCatalog: TranslationCatalog = { book: brokenEntry };

// Fixed: annotate the entry so the literal is checked against the tuple type
const entry: TranslationEntry = {
    en: ["${count} book", "${count} books"],
};

const catalog: TranslationCatalog = { book: entry };
```

---

#### TS2420: custom TranslationSource does not implement the interface

**Error message**:

```text
error TS2420: Class 'InMemorySource' incorrectly implements interface 'TranslationSource'.
  Property 'name' is missing in type 'InMemorySource' but required in type 'TranslationSource'.
```

**Cause**: `TranslationSource` requires both a `readonly name` (used for logging) and an async `load()`. A related failure is declaring `load()` as synchronous — returning `TranslationCatalog` instead of `Promise<TranslationCatalog>` — which produces a `TS2416` assignability error.

**Fix**: implement both members with the exact shapes.

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/i18n";

export class InMemorySource implements TranslationSource {
    readonly name = "InMemorySource";

    protected readonly data: TranslationCatalog;

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

const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });
console.log(translator.translate("greeting", "nl")); // "Hallo"
```

---

#### TS1361: 'Translator' cannot be used as a value because it was imported using 'import type'

**Error message**:

```text
error TS1361: 'Translator' cannot be used as a value because it was imported using 'import type'.
```

**Cause**: A blanket `import type { ... }` was used for everything exported by the package. `import type` is erased at compile time, so classes and functions (values) cannot be constructed or called. Only interfaces and type aliases may be imported that way.

**Fix**: split the imports — value imports for `Translator`, `mergeCatalogs`, and the source classes; `import type` for `TranslationCatalog`, `TranslatorConfig`, `TranslationSource`, `TranslationValue`, `TranslationEntry`, `LocaleParts`, and the two config interfaces.

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslatorConfig } from "blendsdk/i18n";

const catalog: TranslationCatalog = { greeting: { en: "Hello" } };

const config: TranslatorConfig = {
    defaultLocale: "en",
    catalog,
};

const translator = new Translator(config);
console.log(translator.translate("greeting")); // "Hello"
```

---

## Debugging Strategies

Run these procedures in order when translations are missing, wrong, or fail to load at all.

### 1. Dump the loaded catalog before blaming the translator

The engine is deterministic; most bugs live in what the sources produced.

1. Load each source standalone (outside the app).
2. Print the key count and a sample entry.
3. Verify the locale keys are what you expect (`en`, `nl`, `en_US` — lower-case, underscore).

```typescript
import { JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({ paths: ["./translations/*.json"] });
const catalog = await source.load();

console.log(`[${source.name}] loaded ${Object.keys(catalog).length} keys`);
console.log(JSON.stringify(catalog["greeting"], null, 2));
// → { "en": "Hello ${name}", "nl": "Hallo ${name}" }
```

### 2. Verify coverage per key and locale, then promote the check to a test

1. List the keys your UI requires and the locales you support.
2. Loop the combinations through `hasKey(key, locale)` — the two-argument form applies the fallback chain.
3. Turn the same loop into a CI test so coverage gaps fail the build, not production.

```typescript
import { describe, expect, it } from "vitest";
import { JsonFileSource } from "blendsdk/i18n-node";

describe("translation catalog coverage", () => {
    it("defines every required key for every supported locale", async () => {
        const catalog = await new JsonFileSource({
            paths: ["./translations/*.json"],
        }).load();

        const requiredKeys: string[] = ["greeting", "farewell", "auth.login"];
        const supportedLocales: string[] = ["en", "nl"];

        for (const locale of supportedLocales) {
            for (const key of requiredKeys) {
                expect(catalog[key]?.[locale], `missing ${key} for ${locale}`).toBeDefined();
            }
        }
    });
});
```

### 3. Trace one failing key end-to-end

Pick a single failing key + locale pair and walk the pipeline manually.

1. Look up the entry in `getCatalog()` — does it hold the exact locale, the language, or neither?
2. Resolve the value for the locale and check its shape — a string or a plural tuple.
3. Run `translate()` with the exact params your call site passes and compare.

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationValue } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        book: { en: ["${count} book", "${count} books"] },
    },
});

const key = "book";
const locale = "en";
const params: Record<string, unknown> = { count: 2 };

// Step 1: does the key exist, and what does the entry contain?
console.log(translator.getCatalog()[key]);

// Step 2: what resolves for this locale? (If undefined, check the language part manually)
const value: TranslationValue | undefined = translator.getCatalog()[key]?.[locale];
console.log("resolved value:", value);

// Step 3: what shape is the value — string or plural tuple?
console.log("shape:", Array.isArray(value) ? "plural tuple" : "string");

// Step 4: run the full pipeline with the exact params your call site passes
console.log("translate():", translator.translate(key, locale, params)); // "2 books"
```

### 4. Isolate the engine from the sources

If a translation fails with file-loaded data, reproduce it with an inline catalog.

1. Construct a `Translator` with a known-good inline catalog.
2. If the inline version works, the engine is fine — the problem is in source loading or catalog merging.

```typescript
import { Translator } from "blendsdk/i18n";

// Known-good inline catalog — if this resolves, the engine works and
// the problem is in source loading or catalog merging.
const translator = new Translator({
    defaultLocale: "en",
    catalog: { greeting: { en: "Hello ${name}" } },
});

console.log(translator.translate("greeting", "en", { name: "Alice" })); // "Hello Alice"
```

### 5. Audit how catalogs merge

1. Load each source separately and print their key counts.
2. List keys defined by more than one source.
3. Confirm the merged result matches your intended precedence — **later catalogs win**.

```typescript
import { JsonFileSource, ContentFileSource, mergeCatalogs } from "blendsdk/i18n-node";

const fileCatalogs = await new JsonFileSource({ paths: ["./translations/*.json"] }).load();
const contentCatalogs = await new ContentFileSource({ paths: ["./content/emails"] }).load();

const merged = mergeCatalogs([fileCatalogs, contentCatalogs]);

console.log("from JSON:", Object.keys(fileCatalogs).length);
console.log("from content:", Object.keys(contentCatalogs).length);
console.log("merged:", Object.keys(merged).length);

// Which source wins for a contested key? (content, because it comes last)
const contested = Object.keys(fileCatalogs).filter((key) => key in contentCatalogs);
for (const key of contested) {
    console.log(key, "→", JSON.stringify(merged[key]));
}
```

### 6. Validate file layouts against the naming conventions

An audit of file names often finds the bug faster than any runtime tracing.

1. For JSON files — check which format each file will be detected as (first value is the deciding vote).
2. For content files — check how each filename parses into locale and key.

```typescript
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

// JSON: which format will each file be detected as?
const dir = resolve("./translations");
for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(resolve(dir, name), "utf-8")) as Record<string, unknown>;
    const firstValue = Object.values(data)[0];
    const format =
        firstValue !== undefined && typeof firstValue === "object" && firstValue !== null
            ? "multi-locale"
            : "single-locale";
    console.log(`${name} → ${format}`);
}
```

```typescript
// Content: how does each filename parse? (mirrors ContentFileSource's rules)
const filenames: string[] = [
    "en.signup-email.html",
    "en.auth.welcome.md",
    "readme.txt",
    ".hidden.html",
    "nl.signup-email.html",
];

for (const filename of filenames) {
    const segments = filename.split(".");
    if (segments.length < 3) {
        console.log(`${filename} → skipped (needs at least <locale>.<key>.<ext>)`);
        continue;
    }
    const locale = segments[0];
    const key = segments.slice(1, -1).join(".");
    if (!locale || !key) {
        console.log(`${filename} → skipped (empty locale or key)`);
        continue;
    }
    console.log(`${filename} → locale="${locale}" key="${key}"`);
}
```

### 7. Keep the Node entry point out of browser bundles

When bundling fails or produces node-polyfill warnings, enforce a boundary between server and shared code.

1. Import `blendsdk/i18n-node` only from server-side modules.
2. Import `blendsdk/i18n` from anything shared with the browser.
3. After a production build, confirm no bundler warning mentions `node:fs` or `blendsdk/i18n-node`.

```typescript
// server/translations.ts — Node.js only, safe to touch the file system
import { JsonFileSource } from "blendsdk/i18n-node";
import type { TranslationCatalog } from "blendsdk/i18n";

export async function loadServerCatalog(): Promise<TranslationCatalog> {
    return new JsonFileSource({ paths: ["./translations/*.json"] }).load();
}
```

```typescript
// shared/translator.ts — imported by browser code, core import only
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

export function createTranslator(catalog: TranslationCatalog): Translator {
    return new Translator({ defaultLocale: "en", catalog });
}
```

---

## Known Pitfalls

These behaviors are correct by design but regularly surprise developers. Each one can silently produce the wrong translations or an empty catalog.

- **Files load in alphabetical order, and later files win.** Both file sources sort all resolved paths before loading, so the order you list entries in `paths` is not preserved once globs expand. For duplicate key + locale pairs, the alphabetically *last* absolute path wins. Name override files so they sort last (e.g. `zz-overrides.json`) — or, more robustly, keep precedence in `mergeCatalogs` across separate sources. The same applies within `ContentFileSource`: for the same key + locale, `.txt` sorts after `.md` after `.html`, so the `.txt` copy silently wins.

- **Catalog locale keys are matched exactly — only requests are normalized.** A request for `en-US` becomes `en_US` internally, but the catalog key you stored is used verbatim: `en-US`, `EN`, or `En_GB` entries can never be resolved. Fallback is also only one level deep: `zh_Hant_TW` tries `zh_Hant_TW`, then `zh` — it never tries `zh_Hant`. Stick to lower-case underscore locales everywhere.

- **Format auto-detection samples only the first value of a JSON file.** Reordering keys can flip a file's detected format and silently change what the values become (`[object Object]`, per-character locale entries). Keep one format per file and keep the first key representative of it.

- **`hasKey(key)` without a locale is not a resolution check.** It returns `true` if the key exists somewhere in the catalog, even when `translate(key, locale)` would fall back to the raw key. Always pass the locale when guarding UI paths.

- **`getTranslationsForLocale()` omits keys per locale.** Keys with no resolvable value are dropped, so different locales can return different key sets — merge each locale over a default-locale map before shipping to clients. Plural tuples are preserved (the client selects the form), and `${...}` interpolation is the consumer's job.

- **Catalogs and plural values are shared by reference.** `getCatalog()` returns the live catalog — mutating it changes behavior immediately, bypassing the atomic `setCatalog()` swap. And `mergeCatalogs()` copies entry objects but shares the underlying value arrays, so mutating a tuple in the merged result can mutate the source catalogs. Treat catalogs and values as immutable: build a new catalog, then call `setCatalog()`.

- **Content is stored exactly as written — including trailing newlines.** Editors append a final `\n` to `.html`/`.md`/`.txt` files, and that newline (plus any indentation) becomes part of the translated string. Trim at consumption if extra whitespace matters in subjects, titles, or single-line contexts.

- **A custom `extensions` array replaces the defaults.** Configuring `extensions: [".svg"]` disables `.html`, `.md`, and `.txt` loading entirely — there is no merging with the defaults. Always list every extension the project uses.

- **Plain paths behave asymmetrically across the two file sources.** `JsonFileSource`: a plain path is a file, and a missing one throws. `ContentFileSource`: a plain path is a directory listing, so a *file* path contributes nothing — silently — and missing directories are silent too. Log `Object.keys(catalog).length` after startup to catch path typos.

- **Globs match dotfiles and backup files.** `*.json` matches `.backup.json` (which becomes pseudo-locale `backup`) and `translations-old.json` (pseudo-locale `translations-old`). And globs are single-directory: a pattern like `./translations/**/*.json` puts the `**` in the directory part, matches nothing, and returns an empty catalog without error. Keep translation directories clean and avoid `**` entirely.

- **The same `count` parameter drives both plural selection and interpolation.** Numeric strings select the singular form but still interpolate, so `"5 book"` looks plausible; `NaN` selects singular *and* renders as `"NaN"`. Normalize counts to finite numbers at the boundary. Note also that a plain-string value never uses `count` for selection — it only interpolates.

- **The locale-parse cache grows with unique raw strings.** Every distinct locale string passed to `translate()`, `hasKey()`, or `getTranslationsForLocale()` is cached until `setCatalog()` clears it. If locale identifiers come from untrusted input (URLs, headers), validate them against a whitelist first — otherwise a hostile client can grow the cache one request at a time.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
