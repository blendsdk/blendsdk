> **Package**: `blendsdk/i18n`

# i18n Advanced Patterns

This document covers composition patterns that combine multiple features of `blendsdk/i18n`: layered catalogs, custom `TranslationSource` implementations, resilient reloads, client payload pipelines, and content workflows. Every pattern solves a concrete production problem and builds only on the public API described in Core Concepts and Overview.

---

## Pattern Index

| # | Pattern | Problem it solves |
|---|---|---|
| 1 | [Layered Catalog Assembly](#pattern-1-layered-catalog-assembly) | Multiple translation owners: defaults, rich content, runtime overrides |
| 2 | [Custom TranslationSource for a Database](#pattern-2-custom-translationsource-for-a-database) | Translations managed outside the repository, edited at runtime |
| 3 | [Resilient Reload Pipeline](#pattern-3-resilient-reload-pipeline) | Live translation updates without restarts and without blanking out on failures |
| 4 | [Source Decorators: Retry and Cache](#pattern-4-source-decorators-retry-and-cache) | Slow or flaky backends behind a stable `TranslationSource` contract |
| 5 | [Serving Namespaced Client Bundles](#pattern-5-serving-namespaced-client-bundles) | Shipping only the translations a frontend needs, plural forms intact |
| 6 | [Browser Runtime Locale Switching](#pattern-6-browser-runtime-locale-switching) | Switching UI language at runtime with the same engine as the server |
| 7 | [Development Audit and CI Coverage Gate](#pattern-7-development-audit-and-ci-coverage-gate) | Catching missing and untranslated keys before users do |
| 8 | [Regional Locales and Custom Fallback Chains](#pattern-8-regional-locales-and-custom-fallback-chains) | Regional variants (en_GB, pt_BR) without duplicating full catalogs |
| 9 | [Localized Rich Content End-to-End](#pattern-9-localized-rich-content-end-to-end) | HTML email bodies and pages owned by content editors, rendered with typed data |

---

## Pattern 1: Layered Catalog Assembly

**When to use it**: your translations come from more than one place — a large JSON base written by developers, rich content files (HTML emails, Markdown pages), and a small override layer for customer-specific or A/B wording — and you want each layer to have a clear owner and priority.

### Implementation

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import { ContentFileSource, JsonFileSource } from "blendsdk/i18n-node";
import type { TranslationCatalog } from "blendsdk/i18n";

// Layer 1 (lowest priority): shared UI strings, one JSON set per locale.
const baseCatalog: TranslationCatalog = await new JsonFileSource({
    paths: ["./translations/*.json"],
}).load();

// Layer 2: rich content — emails and pages, one file per key per locale.
const contentCatalog: TranslationCatalog = await new ContentFileSource({
    paths: ["./content/emails", "./content/pages"],
}).load();

// Layer 3 (highest priority): overrides — customer wording, feature flags, hotfixes.
const overrideCatalog: TranslationCatalog = await new JsonFileSource({
    paths: ["./overrides/*.json"],
}).load();

const translator = new Translator({
    defaultLocale: "en",
    catalog: mergeCatalogs([baseCatalog, contentCatalog, overrideCatalog]),
});

console.log(translator.translate("greeting", "nl", { name: "Alice" }));
// "Hallo Alice" — unless an override file redefined "greeting" for "nl"
```

If the layers are independent, load them concurrently — `Promise.all` preserves array order, so the merge priority stays exactly as written:

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import { ContentFileSource, JsonFileSource } from "blendsdk/i18n-node";

const [baseCatalog, contentCatalog, overrideCatalog] = await Promise.all([
    new JsonFileSource({ paths: ["./translations/*.json"] }).load(),
    new ContentFileSource({ paths: ["./content/emails", "./content/pages"] }).load(),
    new JsonFileSource({ paths: ["./overrides/*.json"] }).load(),
]);

const translator = new Translator({
    defaultLocale: "en",
    catalog: mergeCatalogs([baseCatalog, contentCatalog, overrideCatalog]),
});
```

### Why this pattern is valuable

| | Before | After |
|---|---|---|
| Ownership | One growing file per locale, edited by everyone | Defaults, content, and overrides have separate owners and directories |
| Conflict risk | Manual naming discipline | Priority is structural: later layers win per key + locale |
| Optional layers | Special-casing per environment | Glob paths that match nothing contribute an empty catalog |

The override layer can be absent in development without any code changes: a glob such as `./overrides/*.json` against a missing directory resolves to zero files, so the merge simply skips it.

### Caveats and performance considerations

- **Merge granularity is per key + locale.** If an override layer provides `greeting: { nl: "Hoi" }`, only the `nl` value is replaced; the `en` value survives. But a plural tuple is replaced wholesale — you cannot override only the plural form of `["${count} artikel", "${count} artikelen"]`.
- **A missing plain file path throws** (for example `./overrides/site.json` that does not exist), while a **missing glob directory silently matches nothing**. Express optional layers as globs; express required files as plain paths so startup fails loudly.
- **Load once.** Sources read from disk; assembling the catalog is a startup (or reload) operation, not something to run per request.
- Relative paths resolve against `process.cwd()`, so run the process from the project root or use absolute paths.

---

## Pattern 2: Custom TranslationSource for a Database

**When to use it**: translators or admins edit wording in a database or admin panel, and the file-based catalogs in the repository should act as defaults beneath those edits.

### Implementation

`TranslationSource` is intentionally minimal — `name` plus `load()` — so a database backend needs no adapter libraries:

```typescript
import type { TranslationCatalog, TranslationSource, TranslationValue } from "blendsdk/i18n";

/** One row from the translations table. */
export interface TranslationRow {
    key: string;
    locale: string;
    singular: string;
    plural: string | null;
}

/** Minimal data-access contract — satisfied by a SQL client, an ORM, or a REST wrapper. */
export interface TranslationTableClient {
    selectAll(): Promise<TranslationRow[]>;
}

export function rowToValue(row: TranslationRow): TranslationValue {
    return row.plural === null ? row.singular : [row.singular, row.plural];
}

export class DatabaseSource implements TranslationSource {
    readonly name = "DatabaseSource";

    protected readonly client: TranslationTableClient;

    constructor(client: TranslationTableClient) {
        this.client = client;
    }

    async load(): Promise<TranslationCatalog> {
        const rows = await this.client.selectAll();
        const catalog: TranslationCatalog = {};

        for (const row of rows) {
            if (!row.key || !row.locale) {
                throw new Error(`Invalid translation row: key="${row.key}", locale="${row.locale}"`);
            }
            const entry = catalog[row.key] ?? {};
            entry[row.locale] = rowToValue(row);
            catalog[row.key] = entry;
        }

        return catalog;
    }
}

/** In-memory stand-in for the real database client (used in tests and examples). */
export class InMemoryTable implements TranslationTableClient {
    constructor(protected readonly rows: TranslationRow[]) {}

    async selectAll(): Promise<TranslationRow[]> {
        return this.rows;
    }
}
```

Wire the database layer on top of the file defaults:

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import { JsonFileSource } from "blendsdk/i18n-node";
import { DatabaseSource, InMemoryTable } from "./database-source.js";

const overrides = new InMemoryTable([
    { key: "checkout.total", locale: "en", singular: "Total: ${amount}", plural: null },
    { key: "checkout.total", locale: "nl", singular: "Totaal: ${amount}", plural: null },
    { key: "cart.items", locale: "en", singular: "${count} item", plural: "${count} items" },
]);

const fileCatalog = await new JsonFileSource({ paths: ["./translations/*.json"] }).load();
const databaseCatalog = await new DatabaseSource(overrides).load();

const translator = new Translator({
    defaultLocale: "en",
    catalog: mergeCatalogs([fileCatalog, databaseCatalog]),
});

console.log(translator.translate("cart.items", "en", { count: 4 }));
// "4 items" — from the database layer
```

### Why this pattern is valuable

- The engine never knows where data came from — swapping or adding backends never touches `Translator` or existing sources.
- The tiny `TranslationTableClient` interface keeps the source unit-testable (`InMemoryTable`) and storage-agnostic. In a full BlendSDK stack the client typically wraps the database layer; because only the interface is imported, the source stays decoupled and mockable.
- Database rows normalize into the same `TranslationValue` shapes as JSON files (`plural: null` → string, otherwise a `[singular, plural]` tuple), so merging with file catalogs just works.

### Caveats and performance considerations

- **Fail fast at load time.** `load()` throws on malformed rows with a key/locale in the message; the merge pipeline treats that as a source failure (see [Pattern 3](#pattern-3-resilient-reload-pipeline)), so validation happens at the boundary, not at render time.
- **Duplicate key + locale rows** follow last-row-wins semantics within the source. If your table is versioned, make the query return only published rows or order them explicitly before building the catalog.
- **One query per `load()` call.** For slow backends, decorate with `CachingSource` from [Pattern 4](#pattern-4-source-decorators-retry-and-cache) rather than caching inside the source, so cache and retry policies stay composable.

---

## Pattern 3: Resilient Reload Pipeline

**When to use it**: translations change at runtime — an admin panel or CMS publishes edits — and running processes must pick them up without restarts, without dropping to empty catalogs when a backend is temporarily unavailable, and without stampeding a backend when an editor saves repeatedly.

### Implementation

The runtime owns the `Translator`, the ordered sources, and every reload concern. Two ideas make it resilient: **per-source last-good catalogs** (a failing source degrades to its previous data instead of blanking the merge) and **coalescing + debouncing** (bursts of notifications collapse into one reload).

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/i18n";

/** Minimal event subscription contract — satisfied by a pub/sub client in a BlendSDK stack. */
export interface ReloadNotifier {
    on(event: string, handler: () => void): void;
}

export interface I18nRuntimeOptions {
    sources: TranslationSource[];
    defaultLocale?: string;
    initialCatalog?: TranslationCatalog;
}

export class I18nRuntime {
    readonly translator: Translator;

    protected readonly sources: TranslationSource[];
    protected readonly lastGoodCatalogs = new Map<string, TranslationCatalog>();
    protected inFlight: Promise<void> | null = null;
    protected debounceTimer: ReturnType<typeof setTimeout> | undefined = undefined;

    constructor(options: I18nRuntimeOptions) {
        this.sources = options.sources;
        this.translator = new Translator({
            defaultLocale: options.defaultLocale ?? "en",
            catalog: options.initialCatalog ?? {},
        });
    }

    /**
     * Load every source in parallel and merge the results in source order.
     * A failing source is replaced by its last good catalog when one exists,
     * so a single outage never blanks out the merged result.
     */
    protected async buildCatalog(): Promise<TranslationCatalog> {
        const layers = await Promise.all(
            this.sources.map(async (source): Promise<TranslationCatalog> => {
                try {
                    const catalog = await source.load();
                    this.lastGoodCatalogs.set(source.name, catalog);
                    return catalog;
                } catch (error: unknown) {
                    const previous = this.lastGoodCatalogs.get(source.name);
                    if (previous === undefined) {
                        throw new Error(
                            `Translation source "${source.name}" failed on first load: ` +
                                (error instanceof Error ? error.message : String(error))
                        );
                    }
                    console.warn(`[i18n] source "${source.name}" unavailable — using last good catalog`);
                    return previous;
                }
            })
        );

        return mergeCatalogs(layers);
    }

    /**
     * Rebuild the merged catalog and swap it in atomically.
     * Concurrent calls share a single in-flight reload.
     */
    async reload(): Promise<void> {
        if (this.inFlight !== null) {
            return this.inFlight;
        }

        const reloadPromise = (async (): Promise<void> => {
            try {
                const catalog = await this.buildCatalog();
                this.translator.setCatalog(catalog);
                console.info(`[i18n] catalog reloaded: ${Object.keys(catalog).length} keys`);
            } finally {
                this.inFlight = null;
            }
        })();

        this.inFlight = reloadPromise;
        return reloadPromise;
    }

    /** Subscribe to change events; bursts collapse into one reload after the debounce window. */
    attach(notifier: ReloadNotifier, event: string, debounceMs = 250): void {
        notifier.on(event, (): void => {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout((): void => {
                this.reload().catch((error: unknown): void => {
                    console.error("[i18n] reload failed — current catalog kept", error);
                });
            }, debounceMs);
        });
    }

    dispose(): void {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
    }
}

/** Tiny notifier used in tests and standalone scripts. */
export class SimpleNotifier implements ReloadNotifier {
    protected readonly handlers = new Map<string, Array<() => void>>();

    on(event: string, handler: () => void): void {
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
    }

    emit(event: string): void {
        for (const handler of this.handlers.get(event) ?? []) {
            handler();
        }
    }
}
```

Startup and reload wiring:

```typescript
import { jsonFileSource } from "blendsdk/i18n-node";
import { DatabaseSource, InMemoryTable } from "./database-source.js";
import { I18nRuntime, SimpleNotifier } from "./i18n-runtime.js";

const dbOverrides = new InMemoryTable([
    { key: "greeting", locale: "nl", singular: "Hoi", plural: null },
]);

const runtime = new I18nRuntime({
    sources: [
        jsonFileSource({ paths: ["./translations/*.json"] }),
        new DatabaseSource(dbOverrides),
    ],
    defaultLocale: "en",
});

try {
    await runtime.reload();
} catch (error: unknown) {
    console.error("[i18n] initial catalog load failed", error);
    throw error; // fail fast: never start serving without translations
}

const notifier = new SimpleNotifier();
runtime.attach(notifier, "translations:changed");

// An editor saves a change in the admin panel; in production the pub/sub
// client fans this event out to every application instance:
notifier.emit("translations:changed");

await new Promise<void>((resolve): void => {
    setTimeout(resolve, 300); // wait out the debounce window in this example
});

console.log(runtime.translator.translate("greeting", "nl")); // "Hoi" — database override applied
```

### Why this pattern is valuable

- **Zero-downtime updates**: `setCatalog()` swaps the catalog by reference, so calls that started before the swap finish against the old catalog and later calls use the new one — no partial state ever exists.
- **Graceful degradation**: an unreachable database serves its last good data instead of erasing the layer; only a *first* load failure aborts (and that should abort startup).
- **Backend protection**: editing bursts collapse into one reload via debounce; overlapping triggers collapse into one in-flight promise via coalescing.

### Caveats and performance considerations

- **Source `name` values must be unique within one runtime** — the last-good map is keyed by `source.name`. Two `JsonFileSource` instances stacked in the same runtime would collide; give one of them a decorated or distinct name (see [Pattern 4](#pattern-4-source-decorators-retry-and-cache)).
- **Reload cost is O(total keys)** because every reload rebuilds and copies the merged catalog. That is fine for human-triggered frequency; it is not fine as a per-request strategy.
- **`setCatalog()` clears the locale-parse cache**, so the first lookups after a reload re-parse their locale strings. This is negligible but explains a small warm-up after reloads.
- **Events must reach every instance.** An in-process notifier only reloads one process; in a multi-instance deployment publish change events through a shared channel (in a BlendSDK stack, the pub/sub client satisfies `ReloadNotifier` directly).
- Call `dispose()` during graceful shutdown so a pending debounce timer does not fire against a closing process; in tests, prefer calling `await runtime.reload()` directly and skip timers entirely.

---

## Pattern 4: Source Decorators: Retry and Cache

**When to use it**: a source is slow (remote API), flaky (network timeouts), or both, and you want retry and caching behavior without modifying any source implementation — and without changing how the reload pipeline consumes sources.

### Implementation

Both decorators implement `TranslationSource`, so they slot into any `sources` array:

```typescript
import type { TranslationCatalog, TranslationSource } from "blendsdk/i18n";

export interface RetryOptions {
    attempts: number;
    delayMs: number;
}

/** Retries a failing source with linear backoff before giving up. */
export class RetryingSource implements TranslationSource {
    readonly name: string;

    constructor(
        protected readonly inner: TranslationSource,
        protected readonly options: RetryOptions
    ) {
        if (options.attempts < 1) {
            throw new Error("RetryOptions.attempts must be at least 1");
        }
        this.name = `${inner.name}+retry`;
    }

    async load(): Promise<TranslationCatalog> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.inner.load();
            } catch (error: unknown) {
                if (attempt >= this.options.attempts) {
                    throw new Error(
                        `Source "${this.inner.name}" failed after ${attempt} attempt(s): ` +
                            (error instanceof Error ? error.message : String(error))
                    );
                }
                await new Promise<void>((resolve): void => {
                    setTimeout(resolve, this.options.delayMs * attempt);
                });
            }
        }
    }
}

/** Serves the previous result for a TTL window; invalidate() drops it explicitly. */
export class CachingSource implements TranslationSource {
    readonly name: string;

    protected cached: TranslationCatalog | undefined = undefined;
    protected cachedAt = 0;

    constructor(
        protected readonly inner: TranslationSource,
        protected readonly ttlMs: number
    ) {
        this.name = `${inner.name}+cache`;
    }

    async load(): Promise<TranslationCatalog> {
        const now = Date.now();
        if (this.cached !== undefined && now - this.cachedAt < this.ttlMs) {
            return this.cached;
        }

        const fresh = await this.inner.load();
        this.cached = fresh;
        this.cachedAt = Date.now();
        return fresh;
    }

    invalidate(): void {
        this.cached = undefined;
        this.cachedAt = 0;
    }
}
```

Compose them with the reload pipeline and invalidate explicitly when the admin publishes a change:

```typescript
import { jsonFileSource } from "blendsdk/i18n-node";
import { DatabaseSource, InMemoryTable } from "./database-source.js";
import { I18nRuntime, SimpleNotifier } from "./i18n-runtime.js";
import { CachingSource, RetryingSource } from "./source-decorators.js";

const dbClient = new InMemoryTable([
    { key: "plan.name", locale: "en", singular: "Pro plan", plural: null },
]);

const database = new CachingSource(
    new RetryingSource(new DatabaseSource(dbClient), { attempts: 3, delayMs: 200 }),
    30_000
);

const runtime = new I18nRuntime({
    sources: [jsonFileSource({ paths: ["./translations/*.json"] }), database],
    defaultLocale: "en",
});

const notifier = new SimpleNotifier();
notifier.on("translations:changed", (): void => {
    database.invalidate(); // drop stale cache before the debounced reload runs
});
runtime.attach(notifier, "translations:changed");

await runtime.reload();
console.log(runtime.translator.translate("plan.name", "en")); // "Pro plan"
```

### Why this pattern is valuable

- **Cross-cutting behavior stays out of sources.** `DatabaseSource` knows nothing about retries or TTLs; policies are composed at configuration time and can differ per environment (aggressive caching in production, `ttlMs: 0` in tests).
- **Decorators keep reload semantics intact.** With an explicit `invalidate()` wired to the change event, the TTL only guards *unattended* reloads; intentional reloads always see fresh data.
- **Decorated names stay unique** (`"DatabaseSource+retry+cache"`), so the runtime's last-good map from [Pattern 3](#pattern-3-resilient-reload-pipeline) keeps working.

### Caveats and performance considerations

- **Cache placement determines retry behavior.** Compose `CachingSource(RetryingSource(inner))` as above: cache hits never touch the inner source; misses retry. Inverting the order retries cached reads, which is pointless.
- **Retries add latency to the reload path.** Worst-case time is roughly `attempts × (source timeout + delayMs × attempt)`. Keep `attempts` small (2–3) and remember the in-flight coalescing already prevents concurrent reload storms.
- **`load()` must stay read-only** for retries to be safe — both built-in sources and the `DatabaseSource` example are, and custom sources should be too.
- **A stale TTL window delays propagation by design.** If edits must propagate immediately, wire `invalidate()` to the change event as shown; if they must never propagate stale data, use `ttlMs: 0` or drop the cache in front of that source.

---

## Pattern 5: Serving Namespaced Client Bundles

**When to use it**: a Single Page Application needs translations from the server, but shipping the whole catalog is wasteful and the client must keep plural tuples so it can select forms at render time based on live counts.

### Implementation

The bundle builder resolves the **best available template per key** (requested locale first, then fallbacks) and labels the bundle with the requested locale. The server resolves *which wording* to use; the client interpolates actual values (names, counts) at render time:

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationValue } from "blendsdk/i18n";

export interface LocaleBundle {
    locale: string;
    keys: Record<string, TranslationValue>;
}

/**
 * Build a namespace bundle for one locale.
 * Per key, the first locale in [requestedLocale, ...fallbackLocales] that has
 * a value wins. Plural tuples ship intact — the client selects the form.
 */
export function buildLocaleBundle(
    translator: Translator,
    requestedLocale: string,
    fallbackLocales: string[],
    namespace: string
): LocaleBundle {
    const prefix = `${namespace}.`;
    const keys: Record<string, TranslationValue> = {};

    for (const locale of [requestedLocale, ...fallbackLocales]) {
        for (const [key, value] of Object.entries(translator.getTranslationsForLocale(locale))) {
            if (key.startsWith(prefix) && keys[key] === undefined) {
                keys[key] = value;
            }
        }
    }

    return { locale: requestedLocale, keys };
}
```

Usage with a catalog that is intentionally incomplete for `nl`:

```typescript
import { Translator } from "blendsdk/i18n";
import { buildLocaleBundle } from "./locale-bundle.js";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "checkout.total": { en: "Total: ${amount}", nl: "Totaal: ${amount}" },
        "checkout.items": {
            en: ["${count} item", "${count} items"],
            nl: ["${count} artikel", "${count} artikelen"],
        },
        "checkout.continue": { en: "Continue to payment" },
        "account.title": { en: "Account" },
    },
});

const bundle = buildLocaleBundle(translator, "nl", ["en"], "checkout");

console.log(JSON.stringify(bundle, null, 2));
```

Expected output — note the last key resolved through the English fallback, while bundle keys and the `locale` label stay consistent:

```json
{
    "locale": "nl",
    "keys": {
        "checkout.total": "Totaal: ${amount}",
        "checkout.items": ["${count} artikel", "${count} artikelen"],
        "checkout.continue": "Continue to payment"
    }
}
```

Serve the result from any HTTP layer as JSON. Add a catalog version (hash of `getCatalog()` or a reload counter from [Pattern 3](#pattern-3-resilient-reload-pipeline)) and standard cache headers so clients can revalidate instead of refetching.

### Why this pattern is valuable

- **`getTranslationsForLocale()` applies same-language fallback for free** (`nl_NL` → `nl`), and the loop layers cross-language fallback (`nl` → `en`) on top — the two mechanisms compose without reimplementing either.
- **Only the requested namespace ships.** Dot-notation namespacing (`checkout.*`, `account.*`) becomes the payload filter, so a checkout page never downloads account screens.
- **Plural tuples survive the wire.** The client gets both forms and can render `"1 artikel"` or `"6 artikelen"` from live data — no server round trip per count change.

### Caveats and performance considerations

- **`getTranslationsForLocale()` scans the whole catalog per call — O(keys).** Never call `buildLocaleBundle` per request without caching. Memoize per `locale + namespace`, and invalidate by comparing `translator.getCatalog()` by reference (it changes identity on every `setCatalog()`).
- **Cross-language fallback is an application decision.** The `Translator` never mixes languages across keys; the fallback list (`["en"]`, or `["de", "en"]` for German users) is policy you define at the edge.
- **Bundle values may be partial.** A key missing from every listed locale is simply absent; the client's `Translator` will return the key itself for it. If absence is not acceptable, gate the bundle behind the audit from [Pattern 7](#pattern-7-development-audit-and-ci-coverage-gate).
- **Never ship rich content this way.** HTML email bodies from `ContentFileSource` are large; keep them server-side and send only interpolation-ready UI strings (see [Pattern 9](#pattern-9-localized-rich-content-end-to-end)).

---

## Pattern 6: Browser Runtime Locale Switching

**When to use it**: a browser application lets users switch language at runtime, and you want interpolation and plural selection to behave *identically* to the server — which means using the same `Translator` and the same plural tuples that [Pattern 5](#pattern-5-serving-namespaced-client-bundles) shipped.

### Implementation

The store validates incoming payloads (no casts, no `any`), lazily fetches locales with de-duplicated concurrent loads, and merges new locales into one catalog so switching never loses already-loaded data:

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationValue } from "blendsdk/i18n";

/** Matches the payload produced by the server-side bundle builder. */
export interface LocaleBundle {
    locale: string;
    keys: Record<string, TranslationValue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTranslationValue(value: unknown): value is TranslationValue {
    if (typeof value === "string") {
        return true;
    }
    return (
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((part: unknown): boolean => typeof part === "string")
    );
}

function isLocaleBundle(value: unknown): value is LocaleBundle {
    if (!isRecord(value)) {
        return false;
    }
    const { locale, keys } = value;
    if (typeof locale !== "string" || !isRecord(keys)) {
        return false;
    }
    return Object.values(keys).every(isTranslationValue);
}

async function fetchLocaleBundle(locale: string): Promise<LocaleBundle> {
    const response = await fetch(`/api/i18n/bundles/${encodeURIComponent(locale)}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}": HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!isLocaleBundle(payload)) {
        throw new Error(`Invalid locale bundle received for "${locale}"`);
    }
    return payload;
}

/** Assemble server bundles into a single catalog, one locale entry per key. */
export function bundlesToCatalog(bundles: LocaleBundle[]): TranslationCatalog {
    const catalog: TranslationCatalog = {};

    for (const bundle of bundles) {
        for (const [key, value] of Object.entries(bundle.keys)) {
            const entry = catalog[key] ?? {};
            entry[bundle.locale] = value;
            catalog[key] = entry;
        }
    }

    return catalog;
}

export class LocaleStore {
    readonly translator: Translator;

    protected readonly loadedLocales = new Set<string>();
    protected readonly pendingLoads = new Map<string, Promise<void>>();

    constructor(defaultLocale: string) {
        this.translator = new Translator({ defaultLocale, catalog: {} });
    }

    /** Load a locale once; concurrent calls for the same locale share one request. */
    async ensureLocale(locale: string): Promise<void> {
        if (this.loadedLocales.has(locale)) {
            return;
        }
        const pending = this.pendingLoads.get(locale);
        if (pending !== undefined) {
            return pending;
        }

        const load = (async (): Promise<void> => {
            try {
                const bundle = await fetchLocaleBundle(locale);
                this.translator.setCatalog(
                    mergeCatalogs([this.translator.getCatalog(), bundlesToCatalog([bundle])])
                );
                this.loadedLocales.add(locale);
            } finally {
                this.pendingLoads.delete(locale);
            }
        })();

        this.pendingLoads.set(locale, load);
        return load;
    }
}
```

Usage — switching language is only a matter of passing another locale:

```typescript
import { LocaleStore } from "./locale-store.js";

const store = new LocaleStore("en");

await Promise.all([store.ensureLocale("en"), store.ensureLocale("nl")]);

console.log(store.translator.translate("checkout.items", "nl", { count: 1 })); // "1 artikel"
console.log(store.translator.translate("checkout.items", "nl", { count: 6 })); // "6 artikelen"

// Switching the UI language later reuses the already-loaded catalogs:
console.log(store.translator.translate("checkout.total", "en", { amount: "€12.50" })); // "Total: €12.50"
```

### Why this pattern is valuable

- **One engine, two runtimes.** The core entry point (`blendsdk/i18n`) has no `node:*` imports, so this code bundles cleanly in Webpack, Vite, or esbuild — and `translate()` behaves exactly as on the server: same fallback chain, same `count === 1` plural rule, same `${...}` interpolation.
- **Merging beats replacing.** `mergeCatalogs([current, new])` adds a locale without dropping previously loaded ones, so switching back to an earlier language is instant and offline after first load.
- **Loading is idempotent and concurrency-safe.** `loadedLocales` short-circuits repeat calls; `pendingLoads` de-duplicates simultaneous ones (a rapid language toggle triggers one fetch, not five).

### Caveats and performance considerations

- **Load before switching.** A locale that was never `ensureLocale`d resolves through fallback only if the *same language* is present under another key; the generic experience is that keys come back as-is. Call `ensureLocale` first, then re-render.
- **A failed load is retryable.** On fetch or validation failure the pending promise rejects to callers, the locale is *not* marked loaded, and the next `ensureLocale` attempts again — surface the error in the UI and offer a retry.
- **Validate untrusted payloads once per locale, not per call.** The guards run on the fetch path only; `bundlesToCatalog` and all `translate()` calls then operate on typed data.
- **Consider persisting bundles** (Cache Storage, IndexedDB) keyed by the server's catalog version, so repeat visits skip the network round trip.

---

## Pattern 7: Development Audit and CI Coverage Gate

**When to use it**: during development and in CI, when you want missing keys and untranslated locales to surface immediately instead of as raw keys (`checkout.total`) in a production screen.

### Implementation

First, an audit collector for `onMissingTranslation` that de-duplicates and groups by locale:

```typescript
import { Translator } from "blendsdk/i18n";

export interface MissingTranslationAudit {
    record(key: string, locale: string): void;
    report(): string[];
}

export function createMissingTranslationAudit(): MissingTranslationAudit {
    const missing = new Map<string, Set<string>>();

    return {
        record(key: string, locale: string): void {
            const keys = missing.get(locale) ?? new Set<string>();
            keys.add(key);
            missing.set(locale, keys);
        },
        report(): string[] {
            return [...missing.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([locale, keys]) => `${locale}: ${[...keys].sort().join(", ")}`);
        },
    };
}
```

```typescript
import { Translator } from "blendsdk/i18n";
import { createMissingTranslationAudit } from "./missing-translation-audit.js";

const audit = createMissingTranslationAudit();

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
    },
    onMissingTranslation: (key: string, locale: string): void => {
        audit.record(key, locale);
    },
});

translator.translate("farewell", "nl");
translator.translate("farewell", "en");
translator.translate("greeting", "de");

console.log(audit.report());
// [ "de: greeting", "en: farewell", "nl: farewell" ]
```

Second, coverage utilities — one fallback-aware (what users experience), one exact (what translators have written):

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

export interface CoverageGap {
    key: string;
    locale: string;
}

/** Fallback-aware audit: satisfied when a value resolves via region → language fallback. */
export function findCoverageGaps(catalog: TranslationCatalog, locales: string[]): CoverageGap[] {
    const probe = new Translator({ defaultLocale: locales[0] ?? "en", catalog });
    const gaps: CoverageGap[] = [];

    for (const key of Object.keys(catalog)) {
        for (const locale of locales) {
            if (!probe.hasKey(key, locale)) {
                gaps.push({ key, locale });
            }
        }
    }

    return gaps;
}

/** Exact audit: reports every missing locale value, ignoring fallback. */
export function findUntranslated(catalog: TranslationCatalog, locales: string[]): CoverageGap[] {
    const gaps: CoverageGap[] = [];

    for (const [key, entry] of Object.entries(catalog)) {
        for (const locale of locales) {
            if (entry[locale] === undefined) {
                gaps.push({ key, locale });
            }
        }
    }

    return gaps;
}
```

Third, the CI gate as a Vitest test over the merged production catalog:

```typescript
import { describe, expect, it } from "vitest";
import { jsonFileSource } from "blendsdk/i18n-node";
import { findUntranslated } from "./translation-coverage.js";

const SUPPORTED_LOCALES: string[] = ["en", "nl", "de"];

describe("translation coverage", () => {
    it("provides a value for every key in every supported locale", async () => {
        const catalog = await jsonFileSource({ paths: ["./translations/*.json"] }).load();

        const gaps = findUntranslated(catalog, SUPPORTED_LOCALES);

        expect(gaps).toEqual([]);
    });
});
```

### Why this pattern is valuable

| | Before | After |
|---|---|---|
| Missing key | Raw key string appears in the UI, discovered by a user | Dev-time report: `"nl: farewell"`, unique and grouped |
| Partial locale coverage | Assumed "we translated everything" | CI fails with the exact `{ key, locale }` list |
| Fallback expectations | Unclear whether `en_GB` "counts" as covered | Two explicit audits: fallback-aware vs. exact |

The two coverage functions answer different questions: `findCoverageGaps` validates the **user-facing guarantee** (every key resolves *somewhere*, including fallback — an `en_GB` user served by an `en` value is covered), while `findUntranslated` validates the **content workflow** (every declared locale has its own authored value). Use the first for runtime confidence tests and the second for translation completeness gates.

### Caveats and performance considerations

- **Never throw inside `onMissingTranslation`.** It runs inside the request path; throwing would turn a missing translation into an outage. Collect, then report at test teardown or shutdown.
- **The callback fires per failed call.** The `Set`-based collector keeps memory bounded by unique `key + locale` pairs; in production replace it with counters or a sampled logger.
- **Gate on the merged catalog**, not just one source — coverage should be audited against the exact `mergeCatalogs([...])` result the application serves, otherwise an override layer can hide or create gaps.
- **Region coverage is intentional.** Because `hasKey` applies the fallback chain, `en_GB` is "covered" by `en`. If a region must have distinct wording, assert on `entry["en_GB"]` directly with `findUntranslated`.

---

## Pattern 8: Regional Locales and Custom Fallback Chains

**When to use it**: you ship one language with regional variants (`en` base plus `en_GB`/`en_AU` overrides) or sibling-region pairs (`pt_BR` ⇄ `pt_PT`) where a missing regional value should consult a related region *before* dropping to the base language — and caller input such as `en-gb` or `en-UK` should not silently miss the `en_GB` entry.

### Implementation

The base `Translator` normalizes `-` to `_` and strips encodings, but it does **not** change casing, and its fallback chain is exact → language only. Subclassing the two documented extension points — `parseLocale` and `resolveValue` — adds canonical casing, aliases, and sibling-region fallback:

```typescript
import { Translator } from "blendsdk/i18n";
import type { LocaleParts, TranslationEntry, TranslationValue } from "blendsdk/i18n";

/** Raw input → loose candidate: "en-UK.UTF-8" → "en_UK", "pt_BR" → "pt_BR". */
function canonicalLocale(input: string): string {
    const withoutEncoding = input.split(".")[0] ?? input;
    const parts = withoutEncoding.replace(/-/g, "_").split("_");
    const language = (parts[0] ?? "").toLowerCase();
    const region = parts[1]?.toUpperCase();
    return region ? `${language}_${region}` : language;
}

/** Aliases are keyed by the canonical candidate form. */
const LOCALE_ALIASES: Record<string, string> = {
    "en_UK": "en_GB", // informal region code
    "iw": "he", // legacy Hebrew code
    "in": "id", // legacy Indonesian code
};

/** Regions consulted, in order, before falling back to the base language. */
const REGION_FALLBACKS: Record<string, readonly string[]> = {
    "en_AU": ["en_GB"],
    "pt_BR": ["pt_PT"],
};

export class ProductTranslator extends Translator {
    protected override parseLocale(locale: string): LocaleParts {
        const candidate = canonicalLocale(locale);
        const aliased = LOCALE_ALIASES[candidate] ?? candidate;
        return super.parseLocale(aliased);
    }

    protected override resolveValue(
        entry: TranslationEntry,
        localeParts: LocaleParts
    ): TranslationValue | undefined {
        // 1. Exact canonical match, e.g. entry["en_GB"] for "en-gb"
        const exact = entry[localeParts.full];
        if (exact !== undefined) {
            return exact;
        }

        // 2. Sibling regions, e.g. pt_BR → pt_PT before generic "pt"
        for (const sibling of REGION_FALLBACKS[localeParts.full] ?? []) {
            const candidate = entry[sibling];
            if (candidate !== undefined) {
                return candidate;
            }
        }

        // 3. Base language, exactly like the built-in chain
        if (localeParts.region && entry[localeParts.language] !== undefined) {
            return entry[localeParts.language];
        }

        return undefined;
    }
}
```

Every entry point benefits, because `translate()`, `hasKey()`, and `getTranslationsForLocale()` all call `parseLocale` and `resolveValue` internally:

```typescript
import { ProductTranslator } from "./product-translator.js";

const translator = new ProductTranslator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate", pt_PT: "Olá" },
    },
});

console.log(translator.translate("greeting", "en-UK")); // "Hello, mate" — alias → en_GB → exact
console.log(translator.translate("greeting", "en_AU")); // "Hello, mate" — sibling en_GB before language
console.log(translator.translate("greeting", "pt_BR")); // "Olá" — sibling pt_PT
console.log(translator.translate("greeting", "en_IE")); // "Hello" — region → language fallback
console.log(translator.translate("greeting", "de")); // "greeting" — unresolved, key returned
```

### Why this pattern is valuable

- **Sparse regional catalogs stay sparse.** The `en` entry carries all common strings; `en_GB` only holds what actually differs. Combined with the fallback chain, you never duplicate a full catalog for a regional variant.
- **Casing and aliasing stop being footguns.** Without `canonicalLocale`, a header value like `en-gb` produces region `"gb"`, which never matches an `en_GB` key. Normalizing at parse time fixes every call site at once — no app-wide discipline required.
- **Policy lives in one place.** Alias tables and sibling chains are declarative constants; changing fallback policy is a one-line edit, not a scattered refactor.

### Caveats and performance considerations

- **Subclassing couples you to protected members.** `parseLocale` and `resolveValue` are the designed extension points, but they are implementation details relative to the public API. Pin your `blendsdk/i18n` version and re-verify the override after upgrades — or, when you only need aliasing, prefer normalizing input at the application edge and keep the stock `Translator`.
- **Overriding `resolveValue` replaces the base chain.** Inserting sibling regions *between* exact and language requires reimplementing both steps (calling `super.resolveValue` would return the language fallback before siblings are ever consulted).
- **Keep sibling chains linguistically defensible.** `pt_BR → pt_PT` and `en_AU → en_GB` are reasonable; arbitrary region chains are better expressed as explicit catalog entries.
- **Performance is unchanged in practice.** The override adds a few map lookups only when the exact locale is missing. `parseLocale` results are still cached by the base class, and `setCatalog()` still clears that cache. Remember fallback is downward only: requesting `en` never upgrades to `en_GB`.

---

## Pattern 9: Localized Rich Content End-to-End

**When to use it**: emails, pages, or legal copy are owned by content editors (HTML per locale), while the surrounding subject lines and plain-text strings live in JSON — and you want rendering to fail loudly rather than send a raw key as an email body.

### Implementation

File layout — dot-notation keys work in content filenames, so content and JSON share one namespace convention:

```text
translations/
├── en.json                          → "email.signup.subject": "Welcome to BlendSDK, ${name}!"
└── nl.json                          → "email.signup.subject": "Welkom bij BlendSDK, ${name}!"

content/emails/
├── en.email.signup.body.html        → locale "en", key "email.signup.body"
└── nl.email.signup.body.html        → locale "nl", key "email.signup.body"
```

The HTML files contain `${...}` placeholders and are stored as-is, so they survive loading untouched:

```html
<p>Hello ${name},</p>
<p>Confirm your account by clicking <a href="${activationUrl}">this link</a>.</p>
```

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import { ContentFileSource, jsonFileSource } from "blendsdk/i18n-node";

/** Shared strings (subject lines, plain text) live in the JSON catalogs. */
const jsonCatalog = await jsonFileSource({ paths: ["./translations/*.json"] }).load();

/** Rich HTML bodies live in one file per locale and are stored verbatim. */
const contentCatalog = await new ContentFileSource({ paths: ["./content/emails"] }).load();

const translator = new Translator({
    defaultLocale: "en",
    catalog: mergeCatalogs([jsonCatalog, contentCatalog]),
});

export interface SignupEmailInput {
    locale: string;
    customerName: string;
    activationUrl: string;
}

export interface RenderedEmail {
    subject: string;
    html: string;
}

export function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

export function translateRequired(
    key: string,
    locale: string,
    params: Record<string, unknown>
): string {
    if (!translator.hasKey(key, locale)) {
        throw new Error(`Missing translation "${key}" for locale "${locale}"`);
    }
    return translator.translate(key, locale, params);
}

export function renderSignupEmail(input: SignupEmailInput): RenderedEmail {
    // Subject is plain text: interpolate the name as-is.
    const subject = translateRequired("email.signup.subject", input.locale, {
        name: input.customerName,
    });

    // Body is HTML: escape every interpolated value for the HTML context.
    const html = translateRequired("email.signup.body", input.locale, {
        name: escapeHtml(input.customerName),
        activationUrl: escapeHtml(input.activationUrl),
    });

    return { subject, html };
}
```

```typescript
import { renderSignupEmail } from "./signup-email.js";

const email = renderSignupEmail({
    locale: "nl",
    customerName: "Alice & Bob",
    activationUrl: "https://example.com/activate?token=abc",
});

console.log(email.subject); // "Welkom bij BlendSDK, Alice & Bob!"
console.log(email.html);
// "<p>Hallo Alice &amp; Bob,</p>..."
// — escaped values interpolated into the Dutch HTML body file
```

### Why this pattern is valuable

| | Before | After |
|---|---|---|
| Email copy lives in | Template literals inside TypeScript | One `.html` file per key per locale |
| Copy change ships via | Code review + application deploy | Content file update + catalog reload |
| Dynamic values | String concatenation per locale | `${...}` interpolation by `Translator` |
| Missing copy | Typo reaches a customer | `translateRequired` throws at send time |

`hasKey()` turns "the key returns itself" — correct for UI strings — into a hard failure for content where sending `email.signup.body` as a body would be absurd. The same catalog also serves UI strings through the namespaces from [Pattern 5](#pattern-5-serving-namespaced-client-bundles), while rich bodies stay server-side.

### Caveats and performance considerations

- **Content is read as-is; interpolation is the only transformation.** `ContentFileSource` performs no parsing, so placeholders, whitespace, and markup must be exactly what you want to render.
- **Configured extensions replace the defaults.** The default filter is `[".html", ".md", ".txt"]`; passing `extensions: [".html"]` for these directories would exclude Markdown pages if you later add them.
- **Escaping is context-dependent and not automatic.** `formatString` substitutes values verbatim — escape HTML-bound values with `escapeHtml` as shown, and treat subject lines as text, not markup.
- **Guard content keys with `translateRequired`** anywhere the fallback-to-key behavior would produce broken output (emails, PDFs, legal pages). Keep raw `translate()` for UI strings where the key-as-fallback is the friendlier failure mode.

---

## Cross-Cutting Performance and Operational Notes

| Operation | Cost | Guidance |
|---|---|---|
| `JsonFileSource.load()` / `ContentFileSource.load()` | File I/O + parse, scales with file count | Startup and reload only; parallelize independent sources with `Promise.all` |
| `mergeCatalogs([...])` | O(total keys), copies entries | Reload boundaries only; granularity is per key + locale |
| `translate(key, locale?, params?)` | O(1) catalog lookup, locale parse cached, interpolation over the final template | Safe on hot request paths |
| `getTranslationsForLocale(locale)` | O(catalog size) per call | Always cache bundles; invalidate when `getCatalog()` identity changes |
| `setCatalog(catalog)` | O(1) reference swap + locale-cache clear | Build the full replacement first; swap off the request path |
| `onMissingTranslation` callback | Fires per unresolved call | Dedupe into sets/counters; never throw inside it |

Additional operational guidance:

- **One `Translator` per process or worker** is the intended deployment shape. Node.js runs your JavaScript on a single thread, so the `setCatalog()` swap is race-free by construction; each worker in a `worker_threads` setup loads its own catalog.
- **Fail fast, degrade gracefully.** Abort startup when a first load fails (no catalog means every key returns as-is), but keep serving the last good catalog when *reloads* fail — the `I18nRuntime` from [Pattern 3](#pattern-3-resilient-reload-pipeline) implements both behaviors.
- **Fan out change events through shared infrastructure.** In-process notifiers only reload one instance; publish translation changes through pub/sub so all instances converge.
- **Reloads are human-scale events.** Debounce, coalesce, and log them (the runtime logs key counts) — never rebuild catalogs per request.

---

## Related Documentation

- Overview — package summary, features, and architecture
- Core Concepts — `Translator`, catalog model, sources, and merging
- Basic Usage — a first-run walkthrough

---

# i18n Common Scenarios

This document answers the most common "How do I...?" questions about `blendsdk/i18n`, ordered from basic lookups to file-based catalogs, layered overrides, runtime reloads, and custom backends. Each scenario is self-contained: a question, the recommended approach, and a complete TypeScript example. Examples that only use the translation engine import from the browser-safe core (`blendsdk/i18n`); examples that read translation files import from the Node.js entry point (`blendsdk/i18n-node`).

---

## How do I translate a simple key?

Create a `Translator` with a `catalog` and call `translate(key, locale)` — the result is the localized string for that key. Keys are plain strings, and dot notation (`auth.login`) is used by convention to namespace related keys. If a key cannot be resolved, `translate()` returns the key itself instead of throwing.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
        "auth.login": { en: "Log in", nl: "Inloggen" },
    },
});

console.log(translator.translate("greeting", "en"));   // "Hello"
console.log(translator.translate("greeting", "nl"));   // "Hallo"
console.log(translator.translate("auth.login", "nl")); // "Inloggen"
```

---

## How do I interpolate dynamic values into a translation?

Put `${param}` placeholders inside the translation values and pass a params object as the third argument to `translate()`. Substitution runs after plural selection on the chosen form, so both forms of a tuple can carry placeholders.

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
    },
});

console.log(translator.translate("welcome", "en", { name: "Alice" }));
// "Welcome back, Alice!"

console.log(translator.translate("order.status", "nl", { orderId: "A-1024", days: 3 }));
// "Bestelling A-1024 wordt binnen 3 dagen verzonden"
```

---

## How do I handle singular and plural forms based on a count?

Declare the value as a `[singular, plural]` tuple and pass a numeric `count` parameter — `count === 1` selects the singular form and any other number selects the plural. Both forms typically contain `${count}` so the rendered string includes the actual number; a non-numeric count selects the singular form.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        book: {
            en: ["${count} book", "${count} books"],
            nl: ["${count} boek", "${count} boeken"],
        },
    },
});

console.log(translator.translate("book", "en", { count: 1 })); // "1 book"
console.log(translator.translate("book", "en", { count: 5 })); // "5 books"
console.log(translator.translate("book", "en", { count: 0 })); // "0 books"
console.log(translator.translate("book", "nl", { count: 3 })); // "3 boeken"
```

| `count` value | Form selected |
|---|---|
| `1` | Singular |
| Any other number (`0`, `2`, `-1`, …) | Plural |
| Non-number or `NaN` | Singular |

---

## How do I set a default locale?

Set `defaultLocale` in the `Translator` configuration and omit the locale argument in `translate()` calls. When no default is configured, the translator uses `"en"`.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "nl",
    catalog: {
        farewell: { en: "Goodbye", nl: "Tot ziens" },
    },
});

console.log(translator.translate("farewell"));     // "Tot ziens"
console.log(translator.getDefaultLocale());        // "nl"

const defaultTranslator = new Translator();
console.log(defaultTranslator.getDefaultLocale()); // "en" — built-in default
```

---

## How do I handle regional locales like `en_GB` or `en-GB`?

Locale strings are normalized before lookup — a dash becomes an underscore (`en-GB` → `en_GB`) and POSIX encodings are stripped (`en_GB.UTF-8` → `en_GB`) — and resolution falls back from a regional locale to its base language when no exact entry exists. Fallback only moves from specific to general: requesting `en` never upgrades to an `en_GB` entry.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello ${name}", en_GB: "Hello ${name}, mate" },
        farewell: { en: "Goodbye" },
        "checkout.title": { en_GB: "Checkout" },
    },
});

// Exact match wins when the regional entry exists
console.log(translator.translate("greeting", "en_GB", { name: "Bob" }));       // "Hello Bob, mate"

// en-GB and en_GB.UTF-8 are normalized to "en_GB" before lookup
console.log(translator.translate("greeting", "en-GB", { name: "Bob" }));       // "Hello Bob, mate"
console.log(translator.translate("greeting", "en_GB.UTF-8", { name: "Bob" })); // "Hello Bob, mate"

// No en_GB entry for "farewell" — falls back to the language-only "en" entry
console.log(translator.translate("farewell", "en_GB")); // "Goodbye"

// Fallback never upgrades: "checkout.title" only exists for en_GB
console.log(translator.translate("checkout.title", "en")); // "checkout.title"
```

| Input locale | Parsed `full` | Lookup order |
|---|---|---|
| `"en"` | `"en"` | `en` only |
| `"en_GB"` | `"en_GB"` | `en_GB` → `en` |
| `"en-GB"` | `"en_GB"` | `en_GB` → `en` |
| `"en_GB.UTF-8"` | `"en_GB"` | `en_GB` → `en` |

---

## How do I detect and log missing translations?

`translate()` never throws on a failed lookup — it returns the key itself, which keeps the application running and makes gaps visible in the UI. Pass an `onMissingTranslation` callback to log or collect them; it fires both when a key is absent from the catalog and when the key exists but no value resolves for the requested locale.

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
console.log(translator.translate("greeting", "de")); // "greeting" — no value resolves for "de"

console.log(missingKeys); // ["en:farewell", "de:greeting"]
```

---

## How do I check whether a translation key exists?

Call `hasKey(key)` to check that a key exists for at least one locale, or `hasKey(key, locale)` to also apply the fallback chain for a specific locale. Use it when you want to branch on availability up front instead of relying on `translate()` returning the key.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate", nl: "Hallo" },
        farewell: { en: "Goodbye" },
    },
});

console.log(translator.hasKey("greeting"));          // true — key exists for at least one locale
console.log(translator.hasKey("greeting", "nl"));    // true — exact locale match
console.log(translator.hasKey("farewell", "en_GB")); // true — falls back to "en"
console.log(translator.hasKey("farewell", "de"));    // false — no value resolves for "de"
console.log(translator.hasKey("unknown.key"));       // false — key not in catalog
```

---

## How do I send all translations for a locale to a frontend client?

Call `getTranslationsForLocale(locale)` to get a flat `{ key: value }` map with the fallback chain applied per key — ideal for sending translations to a frontend client. Plural tuples are returned as-is so the client can select the form at render time, and keys without a resolvable value are omitted.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate" },
        farewell: { en: "Goodbye" },
        book: { en: ["${count} book", "${count} books"] },
    },
});

const payload = translator.getTranslationsForLocale("en_GB");

console.log(payload.greeting); // "Hello, mate" — exact locale match
console.log(payload.farewell); // "Goodbye" — fell back to "en"
console.log(payload.book);     // ["${count} book", "${count} books"] — tuple kept intact

const german = translator.getTranslationsForLocale("de");
console.log(german); // {} — nothing resolves for "de"
```

---

## How do I load translations from JSON files?

Use `JsonFileSource` from `blendsdk/i18n-node` to load multi-locale JSON files (`{ key: { locale: value } }`) — two-string arrays become plural tuples and other values are converted to strings. Glob patterns (`*`, `?`) match files in a single directory; a glob that matches nothing yields an empty catalog without error, while a missing plain file path or invalid JSON throws. A `jsonFileSource()` factory with identical behavior is available for declarative configuration.

Assuming this file at `translations/multi-locale.json`:

```json
{
    "greeting": { "en": "Hello ${name}", "nl": "Hallo ${name}" },
    "book": {
        "en": ["${count} book", "${count} books"],
        "nl": ["${count} boek", "${count} boeken"]
    }
}
```

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: ["./translations/*.json"],
});

try {
    const catalog = await source.load();
    const translator = new Translator({ defaultLocale: "en", catalog });

    console.log(translator.translate("greeting", "nl", { name: "Alice" })); // "Hallo Alice"
    console.log(translator.translate("book", "en", { count: 3 }));          // "3 books"
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load translations: ${message}`);
}
```

---

## How do I organize one JSON file per locale?

Put one flat `{ key: value }` file per locale and let `JsonFileSource` derive each locale from the filename — `en.json` becomes `"en"` and `strings.nl.json` becomes `"nl"` (the last dot-segment before the extension). The format is auto-detected per file, so single-locale and multi-locale files can coexist in one glob.

`translations/en.json`:

```json
{
    "greeting": "Hello ${name}",
    "farewell": "Goodbye"
}
```

`translations/nl.json`:

```json
{
    "greeting": "Hallo ${name}",
    "farewell": "Tot ziens"
}
```

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: ["./translations/en.json", "./translations/nl.json"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(translator.translate("greeting", "nl", { name: "Alice" })); // "Hallo Alice"
console.log(translator.translate("farewell", "en"));                    // "Goodbye"
```

---

## How do I load localized HTML emails and Markdown pages?

Name each content file `<locale>.<key>.<ext>` — for example `en.signup-email.html` — and load the directory with the `contentFileSource()` factory or `ContentFileSource` directly. Content is stored verbatim as UTF-8, so HTML, Markdown, whitespace, and `${...}` placeholders survive for the `Translator` to interpolate at render time. Middle filename segments join with dots to form the key: `en.auth.welcome.md` becomes `auth.welcome`.

Given these files:

```text
content/emails/
├── en.signup-email.html   → <p>Welcome, ${name}!</p>
└── nl.signup-email.html   → <p>Welkom, ${name}!</p>
```

```typescript
import { Translator, contentFileSource } from "blendsdk/i18n-node";

const source = contentFileSource({
    paths: ["./content/emails"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(translator.translate("signup-email", "en", { name: "Alice" }));
// "<p>Welcome, Alice!</p>"

console.log(translator.translate("signup-email", "nl", { name: "Alice" }));
// "<p>Welkom, Alice!</p>"
```

| Filename | Outcome |
|---|---|
| `en.signup-email.html` | Loaded — locale `en`, key `signup-email` |
| `en.auth.welcome.md` | Loaded — locale `en`, key `auth.welcome` |
| `readme.txt` | Skipped — fewer than 3 dot-segments |
| `.hidden-file.html` | Skipped — empty locale segment |

---

## How do I control which content file types are loaded?

Configure `extensions` on `ContentFileSource`; a custom list replaces the default `[".html", ".md", ".txt"]`. Extensions are normalized — the leading dot is optional and casing is ignored — so `"txt"`, `".txt"`, and `".TXT"` all match `.txt` files, and files with other extensions are silently skipped.

```typescript
import { contentFileSource } from "blendsdk/i18n-node";

// Only Markdown files are loaded; .html and .txt files in the
// same directory are silently ignored
const markdownPages = contentFileSource({
    paths: ["./content/pages"],
    extensions: [".md"],
});

// Leading dot optional — "txt" is equivalent to ".txt"
const legalText = contentFileSource({
    paths: ["./content/legal"],
    extensions: ["txt"],
});

const pages = await markdownPages.load();
const legal = await legalText.load();

console.log(Object.keys(pages)); // ["welcome-page"]
console.log(Object.keys(legal)); // ["privacy-policy"]
```

| Configuration | Files loaded |
|---|---|
| `extensions` omitted | `.html`, `.md`, `.txt` |
| `[".md"]` | Markdown only |
| `["txt"]` | `.txt` only — leading dot optional |
| `[".HTML"]` | `.html` only — case-insensitive |

---

## How do I combine translations from multiple sources?

Pass catalogs to `mergeCatalogs()` in priority order — later catalogs win per key and locale, while locales defined only in earlier catalogs are preserved. Inputs are never mutated and the result uses copied entries, so you can safely layer file defaults with database or API overrides.

```typescript
import { mergeCatalogs, Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

// Base layer — e.g. loaded from translation files
const fileDefaults: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
};

// Higher-priority layer — e.g. from a database or admin UI
const databaseOverrides: TranslationCatalog = {
    greeting: { en: "Hi there" },
    "cart.empty": { en: "Your cart is empty", nl: "Je winkelwagen is leeg" },
};

const merged = mergeCatalogs([fileDefaults, databaseOverrides]);

console.log(merged.greeting);
// { en: "Hi there", nl: "Hallo" } — "en" overridden, "nl" preserved from the base

const translator = new Translator({ defaultLocale: "en", catalog: merged });

console.log(translator.translate("greeting", "en"));   // "Hi there"
console.log(translator.translate("greeting", "nl"));   // "Hallo"
console.log(translator.translate("cart.empty", "nl")); // "Je winkelwagen is leeg"
```

---

## How do I update translations at runtime without restarting?

Build the replacement catalog completely, then call `setCatalog()` — it swaps the catalog by reference in a single operation, so translations already in flight against the old catalog are never disrupted. A typical reload loads from your sources, optionally layers with `mergeCatalogs()`, and swaps the finished catalog in; `getCatalog()` returns the current reference if you want to compose over it.

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: ["./translations/*.json"],
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(translator.translate("greeting", "en")); // resolved against the startup catalog

/** Re-load all catalogs from the sources and swap them in atomically. */
async function reloadTranslations(): Promise<void> {
    const catalog = await source.load();
    translator.setCatalog(catalog);
}

await reloadTranslations();

console.log(translator.translate("greeting", "en")); // resolved against the replacement catalog
```

---

## How do I load translations from a database or custom backend?

Implement the `TranslationSource` interface — a `name` for logging and an async `load()` that returns a complete `TranslationCatalog` — and normalize your backend records into catalog entries the same way the built-in sources do. Custom sources compose with file-based ones through `mergeCatalogs()`.

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource, TranslationValue } from "blendsdk/i18n";

/** One translation record as returned by your backend. */
interface TranslationRecord {
    key: string;
    locale: string;
    value: string;
    pluralValue?: string;
}

/** Fetches all translation records from your backend (database, REST API, ...). */
type LoadRecords = () => Promise<TranslationRecord[]>;

class BackendSource implements TranslationSource {
    readonly name = "BackendSource";

    private readonly loadRecords: LoadRecords;

    constructor(loadRecords: LoadRecords) {
        this.loadRecords = loadRecords;
    }

    async load(): Promise<TranslationCatalog> {
        const records = await this.loadRecords();
        const catalog: TranslationCatalog = {};

        for (const record of records) {
            if (!catalog[record.key]) {
                catalog[record.key] = {};
            }
            const value: TranslationValue =
                record.pluralValue === undefined
                    ? record.value
                    : [record.value, record.pluralValue];
            catalog[record.key][record.locale] = value;
        }

        return catalog;
    }
}

// Demo data; in production, pass a function that queries your database or API
const source = new BackendSource(async (): Promise<TranslationRecord[]> => {
    return [
        { key: "greeting", locale: "en", value: "Hello ${name}" },
        { key: "greeting", locale: "nl", value: "Hallo ${name}" },
        { key: "book", locale: "en", value: "${count} book", pluralValue: "${count} books" },
    ];
});

const translator = new Translator({
    defaultLocale: "en",
    catalog: await source.load(),
});

console.log(translator.translate("greeting", "nl", { name: "Alice" })); // "Hallo Alice"
console.log(translator.translate("book", "en", { count: 2 }));          // "2 books"
```

---

## How do I keep Node.js APIs out of my browser bundle?

Import the core entry point `blendsdk/i18n` in browser code — it exports `Translator` and `mergeCatalogs` with no `node:fs` or `node:path` imports. The file-based sources (`JsonFileSource`, `ContentFileSource`) live only in `blendsdk/i18n-node`, so provide client catalogs inline or load them on the server and ship them to the client.

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

// Browser-safe: "blendsdk/i18n" contains no node:* imports.
// Only import "blendsdk/i18n-node" in Node.js code (servers, build scripts).

/** Inline catalog shipped with the client bundle. */
const catalog: TranslationCatalog = {
    greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
    book: {
        en: ["${count} book", "${count} books"],
        nl: ["${count} boek", "${count} boeken"],
    },
};

const translator = new Translator({ defaultLocale: "en", catalog });

const greeting = translator.translate("greeting", "en", { name: "Alice" });
const books = translator.translate("book", "nl", { count: 2 });

console.log(`${greeting} / ${books}`); // "Hello Alice / 2 boeken"
```

---

# i18n Examples Library

This document is a categorized collection of copy-paste ready examples for `blendsdk/i18n`. Every example is complete and self-contained — all imports, types, and expected output are included — and the patterns mirror the package's test suite. Core examples import from the browser-safe entry point `blendsdk/i18n`; examples that read translation files import sources from `blendsdk/i18n-node` (Node.js >= 22). Examples use top-level `await`, which is valid in ESM modules.

Example categories:

1. [Getting Started](#getting-started)
2. [Basic Translation](#basic-translation)
3. [Locale Handling](#locale-handling)
4. [Plural Handling](#plural-handling)
5. [Missing Translations](#missing-translations)
6. [Catalog Management](#catalog-management)
7. [Merging Catalogs](#merging-catalogs)
8. [JSON File Source](#json-file-source)
9. [Content File Source](#content-file-source)
10. [Full Pipelines](#full-pipelines)

---

## Getting Started

The smallest complete programs: constructing a `Translator`, building typed catalogs, and configuring the default locale.

### Your First Translator

Create a translator with an inline catalog and resolve keys for two locales.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello ${name}", nl: "Hallo ${name}" },
        farewell: { en: "Goodbye", nl: "Tot ziens" },
    },
});

console.log(translator.translate("greeting", "en", { name: "Alice" }));
// "Hello Alice"

console.log(translator.translate("farewell", "nl"));
// "Tot ziens"
```

### Building a Catalog with Types

Use `TranslationEntry` and `TranslationCatalog` to structure catalogs explicitly; plural values are `[singular, plural]` tuples.

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationEntry } from "blendsdk/i18n";

// TranslationEntry — one key mapped to per-locale values
const greeting: TranslationEntry = {
    en: "Hello ${name}",
    nl: "Hallo ${name}",
};

// Plural values are [singular, plural] tuples
const book: TranslationEntry = {
    en: ["${count} book", "${count} books"],
    nl: ["${count} boek", "${count} boeken"],
};

// TranslationCatalog — a flat map of keys to entries
const catalog: TranslationCatalog = {
    greeting,
    book,
    "auth.login": { en: "Log in", nl: "Inloggen" },
};

const translator = new Translator({ defaultLocale: "en", catalog });

console.log(translator.translate("greeting", "nl", { name: "Alice" })); // "Hallo Alice"
console.log(translator.translate("book", "en", { count: 2 }));          // "2 books"
console.log(translator.translate("auth.login", "en"));                  // "Log in"
```

### Configuring the Default Locale

When `translate()` omits the locale, the translator's `defaultLocale` is used; an explicit locale always overrides it.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "nl",
    catalog: {
        farewell: { en: "Goodbye", nl: "Tot ziens" },
    },
});

console.log(translator.getDefaultLocale());          // "nl"
console.log(translator.translate("farewell"));       // "Tot ziens" — default locale used
console.log(translator.translate("farewell", "en")); // "Goodbye" — explicit locale overrides
```

---

## Basic Translation

Core lookup patterns: interpolation with multiple parameters, dot-notation key namespacing, and templating rich content.

### Interpolation with Multiple Parameters

Any `${param}` placeholder in a resolved value is replaced with the matching property from the `params` argument.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "order.status": {
            en: "Order ${orderId} ships in ${days} days",
            nl: "Bestelling ${orderId} wordt binnen ${days} dagen verzonden",
        },
    },
});

console.log(translator.translate("order.status", "en", { orderId: "A-1024", days: 3 }));
// "Order A-1024 ships in 3 days"

console.log(translator.translate("order.status", "nl", { orderId: "A-1024", days: 3 }));
// "Bestelling A-1024 wordt binnen 3 dagen verzonden"
```

### Dot-Notation Keys for Namespacing

Translation keys use dot notation by convention; the catalog itself stays flat, so `auth.login` is a single key — exactly like `signup-email`.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "auth.login": { en: "Log in", nl: "Inloggen" },
        "auth.logout": { en: "Log out", nl: "Uitloggen" },
        "auth.forgot_password": { en: "Forgot your password?", nl: "Wachtwoord vergeten?" },
    },
});

console.log(translator.translate("auth.login", "en"));           // "Log in"
console.log(translator.translate("auth.logout", "nl"));          // "Uitloggen"
console.log(translator.translate("auth.forgot_password", "nl")); // "Wachtwoord vergeten?"
```

### Interpolating into Rich Content Templates

Translation values can carry HTML or Markdown; note the values are written as regular string literals so `${...}` placeholders survive until `translate()` renders them.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        "email.signup": {
            en: '<p>Welcome, ${name}!</p><p>Confirm your account: <a href="${url}">Activate</a></p>',
            nl: '<p>Welkom, ${name}!</p><p>Bevestig je account: <a href="${url}">Activeren</a></p>',
        },
    },
});

console.log(translator.translate("email.signup", "en", {
    name: "Alice",
    url: "https://example.com/activate?token=abc123",
}));
// <p>Welcome, Alice!</p><p>Confirm your account: <a href="https://example.com/activate?token=abc123">Activate</a></p>
```

---

## Locale Handling

How locale strings are normalized and resolved: regional locales fall back to their language, exact matches take priority, and dash/encoding formats are accepted.

### Fallback from Regional Locale to Language

When a key has no value for the requested regional locale, the translator falls back to the language-only value.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        farewell: { en: "Goodbye", nl: "Tot ziens" },
        "cart.total": { nl: "Totaal" },
    },
});

console.log(translator.translate("farewell", "en_GB"));   // "Goodbye" — falls back to "en"
console.log(translator.translate("cart.total", "nl_NL")); // "Totaal" — falls back to "nl"
```

### Exact Locale Match Takes Priority

If the entry has a value for the exact regional locale, it wins — but fallback only moves from specific to general, never the other way around.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: {
            en: "Hello ${name}",
            en_GB: "Hello ${name}, mate",
        },
    },
});

console.log(translator.translate("greeting", "en", { name: "Bob" }));
// "Hello Bob"

console.log(translator.translate("greeting", "en_GB", { name: "Bob" }));
// "Hello Bob, mate" — exact match preferred over the language fallback

// Requesting "en" never upgrades to the more specific "en_GB" entry
console.log(translator.translate("greeting", "en_GB.UTF-8", { name: "Bob" }));
// "Hello Bob, mate" — POSIX encoding stripped during normalization
```

### Normalizing Dash and Encoding Inputs

Locale strings are normalized before lookup: the first `-` becomes `_`, and anything after a `.` (POSIX encoding) is stripped.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate" },
    },
});

console.log(translator.translate("greeting", "en-GB"));       // "Hello, mate" — dash normalized to underscore
console.log(translator.translate("greeting", "en_GB.UTF-8")); // "Hello, mate" — encoding stripped
console.log(translator.translate("greeting", "en-GB.UTF-8")); // "Hello, mate" — both at once
```

---

## Plural Handling

Working with `[singular, plural]` tuples: `count === 1` selects singular, every other number selects plural, and edge cases fall back gracefully.

### Selecting Singular and Plural Forms

A plural tuple paired with a numeric `count` selects the correct form automatically before interpolation.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        book: { en: ["${count} book", "${count} books"] },
        "cart.items": { en: ["${count} item in your cart", "${count} items in your cart"] },
    },
});

console.log(translator.translate("book", "en", { count: 1 }));       // "1 book"
console.log(translator.translate("book", "en", { count: 5 }));       // "5 books"
console.log(translator.translate("book", "en", { count: 0 }));       // "0 books" — zero uses plural
console.log(translator.translate("cart.items", "en", { count: 2 })); // "2 items in your cart"
```

### Plurals in Multiple Languages

Each locale provides its own plural pair; selection logic is locale-independent.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        book: {
            en: ["${count} book", "${count} books"],
            nl: ["${count} boek", "${count} boeken"],
            de: ["${count} Buch", "${count} Bücher"],
        },
    },
});

console.log(translator.translate("book", "en", { count: 3 })); // "3 books"
console.log(translator.translate("book", "nl", { count: 1 })); // "1 boek"
console.log(translator.translate("book", "de", { count: 7 })); // "7 Bücher"
```

### Non-Numeric Counts Fall Back to Singular

When `count` is not a valid number, the singular form is selected — the provided value is still interpolated into the template.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        book: { en: ["${count} book", "${count} books"] },
    },
});

console.log(translator.translate("book", "en", { count: "many" })); // "many book"
console.log(translator.translate("book", "en", { count: NaN }));    // "NaN book"
```

### Plain Strings Ignore the Count Parameter

A `count` parameter only affects plural tuples; simple string values are returned unchanged.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        farewell: { en: "Goodbye" },
    },
});

console.log(translator.translate("farewell", "en", { count: 5 }));
// "Goodbye" — string values are not affected by count
```

### Combining Count With Other Parameters

Plural selection and interpolation compose: the same `count` that picks the form also fills the `${count}` placeholder, alongside any other parameters.

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
// "1 line for Acme"

console.log(translator.translate("invoice.lines", "en", { count: 4, customer: "Acme" }));
// "4 lines for Acme"
```

---

## Missing Translations

What happens when a key or locale cannot be resolved: the key is returned as-is, the `onMissingTranslation` callback fires, and `hasKey()` lets you check up front.

### Missing Keys Return the Key Itself

An unresolvable key is returned unchanged instead of throwing — visible in the UI and safe for production.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", nl: "Hallo" },
    },
});

console.log(translator.translate("greeting", "en")); // "Hello"
console.log(translator.translate("farewell", "en")); // "farewell" — key not in catalog
console.log(translator.translate("greeting", "de")); // "greeting" — no value for "de"

const empty = new Translator();
console.log(empty.translate("anything", "en"));      // "anything" — empty catalog
```

### Logging Missing Translations with a Callback

The `onMissingTranslation` callback fires exactly when a lookup fails, with the requested key and the resolved locale — ideal for development-time logging.

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

translator.translate("greeting", "en"); // resolves — callback not invoked
translator.translate("farewell", "en"); // key not found
translator.translate("greeting", "de"); // no value for "de"

console.log(missing);
// ["en:farewell", "de:greeting"]
```

### Pre-Checking Availability with hasKey

`hasKey()` applies the same fallback rules as `translate()`, so you can branch on availability before rendering.

```typescript
import { Translator } from "blendsdk/i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello", en_GB: "Hello, mate" },
        farewell: { en: "Goodbye" },
    },
});

console.log(translator.hasKey("greeting"));          // true — key exists
console.log(translator.hasKey("greeting", "en"));    // true
console.log(translator.hasKey("greeting", "en_GB")); // true
console.log(translator.hasKey("farewell", "en_GB")); // true — falls back to "en"
console.log(translator.hasKey("farewell", "de"));    // false
console.log(translator.hasKey("nonexistent"));       // false
```

---

## Catalog Management

Runtime catalog operations: exporting flat locale maps for frontend clients, atomic reloads with `setCatalog()`, and layering overrides over the live catalog with `getCatalog()`.

### Exporting a Locale Map for Frontend Clients

`getTranslationsForLocale()` returns a flat `{ key: value }` map with fallback applied per key; plural tuples stay intact for client-side selection.

```typescript
import { Translator } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo", en_GB: "Hello, mate" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
    book: { en: ["${count} book", "${count} books"] },
};

const translator = new Translator({ defaultLocale: "en", catalog });

console.log(translator.getTranslationsForLocale("en"));
// { greeting: "Hello", farewell: "Goodbye", book: ["${count} book", "${count} books"] }

console.log(translator.getTranslationsForLocale("en_GB"));
// { greeting: "Hello, mate", farewell: "Goodbye", book: ["${count} book", "${count} books"] }

console.log(translator.getTranslationsForLocale("de"));
// {} — no keys resolve for this locale
```

### Reloading the Catalog at Runtime

`setCatalog()` swaps the catalog by reference in a single operation, so in-flight translations are never disrupted.

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

console.log(translator.translate("greeting", "en")); // "Hello"

// Build the replacement catalog completely before swapping it in
const reloaded: TranslationCatalog = {
    greeting: { en: "Hi there" },
};

translator.setCatalog(reloaded);

console.log(translator.translate("greeting", "en")); // "Hi there" — replaced
console.log(translator.translate("farewell", "en")); // "farewell" — no longer in the catalog
```

### Layering New Translations Over the Current Catalog

Read the live catalog with `getCatalog()`, merge overrides on top, and swap the result back with `setCatalog()`.

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

const overrides: TranslationCatalog = {
    greeting: { nl: "Hoi" },
};

translator.setCatalog(mergeCatalogs([translator.getCatalog(), overrides]));

console.log(translator.translate("greeting", "nl")); // "Hoi" — overridden
console.log(translator.translate("greeting", "en")); // "Hello" — preserved
console.log(translator.translate("farewell", "nl")); // "Tot ziens" — preserved
```

---

## Merging Catalogs

`mergeCatalogs()` combines multiple catalogs in priority order — later catalogs win per key and locale, while everything else is preserved.

### Combining Catalogs with Different Keys

Disjoint catalogs merge into one; the function never mutates its inputs and returns copied entries.

```typescript
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const base: TranslationCatalog = {
    greeting: { en: "Hello" },
};

const extra: TranslationCatalog = {
    farewell: { en: "Goodbye" },
};

const merged = mergeCatalogs([base, extra]);

console.log(merged);
// { greeting: { en: "Hello" }, farewell: { en: "Goodbye" } }

console.log(merged === base);      // false — the result is a new catalog
console.log(merged.greeting === base.greeting); // false — entries are copied
```

### Overriding Specific Locales

When the same key appears in several catalogs, only the locales explicitly provided in the later catalog are overridden.

```typescript
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const defaults: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
};

const overrides: TranslationCatalog = {
    greeting: { en: "Hi" },
};

const merged = mergeCatalogs([defaults, overrides]);

console.log(merged.greeting);
// { en: "Hi", nl: "Hallo" } — "en" overridden, "nl" preserved
```

### Three-Layer Priority Chains

Priority is strictly positional: the last catalog in the array wins on conflicts, no matter how many layers are involved.

```typescript
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const base: TranslationCatalog = { greeting: { en: "Hello", nl: "Hallo" } };
const middle: TranslationCatalog = { greeting: { en: "Hi" }, farewell: { en: "Bye" } };
const top: TranslationCatalog = { greeting: { en: "Hey" } };

const merged = mergeCatalogs([base, middle, top]);

console.log(merged);
// { greeting: { en: "Hey", nl: "Hallo" }, farewell: { en: "Bye" } }
```

### Merging Plural Entries Across Locales

Plural tuples merge like any other value — each locale keeps its own pair.

```typescript
import { mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";

const english: TranslationCatalog = {
    book: { en: ["${count} book", "${count} books"] },
};

const dutch: TranslationCatalog = {
    book: { nl: ["${count} boek", "${count} boeken"] },
};

const merged = mergeCatalogs([english, dutch]);

console.log(merged.book);
// { en: ["${count} book", "${count} books"], nl: ["${count} boek", "${count} boeken"] }
```

---

## JSON File Source

Loading catalogs from JSON files with `JsonFileSource` (Node.js only, imported from `blendsdk/i18n-node`). The source auto-detects multi-locale and single-locale formats.

### Loading a Multi-Locale JSON File

A multi-locale file maps each key to a locale→value object; arrays of exactly two strings become plural tuples.

Given `translations/multi-locale.json`:

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

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: ["./translations/multi-locale.json"],
});

const catalog = await source.load();

console.log(catalog.greeting);
// { en: "Hello ${name}", nl: "Hallo ${name}" }

console.log(catalog.book);
// { en: ["${count} book", "${count} books"], nl: ["${count} boek", "${count} boeken"] }

const translator = new Translator({ defaultLocale: "en", catalog });

console.log(translator.translate("greeting", "en", { name: "Alice" })); // "Hello Alice"
console.log(translator.translate("greeting", "nl", { name: "Alice" })); // "Hallo Alice"
console.log(translator.translate("book", "en", { count: 2 }));          // "2 books"
```

### Loading Single-Locale JSON Files

In a single-locale file, values are flat and the locale is taken from the filename's last dot-segment (`en.json` → `"en"`).

Given `translations/en.json`:

```json
{
    "greeting": "Hello",
    "farewell": "Goodbye",
    "welcome": "Welcome to our app",
    "book": ["${count} book", "${count} books"]
}
```

And `translations/nl.json`:

```json
{
    "greeting": "Hallo",
    "farewell": "Tot ziens",
    "welcome": "Welkom bij onze app",
    "book": ["${count} boek", "${count} boeken"]
}
```

```typescript
import { Translator, JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: ["./translations/en.json", "./translations/nl.json"],
});

const catalog = await source.load();

console.log(catalog.greeting); // { en: "Hello", nl: "Hallo" }
console.log(catalog.farewell); // { en: "Goodbye", nl: "Tot ziens" }

const translator = new Translator({ defaultLocale: "en", catalog });
console.log(translator.translate("welcome", "nl"));          // "Welkom bij onze app"
console.log(translator.translate("book", "nl", { count: 2 })); // "2 boeken"
```

### Using Glob Patterns to Load Many Files

Glob patterns use `*` and `?` in the filename segment only — scans are single-directory and non-recursive.

```typescript
import { JsonFileSource } from "blendsdk/i18n-node";

// Load every .json file in the translations directory
const source = new JsonFileSource({
    paths: ["./translations/*.json"],
});

const catalog = await source.load();
console.log(Object.keys(catalog).length); // number of unique keys across all matched files

// A glob that matches nothing — or scans a missing directory —
// resolves to an empty catalog instead of throwing:
const noMatches = new JsonFileSource({
    paths: ["./translations/missing-dir/*.json"],
});

console.log(await noMatches.load()); // {}
```

### Overriding Earlier Files with Later Files

Resolved files are processed in sorted order; on duplicate key + locale, the later file wins.

Given `translations/override.json`:

```json
{
    "greeting": { "en": "Hi ${name}", "nl": "Hoi ${name}" }
}
```

```typescript
import { JsonFileSource } from "blendsdk/i18n-node";

const source = new JsonFileSource({
    paths: [
        "./translations/multi-locale.json", // loaded first — provides defaults
        "./translations/override.json",     // loaded later — wins on conflicts
    ],
});

const catalog = await source.load();

console.log(catalog.greeting.en); // "Hi ${name}" — from override.json
console.log(catalog.greeting.nl); // "Hoi ${name}" — from override.json
console.log(catalog.farewell.en); // "Goodbye" — untouched from multi-locale.json
```

### Handling Load Errors

Plain file paths that do not exist reject the `load()` promise; globs degrade to an empty catalog instead.

```typescript
import { JsonFileSource } from "blendsdk/i18n-node";
import type { TranslationCatalog } from "blendsdk/i18n";

const source = new JsonFileSource({
    paths: ["./translations/does-not-exist.json"],
});

try {
    const catalog: TranslationCatalog = await source.load();
    console.log("Loaded keys:", Object.keys(catalog).length);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to load translations:", message);
}

// Plain path missing      → load() rejects with an error
// Invalid JSON content    → load() rejects with "Failed to parse JSON file ..."
// Glob matching nothing   → load() resolves to {}
```

### Creating Sources with the jsonFileSource() Factory

The factory returns a ready `JsonFileSource` instance — identical behavior, intended for declarative `sources: [...]` configuration.

```typescript
import { jsonFileSource, JsonFileSource } from "blendsdk/i18n-node";

const source = jsonFileSource({
    paths: ["./translations/*.json"],
});

console.log(source instanceof JsonFileSource); // true
console.log(source.name);                      // "JsonFileSource"

const catalog = await source.load();
console.log(Object.keys(catalog).length);      // number of unique keys loaded from all matched files
```

---

## Content File Source

Loading one file per key per locale with `ContentFileSource` (Node.js only). The filename convention is `<locale>.<key>.<ext>`; content is stored as-is for HTML emails, Markdown pages, and plain text.

### Loading HTML Email Templates

Each file is a single translation value; `${...}` placeholders inside the content are interpolated by the `Translator` at render time.

Given `content/emails/en.signup-email.html`:

```html
<p>Welcome, ${name}!</p>
```

And `content/emails/nl.signup-email.html`:

```html
<p>Welkom, ${name}!</p>
```

```typescript
import { Translator, ContentFileSource } from "blendsdk/i18n-node";

// Each entry in `paths` is a directory or a glob pattern — directories are
// listed non-recursively, and missing directories contribute no files.
const source = new ContentFileSource({
    paths: ["./content/emails"],
});

const translator = new Translator({ defaultLocale: "en", catalog: await source.load() });

console.log(translator.translate("signup-email", "en", { name: "Alice" }));
// "<p>Welcome, Alice!</p>"

console.log(translator.translate("signup-email", "nl", { name: "Alice" }));
// "<p>Welkom, Alice!</p>"
```

### Inspecting Raw Content Before Translation

Load the raw catalog to confirm that content is stored exactly as written — tags, whitespace, and placeholders survive untouched.

```typescript
import { ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({
    paths: ["./content/emails"],
    extensions: [".html"],
});

const catalog = await source.load();

// Both locale variants live under the same key
console.log(Object.keys(catalog["signup-email"])); // ["en", "nl"]

// Content is stored as-is — the first dot-segment is the locale,
// the last is the extension, and everything between is the key
console.log(catalog["signup-email"]["en"].includes("${name}")); // true — placeholders preserved
console.log(catalog["signup-email"]["en"].includes("<p>"));     // true — markup preserved
```

### Multi-Dot Keys from Filenames

Middle segments of the filename join with dots to form dot-notation keys: `en.auth.welcome.html` → locale `"en"`, key `"auth.welcome"`.

Given `content/pages/en.auth.welcome.html`:

```html
<h1>Welcome to the auth section</h1>
```

And `content/pages/nl.auth.welcome.html`:

```html
<h1>Welkom bij de auth-sectie</h1>
```

```typescript
import { ContentFileSource } from "blendsdk/i18n-node";

const source = new ContentFileSource({
    paths: ["./content/pages"],
    extensions: [".html"],
});

const catalog = await source.load();

console.log("auth.welcome" in catalog);     // true — middle segments join with dots
console.log(catalog["auth.welcome"]["en"]); // "<h1>Welcome to the auth section</h1>"
console.log(catalog["auth.welcome"]["nl"]); // "<h1>Welkom bij de auth-sectie</h1>"

// Files with fewer than 3 dot-segments (readme.txt) or an empty locale
// (.hidden-file.html) are silently skipped — they never appear in the catalog.
```

### Filtering by File Extension

The default extensions are `[".html", ".md", ".txt"]`; configuring `extensions` replaces the defaults entirely. With or without the leading dot and in any case, extensions are normalized before matching.

Given `content/pages`:

```text
content/pages/
├── en.signup-email.html
├── nl.signup-email.html
├── en.welcome-page.md
├── nl.welcome-page.md
├── en.privacy-policy.txt
└── nl.privacy-policy.txt
```

```typescript
import { ContentFileSource } from "blendsdk/i18n-node";

// With default extensions (.html, .md, .txt), every content file is loaded
const withDefaults = new ContentFileSource({ paths: ["./content/pages"] });
const defaultCatalog = await withDefaults.load();

console.log(defaultCatalog["signup-email"]["en"]);   // "<p>Welcome, ${name}!</p>" — .html
console.log(defaultCatalog["welcome-page"]["en"]);   // "# Welcome ..." — .md
console.log(defaultCatalog["privacy-policy"]["en"]); // "Privacy Policy ..." — .txt

// A custom extensions list replaces the defaults: only Markdown is read
const markdownOnly = new ContentFileSource({
    paths: ["./content/pages"],
    extensions: [".md"], // "md", ".md", and ".MD" are all equivalent here
});
const mdCatalog = await markdownOnly.load();

console.log(mdCatalog["welcome-page"]["en"]); // "# Welcome ..." — still loaded
console.log(mdCatalog["signup-email"]);       // undefined — .html filtered out
```

### Creating Sources with the contentFileSource() Factory

The factory returns a ready `ContentFileSource` instance for declarative configuration, including glob patterns for specific file types.

```typescript
import { contentFileSource, ContentFileSource } from "blendsdk/i18n-node";

const source = contentFileSource({
    paths: ["./content/*.html"],
    extensions: [".html"],
});

console.log(source instanceof ContentFileSource); // true
console.log(source.name);                         // "ContentFileSource"

const catalog = await source.load();
console.log(Object.keys(catalog).length);         // number of unique keys across all content files
```

---

## Full Pipelines

End-to-end patterns that combine sources, merging, and the translator — including error handling, layered overrides, client payloads, and custom sources.

### Complete Application Startup with Error Handling

Load multiple sources defensively, merge the results, and configure a missing-translation hook for development.

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/i18n";
import { JsonFileSource, ContentFileSource } from "blendsdk/i18n-node";

async function buildTranslator(): Promise<Translator> {
    const sources: TranslationSource[] = [
        new JsonFileSource({ paths: ["./translations/*.json"] }),
        new ContentFileSource({ paths: ["./content/emails"] }),
    ];

    const catalogs: TranslationCatalog[] = [];

    for (const source of sources) {
        try {
            catalogs.push(await source.load());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Failed to load ${source.name}: ${message}`);
        }
    }

    return new Translator({
        defaultLocale: "en",
        catalog: mergeCatalogs(catalogs),
        onMissingTranslation: (key: string, locale: string): void => {
            console.warn(`Missing translation: ${locale}:${key}`);
        },
    });
}

const translator = await buildTranslator();

console.log(translator.translate("greeting", "nl", { name: "Alice" }));
// "Hallo Alice" — resolved from the merged catalog
```

### Layering File Defaults Under Runtime Overrides

Ship defaults in JSON files and override them per key and locale with data from a database, CMS, or admin panel — later catalogs win.

Given `translations/en.json`:

```json
{
    "greeting": "Hello",
    "farewell": "Goodbye"
}
```

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog } from "blendsdk/i18n";
import { JsonFileSource } from "blendsdk/i18n-node";

// Layer 1 — file-based defaults
const fileCatalog = await new JsonFileSource({
    paths: ["./translations/en.json"],
}).load();

// Layer 2 — runtime overrides (from a database, CMS, or admin panel)
const overrides: TranslationCatalog = {
    greeting: { en: "Hello from the CMS" },
};

const translator = new Translator({
    defaultLocale: "en",
    catalog: mergeCatalogs([fileCatalog, overrides]),
});

console.log(translator.translate("greeting", "en")); // "Hello from the CMS" — override wins
console.log(translator.translate("farewell", "en")); // "Goodbye" — file default preserved
```

### Serving Translations to a Frontend Client

Serialize `getTranslationsForLocale()` as the body of a translations endpoint; plural tuples stay intact so the client can select the form at render time.

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

/** Build the JSON body for a translations endpoint. */
const translationsPayload = (locale: string): string =>
    JSON.stringify(translator.getTranslationsForLocale(locale));

console.log(translationsPayload("nl"));
// {"greeting":"Hallo ${name}","book":["${count} boek","${count} boeken"]}

console.log(translationsPayload("de"));
// {} — unknown locale yields an empty payload
```

### Implementing a Custom TranslationSource

Implement the `TranslationSource` interface for any backend; this example uses row-shaped data and layers it over existing defaults with an atomic `setCatalog()` swap.

```typescript
import { Translator, mergeCatalogs } from "blendsdk/i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/i18n";

/**
 * A custom source backed by rows of { key, locale, value }.
 * A production implementation would query a database or REST API inside load().
 */
class RowSource implements TranslationSource {
    readonly name = "RowSource";

    private readonly rows: Array<{ key: string; locale: string; value: string }>;

    constructor(rows: Array<{ key: string; locale: string; value: string }>) {
        this.rows = rows;
    }

    async load(): Promise<TranslationCatalog> {
        const catalog: TranslationCatalog = {};
        for (const row of this.rows) {
            if (!catalog[row.key]) {
                catalog[row.key] = {};
            }
            catalog[row.key][row.locale] = row.value;
        }
        return catalog;
    }
}

const defaults: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
};

const translator = new Translator({ defaultLocale: "en", catalog: defaults });

const source: TranslationSource = new RowSource([
    { key: "greeting", locale: "en", value: "Hello from the database" },
    { key: "greeting", locale: "nl", value: "Hallo uit de database" },
]);

// Load, compose, then swap the catalog in one atomic operation
translator.setCatalog(mergeCatalogs([translator.getCatalog(), await source.load()]));

console.log(source.name);                            // "RowSource"
console.log(translator.translate("greeting", "en")); // "Hello from the database" — custom source wins
console.log(translator.translate("greeting", "nl")); // "Hallo uit de database"
console.log(translator.translate("farewell", "en")); // "Goodbye" — default preserved
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
