# @blendsdk/webafx-i18n

WebAFX i18n plugin with multi-source translation loading, locale resolution, and distributed reload.

## Features

- **WebAFX Plugin** — Drop-in `PluginDefinition` for WebAFX applications
- **Multi-Source Loading** — Load translations from JSON files, PostgreSQL, or custom sources
- **Locale Resolution** — Query param → Accept-Language → Cookie → Default priority chain
- **PostgreSQLSource** — Load translations from a database table
- **Pub/Sub Reload** — Distributed catalog reload via `@blendsdk/webafx-cache` pub/sub
- **Cookie Persistence** — Optionally persist user's locale preference

## Installation

```bash
yarn add @blendsdk/webafx-i18n
```

**Peer dependencies**: `@blendsdk/webafx` (required), `@blendsdk/webafx-cache` (optional, for pub/sub), `@blendsdk/postgresql` (optional, for DB source)

## Quick Start

```typescript
import { createI18nPlugin, jsonFileSource } from "@blendsdk/webafx-i18n";

app.use(createI18nPlugin({
    defaultLocale: "en",
    sources: [
        jsonFileSource({ paths: ["./translations/*.json"] }),
    ],
}));
```

## Using in a Controller

```typescript
async handler(req, res) {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");

    res.json({
        greeting: translator.translate("greeting", locale, { name: "Alice" }),
        locale,
    });
}
```

## PostgreSQL Source

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "@blendsdk/webafx-i18n";

app.use(createI18nPlugin({
    defaultLocale: "en",
    sources: [
        jsonFileSource({ paths: ["./translations/*.json"] }),  // Base translations
        postgresqlSource({ queryFn: (sql) => db.query(sql) }), // DB overrides
    ],
}));
```

**Expected table schema:**
```sql
CREATE TABLE translations (
    key    TEXT NOT NULL,
    locale TEXT NOT NULL,
    value  TEXT NOT NULL,
    PRIMARY KEY (key, locale)
);
```

Plural values are stored as JSON arrays: `["1 book","N books"]`.

## Pub/Sub Reload

```typescript
import { createI18nPlugin, jsonFileSource } from "@blendsdk/webafx-i18n";

app.use(createI18nPlugin({
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    reloadChannel: "i18n:reload",  // Subscribe to reload events
}));
```

Trigger reload from anywhere:
```typescript
const pubsub = await req.services.get<PubSubProvider>("pubsub");
await pubsub.publish("i18n:reload", { reason: "Admin triggered" });
```

## Locale Resolution Priority

1. `?locale=nl` query parameter
2. `Accept-Language: nl, en;q=0.8` header
3. `locale=nl` cookie
4. Default locale from config

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `sources` | `TranslationSource[]` | — | Translation sources to load |
| `defaultLocale` | `string` | `"en"` | Fallback locale |
| `serviceName` | `string` | `"i18n"` | Service container name for Translator |
| `localeServiceName` | `string` | `"locale"` | Service container name for resolved locale |
| `reloadChannel` | `string` | — | Pub/sub channel for distributed reload |
| `localeCookieName` | `string \| false` | `"locale"` | Cookie name for locale persistence |
| `onMissingTranslation` | `(key, locale) => void` | — | Callback for missing translations |
| `priority` | `number` | `40` | Plugin installation priority |

## License

MIT © TrueSoftware B.V.
