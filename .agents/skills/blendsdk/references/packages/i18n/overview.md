> **Package**: `blendsdk/i18n`

# i18n Overview

---

## What It Is

`blendsdk/i18n` is a runtime-agnostic internationalization (i18n) library for TypeScript applications, published by TrueSoftware B.V. under the MIT license as part of the BlendSDK v5 monorepo (ESM-first, strict TypeScript). It pairs a small, framework-free translation engine — `Translator` — with a pluggable source abstraction — `TranslationSource` — for loading translation catalogs from files, databases, or remote APIs. Catalogs map translation keys to per-locale values and support automatic locale fallback (`en_GB` → `en`), `[singular, plural]` tuples selected by a `count` parameter, and `${param}` string interpolation. The package ships two entry points: a browser-safe core at `blendsdk/i18n` that imports nothing from `node:*`, and a Node.js entry at `blendsdk/i18n-node` that adds file-based sources for JSON translation files and localized content such as HTML email templates, Markdown pages, and plain text.

---

## Key Features

- **Runtime-agnostic engine** — `Translator` runs unchanged in Node.js and browsers; the core entry point has no platform coupling.
- **Locale fallback chain** — exact locale match first (`en_GB`), then language-only (`en`), then the key returned as-is. Locale strings are normalized (`en-GB` → `en_GB`) and POSIX encodings (`.UTF-8`) are stripped.
- **Plural support** — values may be `[singular, plural]` tuples; a numeric `count` parameter selects the form (`count === 1` → singular, otherwise plural).
- **Interpolation** — `${param}` placeholders are resolved with `formatString` from `blendsdk/stdlib`.
- **Pluggable translation sources** — the `TranslationSource` interface (`name`, `load()`) makes backends interchangeable; implement it for databases, REST APIs, or pub/sub-driven reloads.
- **`JsonFileSource`** — loads JSON catalogs; auto-detects multi-locale (`{ key: { locale: value } }`) and single-locale (flat key/value, locale from filename) formats; supports simple `*`/`?` glob patterns.
- **`ContentFileSource`** — loads one file per key per locale using the `<locale>.<key>.<ext>` naming convention; content is stored as-is (HTML, Markdown, plain text) for emails, pages, and legal copy.
- **Catalog composition** — `mergeCatalogs([...])` merges catalogs in priority order (later wins) to layer defaults with overrides.
- **Atomic reloads** — `setCatalog()` swaps the catalog by reference, so in-flight translations are never disrupted.
- **Missing-translation hook** — `onMissingTranslation(key, locale)` callback on `Translator` for logging gaps during development.
- **Client export** — `getTranslationsForLocale(locale)` returns a flat key→value map (plural tuples kept intact) for serving translations to frontend clients.
- **Minimal footprint** — one runtime dependency (`blendsdk/stdlib`); no glob, ICU, or Intl-based third-party libraries.

---

## When To Use

Use `blendsdk/i18n` when you need:

- **Server-side translations** for APIs and server-rendered pages, including serving per-locale translation maps to frontend clients.
- **Browser bundles that stay browser-safe** — import the core entry point and keep `node:fs`/`node:path` out of Webpack, Vite, or esbuild output.
- **File-based translation workflows** — JSON catalogs in the repository, loaded at startup with glob patterns such as `./translations/*.json`.
- **Localized rich content** — one file per locale per key for HTML emails, Markdown pages, or legal text, loaded with `ContentFileSource`.
- **Layered overrides** — ship defaults in files and override them from a database or API via `mergeCatalogs` (later catalogs win).
- **Custom backends** — implement `TranslationSource` for REST APIs, databases, or pub/sub-triggered reloads.
- **Runtime translation updates** — atomically swap catalogs with `setCatalog()` while requests are being served.

Keep in mind:

- Plural handling is deliberately simple (singular vs. plural via `count === 1`); this is **not** a full ICU MessageFormat or `Intl.PluralRules` implementation.
- `JsonFileSource` and `ContentFileSource` are **Node.js-only**. In browsers, provide catalogs inline or via a custom `TranslationSource`.

---

## Architecture

The package is a three-layer pipeline that separates data acquisition from translation logic:

```text
  ┌───────────────────┐
  │   JsonFileSource  │──┐
  ├───────────────────┤  │
  │ ContentFileSource │──┼──▶ TranslationCatalog ──▶ mergeCatalogs([...])
  ├───────────────────┤  │      (normalized)          (optional, last wins)
  │   Custom source   │──┘             │
  └───────────────────┘                ▼
        Source layer               ┌────────────────┐       Engine layer
     TranslationSource             │   Translator   │──▶ translate(key, locale?, params?)
                                   └────────────────┘    fallback → plural → interpolation
```

The engine never touches the file system or network; conversely, sources never resolve fallbacks or interpolate strings. This separation is what allows the same `Translator` to run in a browser while `JsonFileSource` and `ContentFileSource` stay behind the Node.js-only entry point.

### Entry Points

| Import path | Runtime | Exports |
|---|---|---|
| `blendsdk/i18n` | Browser + Node.js | `Translator`, `mergeCatalogs`, `TranslationSource` (type), `TranslationValue`, `TranslationEntry`, `TranslationCatalog`, `TranslatorConfig`, `LocaleParts` |
| `blendsdk/i18n-node` | Node.js only | Re-exports the core plus `JsonFileSource`, `jsonFileSource`, `ContentFileSource`, `contentFileSource`, `JsonFileSourceConfig`, `ContentFileSourceConfig` |

### Module Layout

```text
src/
├── index.ts               # Browser-safe core entry point — no node:* imports
├── node.ts                # Node.js entry point — core + file-based sources
├── translator.ts          # Translator engine
├── translation-source.ts  # TranslationSource interface — the source contract
├── json-file-source.ts    # JsonFileSource + jsonFileSource() factory
├── content-file-source.ts # ContentFileSource + contentFileSource() factory
├── merge-catalogs.ts      # mergeCatalogs()
└── types.ts               # TranslationValue, TranslationEntry, TranslationCatalog, TranslatorConfig, LocaleParts
```

### Core Data Model

| Type | Definition | Description |
|---|---|---|
| `TranslationValue` | `string \| [singular: string, plural: string]` | One translated value; a tuple carries singular and plural forms |
| `TranslationEntry` | `Record<string, TranslationValue>` | One translation key mapped to its per-locale values |
| `TranslationCatalog` | `Record<string, TranslationEntry>` | Complete catalog of all keys; keys use dot notation by convention |
| `LocaleParts` | `{ full: string; language: string; region?: string }` | Parsed locale components |
| `TranslatorConfig` | `{ defaultLocale?: string; catalog?: TranslationCatalog; onMissingTranslation?: (key: string, locale: string) => void }` | Translator construction options |
| `TranslationSource` | `{ readonly name: string; load(): Promise<TranslationCatalog> }` | Contract every source implements |

### Design Patterns

| Pattern | Applied as |
|---|---|
| **Strategy** | `TranslationSource` is the interchangeable contract; `JsonFileSource`, `ContentFileSource`, and custom implementations plug into the same pipeline |
| **Adapter** | Each source normalizes its backend format (multi-locale JSON, single-locale JSON, content files) into the common `TranslationCatalog` |
| **Facade** | `Translator.translate()` hides locale parsing, fallback resolution, plural selection, and interpolation behind a single call |
| **Factory** | `jsonFileSource()` and `contentFileSource()` return pre-configured source instances for declarative configuration |
| **Layered composition** | `mergeCatalogs` applies catalogs in priority order (last wins) for defaults-plus-overrides setups |
| **Snapshot & atomic swap** | `setCatalog()` replaces the catalog by reference; ongoing translations read the previous snapshot |
| **Conditional exports** | The `exports` map splits the browser-safe core from the Node-only file sources |

### Translation Resolution

`translate(key, locale?, params?)` resolves in four steps:

1. **Parse locale** — strings like `en-GB.UTF-8` become `{ full: "en_GB", language: "en", region: "GB" }`; results are cached in a `Map` for O(1) reuse.
2. **Resolve value** — exact locale match first (`en_GB`), then language-only fallback (`en`). If nothing matches, `onMissingTranslation` fires and the key is returned unchanged.
3. **Select plural form** — a `[singular, plural]` tuple with a numeric `count` selects singular when `count === 1`, plural otherwise; without a valid count, singular is used.
4. **Interpolate** — `formatString` from `blendsdk/stdlib` replaces `${param}` placeholders with values from `params`.

---

## Dependencies

### Runtime Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `blendsdk/stdlib` | 5.x | `formatString` — `${param}` interpolation inside `Translator.translate()` |

`blendsdk/stdlib` is itself runtime-agnostic, so the core entry point remains browser-safe. There are **no peer dependencies** and no other runtime dependencies — no glob library, no ICU/Intl package.

### Development Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `typescript` | ^7.0.2 | Build (`tsc`) and strict type checking |
| `vitest` | ^4.1.10 | Unit test runner |
| `@types/node` | ^26.1.2 | Typings for the `node:*` modules used by the file sources |

### Runtime Requirements

- **Node.js >= 22.0.0** for `blendsdk/i18n-node` (imports `node:fs/promises` and `node:path`).
- Any modern JavaScript engine for the browser-safe core.

### Consumers and Dependents

- **Depends on**: `blendsdk/stdlib` (runtime only).
- **Depended on by**: BlendSDK applications and services. The factory functions return ready-to-wire instances for application or plugin configuration, for example: `sources: [jsonFileSource({ paths: ["./translations/*.json"] })]`.

---

## Minimum Example

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
        book: {
            en: ["${count} book", "${count} books"],
            nl: ["${count} boek", "${count} boeken"],
        },
    },
});

const greeting = translator.translate("greeting", "en", { name: "Alice" });
// → "Hello Alice"

const books = translator.translate("book", "nl", { count: 3 });
// → "3 boeken"

console.log(greeting, books);
```

For file-based catalogs, use the Node.js entry point instead: `import { Translator, JsonFileSource, ContentFileSource } from "blendsdk/i18n-node";` — the remaining documents in this training set cover source loading, catalog merging, and the full `Translator` API.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
