> **Package**: `blendsdk/webafx-i18n`

# webafx-i18n Overview

---

## What It Is

`blendsdk/webafx-i18n` is the WebAFX plugin package for server-side internationalization. It wraps the browser-safe `blendsdk/i18n` core in a drop-in `PluginDefinition`: during application startup it loads translations from one or more ordered sources (JSON files, a PostgreSQL table, or custom `TranslationSource` implementations), merges them into a single catalog, and registers a `Translator` as a singleton service in the WebAFX service container. It also registers a per-request `locale` service that resolves each request's language using a documented priority chain (query parameter → `Accept-Language` → cookie → default), optionally persists that choice in a cookie, and can refresh the catalog at runtime — manually through a reload service or via a distributed pub/sub channel.

---

## Key Features

- **WebAFX `PluginDefinition`** — `createI18nPlugin(config)` integrates with the WebAFX plugin pipeline (default priority 40, configurable).
- **Multi-source translation loading** — sources are loaded in order and merged; later sources override earlier ones for the same key + locale (for example, database rows override file-based base translations).
- **Pluggable `TranslationSource` strategy** — built-in `PostgreSQLSource` plus the Node.js file sources (`JsonFileSource`, `ContentFileSource`) re-exported from `blendsdk/i18n-node`; any object with `name` and `load()` works as a source.
- **PostgreSQLSource** — reads a `key / locale / value` table through a decoupled `queryFn` callback, supports a custom table name and `WHERE` filter, and parses plural values stored as JSON arrays.
- **Locale resolution chain** — `?locale=` query param → `Accept-Language` header (q-value sorted, `en-US` normalized to `en_US`) → cookie → configured default.
- **Cookie persistence** — the resolved locale is written to a cookie (name configurable, disable entirely with `false`).
- **Runtime and distributed reload** — an `i18n:reload` service reloads all sources and atomically swaps the catalog; an optional `reloadChannel` subscribes to pub/sub via `blendsdk/webafx-cache`. A failed reload keeps the previous catalog.
- **Missing-translation hook** — `onMissingTranslation(key, locale)` is forwarded to the `Translator` for logging or metrics.
- **Health check** — the plugin exposes a `health()` hook that reports the service is alive.

---

## When To Use

Use this package when:

- You are building a multilingual WebAFX server and want translations available through the service container (`i18n` and `locale` services).
- Translations come from more than one place — static JSON files for base strings plus PostgreSQL rows maintained by administrators, for example.
- You need per-request locale negotiation based on query parameters, `Accept-Language`, and cookies.
- You run multiple app instances and need to refresh translations without redeploying, via pub/sub.
- You store plural forms (for example `["1 book","N books"]`) in a database table.

Do not use this package for browser-only translation work — import `blendsdk/i18n` directly there. The WebAFX plugin only adds server-side source loading, locale resolution, and reload orchestration on top of the core translator.

---

## Architecture

The package is intentionally thin: all translation logic lives in `blendsdk/i18n`. This package provides the WebAFX integration layer — lifecycle-managed loading, service registration, request-scoped locale resolution, and reload coordination. It moves through three phases:

```
STARTUP — plugin factory, runs once at application boot
───────────────────────────────────────────────────────
  Source[0] ─┐   loaded in order; later sources override earlier
  Source[1] ─┼─► mergeCatalogs() ─► Translator ─► singleton service "i18n"
  Source[N] ─┘     (later wins)      + setCatalog() + singleton "i18n:reload"
                                                    + per-request "locale"

REQUEST — once per HTTP request
───────────────────────────────
  req ─► resolveLocale() ─► "locale" service ─► Translator.translate(key, locale)
         query > Accept-Language > cookie > default
         (resolved locale persisted to a cookie, unless disabled)

RELOAD — manual or distributed
──────────────────────────────
  "i18n:reload" service  OR  pub/sub "reloadChannel"
        └─► reload all sources ─► translator.setCatalog()
            on failure: previous catalog is kept
```

Key design patterns:

| Pattern | Where | Purpose |
|---|---|---|
| Plugin | `createI18nPlugin()` returns a `PluginDefinition` with `factory` and `health` hooks | Lifecycle integration with the WebAFX pipeline |
| Factory function | `createI18nPlugin`, `postgresqlSource`, `jsonFileSource`, `contentFileSource` | Convenience constructors — no `new` required in config |
| Strategy | `TranslationSource` (`PostgreSQLSource`, file sources, custom implementations) | Interchangeable translation backends behind one `load()` contract |
| Singleton service | `Translator` registered under `"i18n"` | One merged catalog shared by all requests |
| Per-request service | `"locale"` registered with `type: "per-request"` | Locale resolved (and cookie-persisted) per request |
| Observer (pub/sub) | Optional subscription to `reloadChannel` | Distributed catalog invalidation across app instances |
| Adapter / dependency inversion | `PostgreSQLSource` consumes a `queryFn` callback instead of a client | The source stays decoupled from any concrete database driver |
| Graceful degradation | `reloadSources()` catches errors and keeps the old catalog | Reload failures never take the application down |

A few rules worth remembering:

- The merged catalog has the shape `Record<translationKey, Record<locale, string | [string, string]>>`; a two-element tuple holds the `[singular, plural]` forms.
- The locale resolver operates on the Express-style `Request` object available in WebAFX handlers (`query`, `headers`, `cookies`).
- If the pub/sub service is not registered (for example, `blendsdk/webafx-cache` is not installed), the plugin logs that the reload channel is inactive and continues normally.

---

## Dependencies

**Runtime dependency**

- `blendsdk/i18n` (5.x) — the translation core: `Translator`, `mergeCatalogs`, `TranslationSource`/catalog types, and the Node.js-only file sources re-exported through this package.

**Peer dependencies**

| Package | Status | Purpose |
|---|---|---|
| `blendsdk/webafx` | Required | Host framework: plugin pipeline, service container, `Logger` |
| `blendsdk/webafx-cache` | Optional | Provides the pub/sub provider used when `reloadChannel` is set |
| `blendsdk/postgresql` | Optional | Convenience for wiring `PostgreSQLSource.queryFn` to a BlendSDK database; any function returning rows works |

**What depends on it**

Within the monorepo this is a leaf package — no other `blendsdk/*` package imports it. It is consumed by WebAFX applications that need server-side internationalization.

---

## Minimum Example

Create the plugin with a file source, install it on the application, and read translations per request:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

// 1. Create the plugin with ordered translation sources
const i18n = createI18nPlugin({
    defaultLocale: "en",
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
});

// 2. Install it on the WebAFX application (`app` is your WebAFX instance)
app.use(i18n);

// 3. Resolve the Translator and the request locale in any handler
async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");
    res.json({ message: translator.translate("greeting", locale) });
}
```

After installation, the plugin has registered three services: `i18n` (singleton `Translator`), `i18n:reload` (singleton reload function), and `locale` (per-request resolved locale).

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
