# @blendsdk/i18n

Runtime-agnostic internationalization (i18n) library for BlendSDK v5.

## Features

- **Translator** — Translation lookup with locale fallback, plural support, and `${param}` interpolation
- **TranslationSource** — Pluggable interface for loading translations from any backend
- **JsonFileSource** — Built-in source for JSON translation files (multi-locale and single-locale formats)
- **ContentFileSource** — Built-in source for content files (HTML, Markdown, plain text) with `<locale>.<key>.<ext>` naming convention
- **mergeCatalogs** — Ordered merge of multiple translation catalogs (later wins)
- **Locale Fallback** — `en_GB` → `en` automatic fallback chain
- **Plural Support** — `[singular, plural]` tuples with `count` parameter selection
- **Zero runtime dependencies** (only depends on `@blendsdk/stdlib`)

## Installation

```bash
yarn add @blendsdk/i18n
```

## Entry Points

The package provides two entry points to support both browser and Node.js environments:

| Import path | Contents | Runtime |
|---|---|---|
| `@blendsdk/i18n` | Translator, mergeCatalogs, types, TranslationSource interface | ✅ Browser + Node.js |
| `@blendsdk/i18n/node` | JsonFileSource, ContentFileSource + all core exports | Node.js only |

**Browser / React / frontend bundlers** — import from the base path:

```typescript
import { Translator, mergeCatalogs } from "@blendsdk/i18n";
import type { TranslationSource, TranslationCatalog } from "@blendsdk/i18n";
```

**Node.js / server-side** — import from `/node` for file-based sources:

```typescript
import { Translator, JsonFileSource, ContentFileSource } from "@blendsdk/i18n/node";
```

> The `/node` subpath re-exports everything from the base path, so you only need one import.

## Quick Start

```typescript
import { Translator } from "@blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
        farewell: { en: "Goodbye", nl: "Tot ziens" },
        book: {
            en: ["${count} book", "${count} books"],
            nl: ["${count} boek", "${count} boeken"],
        },
    },
});

translator.translate("greeting", "en", { name: "Alice" });
// → "Hello Alice"

translator.translate("book", "nl", { count: 3 });
// → "3 boeken"

translator.translate("farewell", "en_GB");
// → "Goodbye" (falls back to "en")
```

## Loading from JSON Files

### Multi-locale format (all locales in one file)

```json
{
    "greeting": { "en": "Hello ${name}", "nl": "Hallo ${name}" },
    "book": { "en": ["${count} book", "${count} books"] }
}
```

### Single-locale format (one file per locale)

`translations/en.json`:
```json
{ "greeting": "Hello", "farewell": "Goodbye" }
```

`translations/nl.json`:
```json
{ "greeting": "Hallo", "farewell": "Tot ziens" }
```

### Usage

```typescript
import { JsonFileSource } from "@blendsdk/i18n/node";

const source = new JsonFileSource({
    paths: ["./translations/*.json"],
});
const catalog = await source.load();
```

## Loading from Content Files

`ContentFileSource` loads translations from individual content files — HTML emails, Markdown pages, plain text — where each file represents **one translation key for one locale**. File content is read as UTF-8 and stored as-is (no transformation).

### File naming convention

Files must follow the pattern **`<locale>.<key>.<ext>`**:

| Filename | Locale | Key | Extension |
|---|---|---|---|
| `en.signup-email.html` | `en` | `signup-email` | `.html` |
| `nl.signup-email.html` | `nl` | `signup-email` | `.html` |
| `en.welcome-page.md` | `en` | `welcome-page` | `.md` |
| `en.auth.welcome.html` | `en` | `auth.welcome` | `.html` |
| `en.privacy-policy.txt` | `en` | `privacy-policy` | `.txt` |

- The **first** dot-segment is the locale
- The **last** dot-segment is the file extension (used for filtering)
- **Everything in between** is the translation key (supports multi-dot keys like `auth.welcome`)
- Files with fewer than 3 segments (e.g., `readme.txt`) are silently skipped
- Hidden files (dot-prefixed, e.g., `.hidden-file.html`) are silently skipped

### Example directory structure

```
content/
├── emails/
│   ├── en.signup-email.html
│   ├── nl.signup-email.html
│   ├── en.password-reset.html
│   └── nl.password-reset.html
└── pages/
    ├── en.welcome-page.md
    ├── nl.welcome-page.md
    └── en.privacy-policy.txt
```

`content/emails/en.signup-email.html`:
```html
<html>
<body>
<h1>Welcome, ${name}!</h1>
<p>Please click <a href="${activationUrl}">here</a> to activate your account.</p>
</body>
</html>
```

`content/pages/en.welcome-page.md`:
```markdown
# Welcome

Welcome to our application.
```

### Basic usage

```typescript
import { ContentFileSource } from "@blendsdk/i18n/node";

// Load all content files from a directory
const source = new ContentFileSource({
    paths: ["./content/emails"],
});
const catalog = await source.load();
// catalog["signup-email"]["en"] → "<html>...<h1>Welcome, ${name}!</h1>..."
// catalog["signup-email"]["nl"] → "<html>...<h1>Welkom, ${name}!</h1>..."
```

### Multiple directories

```typescript
const source = new ContentFileSource({
    paths: ["./content/emails", "./content/pages"],
});
const catalog = await source.load();
// Contains keys from both directories
```

### Glob patterns

```typescript
// Load only HTML files from a directory
const source = new ContentFileSource({
    paths: ["./content/emails/*.html"],
});
const catalog = await source.load();
```

### Custom extensions

By default, only `.html`, `.md`, and `.txt` files are loaded. You can override this:

```typescript
const source = new ContentFileSource({
    paths: ["./content/emails"],
    extensions: [".html", ".mjml"],
});
```

### Merging with JSON translations

Content files work seamlessly with `mergeCatalogs` — combine structured JSON translations with rich content files:

```typescript
import { JsonFileSource, ContentFileSource, mergeCatalogs, Translator } from "@blendsdk/i18n/node";

const jsonSource = new JsonFileSource({
    paths: ["./translations/*.json"],
});
const contentSource = new ContentFileSource({
    paths: ["./content/emails", "./content/pages"],
});

const [jsonCatalog, contentCatalog] = await Promise.all([
    jsonSource.load(),
    contentSource.load(),
]);

// Merge: later catalogs win on conflict
const catalog = mergeCatalogs([jsonCatalog, contentCatalog]);

const translator = new Translator({ defaultLocale: "en", catalog });

translator.translate("greeting", "en", { name: "Alice" });
// → "Hello Alice" (from JSON)

translator.translate("signup-email", "en", { name: "Alice", activationUrl: "/activate/abc" });
// → "<html>...<h1>Welcome, Alice!</h1>..." (from content file)
```

### Factory function

A convenience factory `contentFileSource()` is also available:

```typescript
import { contentFileSource } from "@blendsdk/i18n/node";

const source = contentFileSource({ paths: ["./content/emails"] });
const catalog = await source.load();
```

## Custom Translation Source

```typescript
import type { TranslationSource, TranslationCatalog } from "@blendsdk/i18n";

class MyApiSource implements TranslationSource {
    readonly name = "MyApiSource";

    async load(): Promise<TranslationCatalog> {
        const response = await fetch("https://api.example.com/translations");
        return response.json();
    }
}
```

## API

### `Translator`

| Method | Description |
|---|---|
| `translate(key, locale?, params?)` | Translate a key with interpolation |
| `getTranslationsForLocale(locale)` | Get all translations for a locale |
| `hasKey(key, locale?)` | Check if a key exists |
| `setCatalog(catalog)` | Atomically replace the catalog |
| `getCatalog()` | Get the current catalog |
| `getDefaultLocale()` | Get the default locale |

### `ContentFileSource`

| Option | Type | Default | Description |
|---|---|---|---|
| `paths` | `string[]` | *(required)* | Directory paths or glob patterns to scan |
| `extensions` | `string[]` | `[".html", ".md", ".txt"]` | File extensions to include |

### `contentFileSource(config)`

Convenience factory — returns a new `ContentFileSource` instance.

### `mergeCatalogs(catalogs[])`

Merge multiple catalogs — later catalogs override earlier for same key+locale.

## License

MIT © TrueSoftware B.V.
