# Internationalization Pattern

> Add multi-language support with translation catalogs, JSON files, and content files.

**Packages:** `i18n`, `webafx-i18n`, `stdlib`

---

## Problem

How do I add multi-language support to my application with locale fallback and interpolation?

## Solution

### Basic Translator Usage

```typescript
import { Translator } from 'blendsdk/i18n';

const translator = new Translator({
  defaultLocale: 'en',
  catalog: {
    greeting: { en: 'Hello ${name}', nl: 'Hallo ${name}', de: 'Hallo ${name}' },
    farewell: { en: 'Goodbye', nl: 'Tot ziens', de: 'Auf Wiedersehen' },
    book: {
      en: ['${count} book', '${count} books'],       // Plural support
      nl: ['${count} boek', '${count} boeken'],
    },
  },
});

translator.translate('greeting', 'en', { name: 'Alice' });
// → "Hello Alice"

translator.translate('book', 'nl', { count: 3 });
// → "3 boeken"

translator.translate('farewell', 'en_GB');
// → "Goodbye" (falls back: en_GB → en)
```

### Loading from JSON Files

**Multi-locale format** (`translations/app.json`):
```json
{
  "greeting": { "en": "Hello ${name}", "nl": "Hallo ${name}" },
  "book": { "en": ["${count} book", "${count} books"] }
}
```

**Single-locale format** (`translations/en.json` + `translations/nl.json`):
```json
{ "greeting": "Hello", "farewell": "Goodbye" }
```

```typescript
import { JsonFileSource } from 'blendsdk/i18n-node';

const source = new JsonFileSource({
  paths: ['./translations/*.json'],
});
const catalog = await source.load();
const translator = new Translator({ defaultLocale: 'en', catalog });
```

### Loading from Content Files (HTML, Markdown)

Content files use the naming convention `<locale>.<key>.<ext>`:

```
content/emails/
├── en.welcome-email.html
├── nl.welcome-email.html
├── en.password-reset.html
└── nl.password-reset.html
```

```typescript
import { ContentFileSource, mergeCatalogs, Translator } from 'blendsdk/i18n-node';

const contentSource = new ContentFileSource({
  paths: ['./content/emails'],
  extensions: ['.html', '.md', '.txt'], // Default extensions
});
const contentCatalog = await contentSource.load();
// contentCatalog['welcome-email']['en'] → "<html>...<h1>Welcome, ${name}!</h1>..."
```

### Merging Multiple Sources

```typescript
import { JsonFileSource, ContentFileSource, mergeCatalogs, Translator } from 'blendsdk/i18n-node';

const [jsonCatalog, contentCatalog] = await Promise.all([
  new JsonFileSource({ paths: ['./translations/*.json'] }).load(),
  new ContentFileSource({ paths: ['./content/emails'] }).load(),
]);

// Merge: later catalogs win on key+locale conflicts
const catalog = mergeCatalogs([jsonCatalog, contentCatalog]);
const translator = new Translator({ defaultLocale: 'en', catalog });

translator.translate('greeting', 'en', { name: 'Alice' });
// → "Hello Alice" (from JSON)

translator.translate('welcome-email', 'en', { name: 'Alice', url: '/activate' });
// → "<html>..." (from content file, with interpolation)
```

### Custom Translation Source

```typescript
import type { TranslationSource, TranslationCatalog } from 'blendsdk/i18n';

class ApiTranslationSource implements TranslationSource {
  readonly name = 'ApiSource';

  async load(): Promise<TranslationCatalog> {
    const response = await fetch('https://api.example.com/translations');
    return response.json();
  }
}
```

### WebAFX i18n Plugin (webafx-i18n)

```typescript
import { WebApplication } from 'blendsdk/webafx';
// webafx-i18n provides locale resolution from Accept-Language header,
// PostgreSQL-backed translation source, and integration with the webafx plugin system
```

## Key Points

- **Locale fallback chain**: `en_GB` → `en` → default locale (automatic)
- **Plural support**: `[singular, plural]` tuples selected by `count` parameter
- **`${param}` interpolation**: simple string replacement in translations
- **Two entry points**: `blendsdk/i18n` (browser-safe) and `blendsdk/i18n-node` (file sources)
- **`mergeCatalogs()`**: ordered merge — later catalogs override earlier per key+locale
- **ContentFileSource**: `<locale>.<key>.<ext>` naming — supports multi-dot keys
- **Zero dependencies**: only depends on `blendsdk/stdlib`
