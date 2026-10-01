> **Package**: `blendsdk/webafx-i18n`

# webafx-i18n Advanced Patterns

---

This document collects production-grade patterns for `blendsdk/webafx-i18n`. Every pattern is self-contained: a concrete problem, a complete implementation, an explanation of why it works, and the caveats to watch. The examples build on Overview, Core Concepts, and Basic Usage, and assume a Node.js ≥ 22 WebAFX application where services are resolved with `req.services.get(...)`.

| # | Pattern | Use it when | Combines |
| --- | --- | --- | --- |
| 1 | Layered source precedence | Strings come from several layers — base, per-tenant, hotfix | `jsonFileSource`, `postgresqlSource`, merge order |
| 2 | Snapshot-backed sources | A database or API outage must not block startup or restarts | Custom `TranslationSource`, file I/O, source ordering |
| 3 | Distributed reload | Multiple instances must pick up admin edits without deploys | `reloadChannel`, pub/sub, `i18n:reload` |
| 4 | Validated hot-swap | A bad catalog (dropped keys, empty values) must never go live | Sources, `mergeCatalogs`, `Translator.setCatalog` |
| 5 | Account-first locale | Logged-in users store a language preference on their profile | `resolveLocale`, per-request services |
| 6 | Missing-translation telemetry | You need an untranslated-string backlog without log spam | `onMissingTranslation`, `Translator` |
| 7 | Isolated draft preview | Editors must review drafts against live strings | `Translator`, `mergeCatalogs`, sources |

---

## Pattern 1: Layered Source Precedence for Multi-Tenant Catalogs

### When to Use It

Use this pattern when translation strings come from more than one layer: strings shipped with the repository, per-tenant overrides maintained by administrators in a database, and an emergency "hotfix" layer that must beat everything else. It is the direct application of the plugin's merge rule — sources are loaded in order and later sources win per key + locale — to a real deployment topology.

### Implementation

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

/**
 * Tenant identifiers are interpolated into the SQL filter verbatim,
 * so they must be validated before they reach the source — never pass
 * raw user input into `filter` or `tableName`.
 */
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function createTenantI18nPlugin(
    tenantId: string,
    database: DatabaseClient
): PluginDefinition {
    if (!TENANT_ID_PATTERN.test(tenantId)) {
        throw new Error(`createTenantI18nPlugin: invalid tenant id "${tenantId}"`);
    }

    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            // 1. Base strings shipped with the application (lowest precedence).
            jsonFileSource({ paths: ["./translations/base/*.json"] }),
            // 2. Per-tenant overrides maintained in the database.
            //    With blendsdk/postgresql installed, wire `queryFn` to the
            //    database client from that package — any function that returns
            //    `{ key, locale, value }` rows works.
            postgresqlSource({
                queryFn: (sql) => database.query(sql),
                tableName: "translations",
                filter: `active = true AND app = '${tenantId}'`,
            }),
            // 3. Emergency hotfixes applied last — they beat everything else.
            jsonFileSource({ paths: ["./translations/hotfix/*.json"] }),
        ],
    });
}
```

Given the three layers above, the merged catalog behaves as follows (later sources win per key + locale; locales a later source does not redefine survive):

| Key / locale | Base file | Tenant DB | Hotfix | Served |
| --- | --- | --- | --- | --- |
| `greeting` / `en` | `"Hello"` | `"Welcome back"` | — | `"Welcome back"` |
| `greeting` / `nl` | `"Hallo"` | — | — | `"Hallo"` |
| `checkout.total` / `en` | `"Total"` | — | `"Amount due"` | `"Amount due"` |

### Why This Pattern Is Valuable

- Precedence is expressed once, declaratively, in the `sources` array — every instance and every reload applies the exact same rule.
- Because merging is per key + locale, a tenant row for `greeting/en` overrides only that cell while the base file's `nl` translation keeps working.
- Adding a layer later (a regulatory overlay, a customer-specific file) is one array entry — no changes to existing code or data.
- Database-maintained strings edited by non-developers can override shipped defaults, and combined with runtime reload (Patterns 3 and 4) they go live without redeploys.

### Caveats and Performance Considerations

- **The array order is a contract.** Reordering sources changes semantics — review it like a behavior change, not a config tweak.
- **Every source is loaded at startup and again on every reload.** Keep the number of heavy sources small; each reload re-reads all of them.
- **`filter` and `tableName` are interpolated verbatim into SQL.** Validate identifiers (as above) and never let raw user input reach them.
- **Startup is fail-fast, reload is all-or-nothing.** A throwing source rejects plugin initialization; during a reload, a failure in any source keeps the *entire* previous catalog. Pair startup with Pattern 2 if the database may be unavailable at boot.
- **Partial overrides are the default.** If a tenant must replace an entry entirely, they must supply every locale for that key — otherwise earlier locales bleed through.

---

## Pattern 2: Snapshot-Backed Sources So an Outage Can't Block Startup

### When to Use It

Use this pattern when translations live behind a network dependency (PostgreSQL, a remote API) that is sometimes briefly unreachable during deploys or restarts. Without it, a transient database failure at boot rejects the plugin factory; the snapshot lets the application start with the last known-good catalog instead.

### Implementation

Save the class as `./snapshot-backed-source.ts`:

```typescript
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";

export interface SnapshotBackedSourceConfig {
    /** The primary source — for example a PostgreSQL or remote API source. */
    primary: TranslationSource;
    /** Path to the last-known-good catalog snapshot. */
    snapshotPath: string;
    /** Called when the primary source fails and the snapshot is served instead. */
    onFallback?: (error: Error) => void;
    /** Called when the snapshot cannot be written or read. */
    onSnapshotError?: (error: Error) => void;
}

/**
 * A TranslationSource that wraps a primary source and keeps a JSON snapshot
 * of the last successful load. When the primary source fails at startup or
 * during a reload, the snapshot is served instead of failing the load.
 */
export class SnapshotBackedSource implements TranslationSource {
    public readonly name = "SnapshotBackedSource";

    private readonly primary: TranslationSource;
    private readonly snapshotPath: string;
    private readonly onFallback: ((error: Error) => void) | undefined;
    private readonly onSnapshotError: ((error: Error) => void) | undefined;

    public constructor(config: SnapshotBackedSourceConfig) {
        this.primary = config.primary;
        this.snapshotPath = config.snapshotPath;
        this.onFallback = config.onFallback;
        this.onSnapshotError = config.onSnapshotError;
    }

    public async load(): Promise<TranslationCatalog> {
        try {
            const catalog = await this.primary.load();
            await this.persistSnapshot(catalog);
            return catalog;
        } catch (primaryError) {
            const snapshot = await this.readSnapshot();
            if (snapshot !== null) {
                if (this.onFallback) {
                    this.onFallback(toError(primaryError));
                }
                return snapshot;
            }
            throw new Error(
                `SnapshotBackedSource: "${this.primary.name}" failed and no snapshot exists at ` +
                    `"${this.snapshotPath}": ${toError(primaryError).message}`
            );
        }
    }

    private async persistSnapshot(catalog: TranslationCatalog): Promise<void> {
        try {
            await mkdir(dirname(this.snapshotPath), { recursive: true });
            const temporaryPath = `${this.snapshotPath}.tmp`;
            await writeFile(temporaryPath, JSON.stringify(catalog, null, 2), "utf8");
            // Rename is atomic on the same filesystem: readers never see a half-written file.
            await rename(temporaryPath, this.snapshotPath);
        } catch (error) {
            this.reportSnapshotError(error);
        }
    }

    private async readSnapshot(): Promise<TranslationCatalog | null> {
        try {
            const raw = await readFile(this.snapshotPath, "utf8");
            const parsed: unknown = JSON.parse(raw);
            return isTranslationCatalog(parsed) ? parsed : null;
        } catch (error) {
            if (!isMissingFileError(error)) {
                this.reportSnapshotError(error);
            }
            return null;
        }
    }

    private reportSnapshotError(error: unknown): void {
        if (this.onSnapshotError) {
            this.onSnapshotError(toError(error));
        }
    }
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function isMissingFileError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string" &&
        error.code === "ENOENT"
    );
}

function isTranslationCatalog(value: unknown): value is TranslationCatalog {
    return typeof value === "object" && value !== null;
}
```

Wire it into the plugin as an ordinary source:

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import { SnapshotBackedSource } from "./snapshot-backed-source.js";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createResilientI18nPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            new SnapshotBackedSource({
                primary: postgresqlSource({ queryFn: (sql) => database.query(sql) }),
                snapshotPath: "./var/i18n/database-catalog.snapshot.json",
                onFallback: (error) => {
                    // This should page someone — the database is unreachable.
                    console.error(`I18n: serving snapshot catalog: ${error.message}`);
                },
                onSnapshotError: (error) => {
                    console.error(`I18n: snapshot I/O failed: ${error.message}`);
                },
            }),
        ],
    });
}
```

### Why This Pattern Is Valuable

- **Boot survives transient outages.** A database blip that lasts seconds would otherwise reject the plugin factory and prevent the application from starting.
- **Restarts survive long outages.** The plugin's built-in reload already keeps the previous catalog *in memory* on failure; a process restart loses that memory. The snapshot is what carries the last good catalog across restarts.
- **It's backend-agnostic.** `primary` can be a `PostgreSQLSource`, a remote API source, or another composite — the wrapper only depends on the `TranslationSource` contract.
- **Fail-fast is preserved when it matters.** With no snapshot (first ever boot), the original error is rethrown, so a genuinely broken deployment still fails loudly.

### Caveats and Performance Considerations

- **Serving the snapshot means serving stale content.** That is the intended trade-off, but `onFallback` must be wired to monitoring — silent fallbacks hide outages.
- **The snapshot is refreshed on every successful load** — startup and every reload — so under normal operation it stays current within one reload cycle.
- **One extra disk write per successful load.** Negligible for typical catalogs (thousands of keys); avoid pointing `snapshotPath` at a slow network filesystem if you reload frequently.
- **Treat the snapshot as an operational artifact.** Exclude it from version control; optionally bake a snapshot from a previous environment into your image as a first-boot seed.
- **The validation guard is intentionally light** because the file is written by this class. If other tools start producing snapshots, add real structural validation.

---

## Pattern 3: Distributed Reload After Admin Edits

### When to Use It

Use this pattern when more than one instance serves traffic and copy editors change translations in a database through an admin UI. The editor needs to see the new string immediately on the instance handling the edit, and every other instance must converge without a redeploy.

### Implementation

Configure the plugin to subscribe to a reload channel:

```typescript
import { createI18nPlugin, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createReloadableI18nPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [postgresqlSource({ queryFn: (sql) => database.query(sql) })],
        // Every instance with this channel configured reloads its sources
        // when any message is published on the channel. Requires the
        // pub/sub provider from blendsdk/webafx-cache.
        reloadChannel: "i18n:reload",
        pubsubServiceName: "pubsub",
    });
}
```

Save the admin handler as `./translation-edit-handler.ts`:

```typescript
import type { Request, Response } from "express";

interface TranslationAdminClient {
    execute(sql: string, parameters: string[]): Promise<void>;
}

/**
 * The subset of the pub/sub provider contract (from blendsdk/webafx-cache)
 * that this pattern uses. The plugin resolves the same provider from the
 * service container under `pubsubServiceName` ("pubsub" by default).
 */
interface PubSubProvider {
    subscribe(channel: string, handler: (message: string) => Promise<void> | void): Promise<void>;
    publish(channel: string, message: string): Promise<void>;
}

interface TranslationEdit {
    key: string;
    locale: string;
    value: string;
}

export function createTranslationEditHandler(
    database: TranslationAdminClient,
    reloadChannel: string
): (req: Request, res: Response) => Promise<void> {
    return async (req, res) => {
        const edit = req.body as TranslationEdit;

        // 1. Persist the edit into the translations table.
        await database.execute(
            "UPDATE translations SET value = $1, updated_at = now() WHERE key = $2 AND locale = $3",
            [edit.value, edit.key, edit.locale]
        );

        // 2. Reload this instance immediately so the editor sees the new string.
        const reload = await req.services.get<() => Promise<void>>("i18n:reload");
        await reload();

        // 3. Broadcast an invalidation so every other instance reloads too.
        try {
            const pubsub = await req.services.get<PubSubProvider>("pubsub");
            await pubsub.publish(reloadChannel, JSON.stringify({ key: edit.key, locale: edit.locale }));
        } catch {
            // Pub/sub is optional. Without it, only this instance has the new
            // catalog; the others keep serving the previous one until their
            // reload service is called or they are restarted.
        }

        res.json({ updated: true, key: edit.key, locale: edit.locale });
    };
}
```

### Why This Pattern Is Valuable

- Copy changes go live in seconds with no deploy and no restarts — on every instance, not just one.
- The editor's own request sees the fresh string because the handler reloads the local instance before responding; the broadcast handles the rest of the fleet.
- The whole chain degrades gracefully: without the pub/sub provider the plugin logs that the channel is inactive, startup continues, and local reloads still work.

### Caveats and Performance Considerations

- **Install order matters.** The pub/sub provider must already be registered when the i18n factory runs, or the subscription is skipped. Give the provider plugin (from `blendsdk/webafx-cache`) a numerically lower priority than the i18n plugin's default `40` — for example `30` — or raise the i18n `priority` above it. Check the logs for `subscribed to reload channel` versus `not available`.
- **Every message triggers a full reload of every source on every instance.** Batch bulk edits and publish once per batch; N instances × M messages of full-table reads adds up quickly.
- **The message payload is ignored** by the plugin's handler — the channel is a pure invalidation signal. Keep messages tiny; never send catalog data through it.
- **Self-delivery may cause one extra reload** on the editing instance if the provider delivers published messages back to subscribers. Reloads are idempotent, so this is wasteful, not harmful.
- **Convergence is eventual.** Between the publish and each instance's reload completion, instances can briefly serve different versions of a string. Sequence changes that affect layout or workflows accordingly.
- **The service name is `${serviceName}:reload`.** If you rename the plugin's service via `serviceName`, the reload service lookup in the handler must use the same derived name.
- **The subscription is established once at startup.** Resubscription after provider reconnects is handled by `blendsdk/webafx-cache`, not by this plugin.

---

## Pattern 4: Validated Hot-Swap Reloads

### When to Use It

Use this pattern when a *successfully loaded* catalog can still be wrong — a translator uploads an export that drops 60 % of the keys, or a database migration empties a locale. The built-in `i18n:reload` swaps in whatever loaded; this pattern adds a validation gate between "loaded" and "live" and only performs the atomic swap when the catalog passes policy checks.

### Implementation

Save the module as `./validated-reload.ts`:

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource, mergeCatalogs } from "blendsdk/webafx-i18n";
import type { TranslationCatalog, TranslationSource, Translator } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

/** One place defines source order — shared by the plugin and the validated reload. */
export function createTranslationSources(database: DatabaseClient): TranslationSource[] {
    return [
        jsonFileSource({ paths: ["./translations/*.json"] }),
        postgresqlSource({ queryFn: (sql) => database.query(sql) }),
    ];
}

export function createI18nPluginWithSources(sources: TranslationSource[]): PluginDefinition {
    return createI18nPlugin({ defaultLocale: "en", sources });
}

export class CatalogValidationError extends Error {
    public readonly violations: readonly string[];
    public readonly totalViolations: number;

    public constructor(violations: string[]) {
        const shown = violations.slice(0, 10);
        const remaining = violations.length - shown.length;
        super(
            `Catalog validation failed: ${shown.join("; ")}` +
                (remaining > 0 ? ` (+${remaining} more violation(s))` : "")
        );
        this.name = "CatalogValidationError";
        this.violations = violations;
        this.totalViolations = violations.length;
    }
}

export interface CatalogValidationPolicy {
    /** The merged catalog must contain at least this many keys. */
    minimumKeyCount: number;
    /** These locales must be present for every key. */
    requiredLocales: readonly string[];
}

export function validateCatalog(
    catalog: TranslationCatalog,
    policy: CatalogValidationPolicy
): void {
    const violations: string[] = [];
    const keys = Object.keys(catalog);

    if (keys.length < policy.minimumKeyCount) {
        violations.push(
            `catalog contains ${keys.length} keys, expected at least ${policy.minimumKeyCount}`
        );
    }

    for (const key of keys) {
        const entry = catalog[key];
        for (const locale of policy.requiredLocales) {
            if (!(locale in entry)) {
                violations.push(`"${key}" is missing locale "${locale}"`);
                continue;
            }
            const value = entry[locale];
            if (typeof value === "string" && value.trim() === "") {
                violations.push(`"${key}" has an empty "${locale}" value`);
            }
        }
    }

    if (violations.length > 0) {
        throw new CatalogValidationError(violations);
    }
}

/**
 * Loads all sources, validates the merged catalog, and only then swaps it
 * into the shared Translator. On any failure the previous catalog stays active.
 */
export async function reloadValidated(
    translator: Translator,
    sources: TranslationSource[],
    policy: CatalogValidationPolicy
): Promise<void> {
    const catalogs: TranslationCatalog[] = [];
    for (const source of sources) {
        catalogs.push(await source.load());
    }
    const merged = mergeCatalogs(catalogs);
    validateCatalog(merged, policy);
    translator.setCatalog(merged);
}
```

Save the endpoint as `./validated-reload-handler.ts`:

```typescript
import type { Translator, TranslationSource } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";
import { reloadValidated } from "./validated-reload.js";
import type { CatalogValidationPolicy } from "./validated-reload.js";

/** Tune these from your real catalog size, with headroom. */
const POLICY: CatalogValidationPolicy = {
    minimumKeyCount: 250,
    requiredLocales: ["en"],
};

export function createValidatedReloadHandler(
    sources: TranslationSource[]
): (req: Request, res: Response) => Promise<void> {
    return async (req, res) => {
        const translator = await req.services.get<Translator>("i18n");
        try {
            await reloadValidated(translator, sources, POLICY);
            res.json({ reloaded: true });
        } catch (error) {
            res.status(422).json({
                reloaded: false,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    };
}
```

### Why This Pattern Is Valuable

- A successful load says nothing about data quality; validation is the missing check between "loaded" and "live", and it runs **before** the atomic swap.
- On rejection, nothing is swapped — the previous catalog keeps serving, exactly like the plugin's own failure handling, and the operator gets an actionable error with a violation count and samples.
- The policy lives in code, reviewable in pull requests; tightening or loosening thresholds is an explicit, auditable change.
- The swap itself remains atomic (`Translator.setCatalog`), so no request ever observes a partially loaded catalog.

### Caveats and Performance Considerations

- **Only this path is protected.** The built-in `i18n:reload` service and the pub/sub subscription (Pattern 3) perform the standard swap without your policy. For a validated setup, drive reloads exclusively through `reloadValidated` — and do not configure `reloadChannel`, or accept that channel-triggered reloads skip validation.
- **Tune `minimumKeyCount` with headroom.** A threshold set at today's exact key count blocks the legitimate retirement of keys; treat policy changes as part of the catalog change that needs them.
- **Validation cost is O(keys × requiredLocales)** — negligible compared to the source I/O that already happened.
- **Extend deliberately.** Plural tuple shape checks, banned characters, or per-locale coverage ratios can be added inside `validateCatalog` with the same violation-collection structure.
- **Log and alert the 422.** The response truncates the violation list after ten entries; the full list is on the thrown `CatalogValidationError.violations`.

---

## Pattern 5: Account Preference Over Browser Negotiation

### When to Use It

Use this pattern when your application has user accounts with a stored language preference that should beat browser negotiation — but the browser should still decide for anonymous visitors, and an explicit `?locale=` override (QA links, support instructions) must always win. The plugin's locale chain deliberately has no notion of user accounts; this pattern layers one on top without forking the built-in logic.

### Implementation

Save the resolver as `./resolve-user-locale.ts`:

```typescript
import { resolveLocale } from "blendsdk/webafx-i18n";
import type { Request } from "express";

/**
 * The slice of the application's per-request session used here.
 * Register it as your own per-request service (for example "session").
 */
export interface UserSession {
    userId: string;
    preferredLocale: string | null;
}

/**
 * Resolve the request locale, layering the account preference on top of
 * the built-in negotiation chain.
 *
 * Priority:
 * 1. `?locale=` override — support links, QA, shareable URLs
 * 2. Account preference — stored on the user's profile
 * 3. Accept-Language → cookie → default (the built-in chain)
 */
export function resolveUserLocale(
    req: Request,
    preferredLocale: string | null,
    defaultLocale: string,
    cookieName: string | false = "locale"
): string {
    const override = req.query?.locale;
    if (typeof override === "string" && override.trim() !== "") {
        // Delegate to the built-in chain so query trimming matches resolveLocale.
        return resolveLocale(req, defaultLocale, cookieName);
    }
    if (preferredLocale) {
        return preferredLocale;
    }
    return resolveLocale(req, defaultLocale, cookieName);
}
```

Use it in handlers, and persist preference changes to both the profile and the cookie:

```typescript
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";
import { resolveUserLocale } from "./resolve-user-locale.js";
import type { UserSession } from "./resolve-user-locale.js";

export async function greet(req: Request, res: Response): Promise<void> {
    // "session" is the application's own per-request session service.
    const session = await req.services.get<UserSession>("session");
    const translator = await req.services.get<Translator>("i18n");

    const locale = resolveUserLocale(req, session.preferredLocale, "en", "locale");
    res.json({
        locale,
        message: translator.translate("greeting", locale),
    });
}

export function createLocalePreferenceHandler(
    save: (req: Request, locale: string) => Promise<void>,
    supportedLocales: readonly string[],
    cookieName: string | false = "locale"
): (req: Request, res: Response) => Promise<void> {
    return async (req, res) => {
        const body = req.body as { locale: string };

        if (!supportedLocales.includes(body.locale)) {
            res.status(400).json({ error: `Unsupported locale: ${body.locale}` });
            return;
        }

        await save(req, body.locale);

        if (cookieName) {
            // Mirror the plugin's cookie options so the choice survives logout.
            res.cookie(cookieName, body.locale, {
                httpOnly: false,
                sameSite: "lax",
                maxAge: 365 * 24 * 60 * 60 * 1000,
            });
        }

        res.json({ locale: body.locale });
    };
}
```

### Why This Pattern Is Valuable

- Logged-in users get their chosen language on every device; the preference follows the account, not the browser.
- The built-in chain remains fully intact underneath — anonymous visitors are negotiated exactly as documented (query → `Accept-Language` → cookie → default), with no duplicated parsing logic because the helper delegates to `resolveLocale`.
- Explicit overrides keep working everywhere, which matters for support and QA workflows.
- The composition is provably ordered in one function, instead of being scattered across middleware where priority becomes accidental.

### Caveats and Performance Considerations

- **A cookie alone cannot express "account wins over `Accept-Language`"** — the header is checked first in the built-in chain. That is precisely why the composition helper exists; don't rely on simply pre-setting the cookie.
- **Normalize stored preferences to the catalog's format.** `parseAcceptLanguage` normalizes regions to `en_US`-style keys; store and validate preferences in the same shape, as the handler above does, so lookups match catalog keys.
- **Keep the cookie name aligned with `localeCookieName`.** If you disable the plugin cookie with `false`, pass `false` here too and skip the `res.cookie` call.
- **Don't mix both resolvers in one code path.** The plugin's `locale` service still resolves the built-in chain independently — resolve it only when you explicitly want the negotiated value (for example, a "detected language" hint).
- **Resolution itself is cheap** — a few property reads and a short string parse per request; the cost is dominated by whatever loads your session.

---

## Pattern 6: Missing-Translation Telemetry

### When to Use It

Use this pattern when you want a deduplicated backlog of untranslated strings in production — keys that were requested but never translated — without flooding logs with one line per request. It also doubles as a CI coverage check: wire the same reporter in tests and assert the sink received nothing.

### Implementation

Save the reporter as `./missing-translation-reporter.ts`:

```typescript
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface MissingTranslationRecord {
    key: string;
    locale: string;
    occurrences: number;
    firstSeenAt: Date;
}

/**
 * Aggregates missing-translation events and flushes them to an async sink.
 *
 * The Translator calls `record` synchronously on every miss — it only
 * performs in-memory bookkeeping, so translation lookups stay fast.
 */
export class MissingTranslationReporter {
    private readonly pending = new Map<string, MissingTranslationRecord>();
    private timer: NodeJS.Timeout | null = null;
    private flushing = false;
    private dropped = 0;

    public constructor(
        private readonly sink: (records: MissingTranslationRecord[]) => Promise<void>,
        private readonly flushIntervalMs: number = 60_000,
        private readonly maxPendingKeys: number = 5_000
    ) {}

    /** Synchronous hook — pass directly as `onMissingTranslation`. */
    public readonly record = (key: string, locale: string): void => {
        const id = `${locale}\u0000${key}`; // NUL separator avoids key/locale collisions
        const existing = this.pending.get(id);
        if (existing) {
            existing.occurrences += 1;
            return;
        }
        if (this.pending.size >= this.maxPendingKeys) {
            this.dropped += 1;
            return;
        }
        this.pending.set(id, { key, locale, occurrences: 1, firstSeenAt: new Date() });
        this.scheduleFlush();
    };

    /** Number of misses discarded because the pending cap was reached. */
    public get droppedMisses(): number {
        return this.dropped;
    }

    /** Flushes the pending batch now. Safe to call at any time. */
    public async flush(): Promise<void> {
        if (this.flushing) {
            return;
        }
        this.flushing = true;
        this.timer = null;

        const batch = [...this.pending.values()];
        this.pending.clear();

        try {
            if (batch.length > 0) {
                await this.sink(batch);
            }
        } catch {
            // Merge the failed batch back so the next flush retries it.
            for (const record of batch) {
                const id = `${record.locale}\u0000${record.key}`;
                const existing = this.pending.get(id);
                if (existing) {
                    existing.occurrences += record.occurrences;
                } else {
                    this.pending.set(id, record);
                }
            }
        } finally {
            this.flushing = false;
            if (this.pending.size > 0) {
                this.scheduleFlush();
            }
        }
    }

    private scheduleFlush(): void {
        if (this.timer !== null) {
            return;
        }
        this.timer = setTimeout(() => {
            void this.flush();
        }, this.flushIntervalMs);
        this.timer.unref();
    }
}

/** A ready-made sink that appends newline-delimited JSON records to a file. */
export function createJsonlSink(
    path: string
): (records: MissingTranslationRecord[]) => Promise<void> {
    return async (records) => {
        await mkdir(dirname(path), { recursive: true });
        const payload = records
            .map((record) =>
                JSON.stringify({
                    key: record.key,
                    locale: record.locale,
                    occurrences: record.occurrences,
                    firstSeenAt: record.firstSeenAt.toISOString(),
                })
            )
            .join("\n");
        await appendFile(path, `${payload}\n`, "utf8");
    };
}
```

Wire it into the application:

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import { MissingTranslationReporter, createJsonlSink } from "./missing-translation-reporter.js";

const reporter = new MissingTranslationReporter(
    createJsonlSink("./var/i18n/missing-translations.jsonl"),
    // Flush once a minute; the timer is unref'd so it never keeps the process alive.
    60_000
);

// `app` is your WebAFX application instance.
app.use(
    createI18nPlugin({
        defaultLocale: "en",
        sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
        onMissingTranslation: reporter.record,
    })
);

// Flush the last batch during graceful shutdown.
export async function onShutdown(): Promise<void> {
    await reporter.flush();
}
```

The same reporter gives you a translation-coverage test for free:

```typescript
import { describe, expect, it, vi } from "vitest";
import { Translator } from "blendsdk/webafx-i18n";
import { MissingTranslationReporter } from "./missing-translation-reporter.js";
import type { MissingTranslationRecord } from "./missing-translation-reporter.js";

describe("translation coverage", () => {
    it("should report every missing key once per batch, with counts", async () => {
        const sink = vi.fn<(records: MissingTranslationRecord[]) => Promise<void>>()
            .mockResolvedValue(undefined);
        const reporter = new MissingTranslationReporter(sink, 60_000);
        const translator = new Translator({
            defaultLocale: "en",
            catalog: { greeting: { en: "Hello" } },
            onMissingTranslation: reporter.record,
        });

        translator.translate("greeting", "en");
        translator.translate("farewell", "en");
        translator.translate("farewell", "en");

        await reporter.flush();

        expect(sink).toHaveBeenCalledTimes(1);
        expect(sink.mock.calls[0][0]).toEqual([
            expect.objectContaining({ key: "farewell", locale: "en", occurrences: 2 }),
        ]);
    });
});
```

### Why This Pattern Is Valuable

- The translation hot path stays safe: `record` is synchronous and constant-time, and never throws; all I/O happens in batched flushes.
- You get a deduplicated, counted backlog (`occurrences`, `firstSeenAt`) instead of thousands of identical log lines — directly usable as an editorial work queue.
- Memory is bounded by `maxPendingKeys`, with an explicit `droppedMisses` counter you can alert on.
- Failed flushes are retried, not lost; a sink outage degrades telemetry, never the application.

### Caveats and Performance Considerations

- **Keep `record` O(1).** Never perform I/O, allocation-heavy work, or logging inside the callback — it runs on every missed lookup.
- **Retries have no backoff.** A permanently failing sink retries every flush interval; add backoff or dead-lettering at the sink boundary if that matters.
- **Aggregation is per process.** Multiple instances (or worker threads) produce multiple streams; aggregate them in your log pipeline.
- **The timer is unref'd**, so it never keeps the process alive — but that also means a process that exits without calling `flush()` loses the pending batch. Call `reporter.flush()` during graceful shutdown.
- **Choose `maxPendingKeys` deliberately.** Large enough to absorb bursts, small enough that a runaway missing-key loop cannot exhaust memory; watch `droppedMisses`.

---

## Pattern 7: Isolated Draft Previews for Editors

### When to Use It

Use this pattern when editors need to review a draft translation set — an import that has not been published yet — against the live strings, rendered exactly as production would render them. The key requirement is isolation: the draft must never touch the shared singleton `Translator` that serves live traffic.

### Implementation

Save the preview module as `./translation-preview.ts`:

```typescript
import { Translator, mergeCatalogs, jsonFileSource, postgresqlSource, createI18nPlugin } from "blendsdk/webafx-i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

/** Shared by the plugin and the preview tooling — one place defines source order. */
export function createTranslationSources(database: DatabaseClient): TranslationSource[] {
    return [
        jsonFileSource({ paths: ["./translations/*.json"] }),
        postgresqlSource({ queryFn: (sql) => database.query(sql) }),
    ];
}

export function createI18nPluginWithSources(sources: TranslationSource[]): PluginDefinition {
    return createI18nPlugin({ defaultLocale: "en", sources });
}

export interface TranslationPreviewEntry {
    key: string;
    live: string;
    draft: string;
    changed: boolean;
}

/**
 * Renders every key in `locale` twice — once with the live catalog and once
 * with the draft applied on top — using the same merge rules as the plugin.
 * The shared Translator is never touched.
 */
export async function buildTranslationPreview(
    sources: TranslationSource[],
    draft: TranslationCatalog,
    locale: string,
    defaultLocale: string
): Promise<TranslationPreviewEntry[]> {
    // Mirror the plugin's loading behavior: sequential, in configuration order.
    const liveCatalogs: TranslationCatalog[] = [];
    for (const source of sources) {
        liveCatalogs.push(await source.load());
    }
    const liveCatalog = mergeCatalogs(liveCatalogs);

    const liveTranslator = new Translator({ defaultLocale, catalog: liveCatalog });
    const draftTranslator = new Translator({
        defaultLocale,
        catalog: mergeCatalogs([liveCatalog, draft]),
    });

    const keys = [...new Set([...Object.keys(liveCatalog), ...Object.keys(draft)])].sort();

    return keys.map((key) => {
        const live = liveTranslator.translate(key, locale);
        const draftValue = draftTranslator.translate(key, locale);
        return { key, live, draft: draftValue, changed: live !== draftValue };
    });
}
```

Expose it through an admin-only handler:

```typescript
import type { TranslationCatalog, TranslationSource } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";
import { buildTranslationPreview } from "./translation-preview.js";

export function createPreviewHandler(
    sources: TranslationSource[],
    defaultLocale: string
): (req: Request, res: Response) => Promise<void> {
    return async (req, res) => {
        const draft = req.body as TranslationCatalog;
        const locale =
            typeof req.query.locale === "string"
                ? req.query.locale
                : await req.services.get<string>("locale");

        const entries = await buildTranslationPreview(sources, draft, locale, defaultLocale);
        const changed = entries.filter((entry) => entry.changed);

        res.json({
            locale,
            changedCount: changed.length,
            totalCount: entries.length,
            entries,
        });
    };
}
```

### Why This Pattern Is Valuable

- Drafts are isolated by construction: the shared `Translator` registered under `"i18n"` never sees them, so a preview request cannot leak unpublished copy into live traffic.
- The preview goes through the same `mergeCatalogs` + `Translator` pipeline as production, so what reviewers approve is exactly what publishing will render — including locale fallback effects.
- `changedCount` and per-entry `changed` flags give review UIs an instant diff without maintaining a separate comparison engine.
- Preview reuses the same `sources` array as the plugin, so it can never drift from the real source configuration and merge order.

### Caveats and Performance Considerations

- **Every preview request reloads all sources.** Fine for occasional reviews; for heavy catalogs, cache the merged live catalog behind a short TTL, or capture it once at the start of a review session.
- **It is an admin tool.** Validate the draft payload — cap its size and key count — and keep the endpoint behind admin authorization.
- **Never call `setCatalog` with a draft on the shared translator.** That would serve unpublished strings to every request until the next reload; the isolation in this pattern is the entire point.
- **`changed` compares rendered output**, so fallback behavior counts as a change — usually exactly the signal editors want.
- **Keys that exist only in the draft** render `live` through the core translator's not-found behavior and will always be marked `changed`, which is what reviewers need to spot additions.

---

## Related Documentation

- Overview — what the package is, its architecture, and its dependencies
- Core Concepts — the plugin definition, sources, translator, locale resolution, and reload model
- Basic Usage — step-by-step installation and your first translated responses

---

# webafx-i18n Common Scenarios

---

This document is an FAQ-style collection of "How do I…" solutions for `blendsdk/webafx-i18n`. Scenarios are ordered from basic setup to advanced integrations: plugin installation, reading translations, source precedence, database loading, locale resolution, reloads, and custom sources. Every scenario follows the same structure: a question, a short solution, and a complete, runnable TypeScript example.

---

## How do I add i18n to my WebAFX application with JSON translation files?

**Solution** — Create the plugin with `createI18nPlugin()`, register a `jsonFileSource` for your translation files, and install the result with `app.use()`. The plugin loads every matched file at startup, merges the catalogs, and registers its services.

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

// Each JSON file is one complete catalog — contents of ./translations/messages.json:
export const messagesFile: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
};

// Create the plugin with the default locale and a file source…
const i18nPlugin = createI18nPlugin({
    defaultLocale: "en",
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
});

// …and install it on the WebAFX application (`app` is your WebAFX instance)
app.use(i18nPlugin);
```

After installation, three services are available in the container:

| Service | Registration type | Resolves to |
| --- | --- | --- |
| `i18n` | `singleton` | `Translator` built from the merged catalog |
| `i18n:reload` | `singleton` | `() => Promise<void>` that reloads all sources |
| `locale` | `per-request` | the locale resolved for the current request |

Built-in source factories you can mix in the `sources` array:

| Factory | Backend |
| --- | --- |
| `jsonFileSource({ paths: [...] })` | JSON files discovered by glob pattern |
| `contentFileSource({ ... })` | Content files (Node.js-only, re-exported from `blendsdk/i18n-node`) |
| `postgresqlSource({ queryFn })` | PostgreSQL `key` / `locale` / `value` table |
| your own `TranslationSource` | any backend — see [How do I plug in my own translation backend?](#how-do-i-plug-in-my-own-translation-backend) |

---

## How do I read a translated string for the current request?

**Solution** — Resolve the singleton `Translator` from the `i18n` service and the resolved locale from the `locale` per-request service, then call `translate(key, locale)`. The same translator instance serves every request, so no per-request construction is needed.

```typescript
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");

    res.json({
        locale,
        greeting: translator.translate("greeting", locale),
        farewell: translator.translate("farewell", locale),
    });
}
```

---

## How do I control which source wins when the same key exists in multiple sources?

**Solution** — Sources are loaded in configuration order and later sources override earlier ones for the same key + locale — the same rule `mergeCatalogs()` applies inside the plugin. List base content first (files) and administrator-maintained overrides last (database), so overrides win without losing locales that only exist in the files.

```typescript
import {
    createI18nPlugin,
    jsonFileSource,
    mergeCatalogs,
    postgresqlSource,
} from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createOverridingPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            // Base strings from files are loaded first…
            jsonFileSource({ paths: ["./translations/*.json"] }),
            // …and database rows override them for the same key + locale
            postgresqlSource({ queryFn: (sql) => database.query(sql) }),
        ],
    });
}

// The plugin folds the loaded catalogs with exactly this merge rule:
const base: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye" },
};

const overrides: TranslationCatalog = {
    greeting: { en: "Hi there" },
};

const merged = mergeCatalogs([base, overrides]);
console.log(merged.greeting.en); // "Hi there" — later catalog wins
console.log(merged.greeting.nl); // "Hallo" — locales the later catalog does not redefine survive
console.log(merged.farewell.en); // "Goodbye" — keys are the union of all catalogs
```

---

## How do I load translations from a PostgreSQL table?

**Solution** — Use `postgresqlSource()` and point its `queryFn` at whatever executes SQL in your application. The source builds a `SELECT key, locale, value FROM <table> [WHERE <filter>] ORDER BY key, locale` query and normalizes the rows into a catalog.

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";
import type { PostgreSQLSource, TranslationCatalog } from "blendsdk/webafx-i18n";

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

export async function loadDatabaseCatalog(database: DatabaseClient): Promise<TranslationCatalog> {
    // Executes:
    //   SELECT key, locale, value FROM translations
    //     WHERE active = true AND app = 'myapp'
    //     ORDER BY key, locale
    const source = createDatabaseSource(database);
    return source.load();
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `queryFn` | `(sql: string) => Promise<Array<{ key: string; locale: string; value: string }>>` | — (required) | Executes the generated SQL and returns the rows |
| `tableName` | `string` | `"translations"` | Table containing the `key`, `locale`, and `value` columns |
| `filter` | `string` | — | `WHERE` clause without the `WHERE` keyword (useful to scope rows by application or active status) |

**Security note** — `tableName` and `filter` are interpolated into the SQL text verbatim. Keep both static and trusted; never build them from user input.

---

## How do I store plural forms in the database?

**Solution** — Store a JSON array of exactly two strings — `["${count} book","${count} books"]` — in the `value` column; `PostgreSQLSource` parses it into the catalog's `[singular, plural]` tuple. Anything that is not a valid two-element JSON array of strings is kept as a plain string.

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export async function loadPluralCatalog(database: DatabaseClient): Promise<TranslationCatalog> {
    const source = postgresqlSource({ queryFn: (sql) => database.query(sql) });

    try {
        const catalog = await source.load();

        // Row value: ["${count} book","${count} books"] → parsed [singular, plural] tuple
        const value = catalog.bookCount.en;
        if (Array.isArray(value)) {
            const [singular, plural] = value;
            console.log(singular); // "${count} book"
            console.log(plural); // "${count} books"
        }

        return catalog;
    } catch (error) {
        throw new Error(
            `Could not load translations: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
```

How stored values are parsed:

| Stored `value` column | Resulting `TranslationValue` |
| --- | --- |
| `Hello` | `"Hello"` — plain string |
| `["${count} book","${count} books"]` | tuple `["${count} book", "${count} books"]` |
| `["only one"]` | plain string — array has the wrong length |
| `[not valid json` | plain string — not valid JSON |

---

## How do I resolve the locale for an incoming request?

**Solution** — Inside WebAFX the per-request `locale` service already applies the full chain: query parameter → `Accept-Language` header → cookie → default. When you need the same logic outside the service container, call the exported `resolveLocale()` (no cookie side effects); `parseAcceptLanguage()` is exported on its own for custom negotiation utilities.

```typescript
import { parseAcceptLanguage, resolveLocale } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

// Inside a WebAFX handler the locale has already been resolved (and cookie-persisted)
export async function greet(req: Request, res: Response): Promise<void> {
    const locale = await req.services.get<string>("locale");
    const translator = await req.services.get<Translator>("i18n");
    res.json({ locale, message: translator.translate("greeting", locale) });
}

// Standalone resolution — identical priority chain, no cookie is written
export function chooseLocale(req: Request): string {
    return resolveLocale(req, "en", "locale");
}

// The header parser is exported as a pure function
export function preferredFromHeader(header: string): string | null {
    return parseAcceptLanguage(header);
}

const preferred = preferredFromHeader("en-US,en;q=0.9,nl;q=0.8"); // "en_US"
const wildcard = preferredFromHeader("*"); // null
```

Resolution priority — the first source that yields a non-empty value wins:

| Priority | Source | Example | Notes |
| --- | --- | --- | --- |
| 1 | Query parameter | `?locale=nl` | Trimmed; empty or whitespace-only values are skipped |
| 2 | `Accept-Language` header | `nl, en;q=0.8` | Entries sorted by `q` value; wildcard `*` and `q=0` entries are skipped; `en-US` → `en_US` |
| 3 | Cookie | `locale=nl` | Skipped entirely when `localeCookieName` is `false` |
| 4 | Default locale | — | `defaultLocale` from the plugin config (default `"en"`) |

For example: `?locale=nl` beats an `Accept-Language` header of `de`, which beats a `locale=fr` cookie, which beats the configured default.

---

## How do I disable the locale cookie?

**Solution** — Set `localeCookieName: false`. The plugin then neither reads an existing cookie nor writes the resolved locale back. By default the plugin writes the cookie on every request (`httpOnly: false`, `sameSite: "lax"`, one-year `maxAge`), so disabling it is the right move for stateless APIs.

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

const i18nPlugin = createI18nPlugin({
    defaultLocale: "en",
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    localeCookieName: false, // no locale cookie is read or written
});

app.use(i18nPlugin);
```

In standalone use, passing `false` as the third argument to `resolveLocale` skips the cookie step as well (`resolveLocale(req, "en", false)`).

---

## How do I rename the i18n services to avoid name collisions?

**Solution** — Set `serviceName` (default `"i18n"`) and `localeServiceName` (default `"locale"`). The reload service always follows the primary name as `` `${serviceName}:reload` ``. Remember to resolve the new names in your handlers.

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

const i18nPlugin = createI18nPlugin({
    serviceName: "translator",
    localeServiceName: "request-locale",
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
});

// Install on the WebAFX application (`app` is your WebAFX instance)
app.use(i18nPlugin);

export async function greet(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("translator");
    const locale = await req.services.get<string>("request-locale");
    res.json({ message: translator.translate("greeting", locale) });
}
```

Name mapping with this configuration:

| Purpose | Default name | With this config |
| --- | --- | --- |
| Singleton `Translator` | `i18n` | `translator` |
| Reload function | `i18n:reload` | `translator:reload` |
| Per-request locale | `locale` | `request-locale` |

The plugin's `name` also becomes the primary service name — `i18nPlugin.name === "translator"`.

---

## How do I change the plugin installation priority?

**Solution** — Set `priority` on the plugin config; lower numbers install first, and the default is `40`. Change it when your i18n plugin must initialize earlier or later than other plugins in the WebAFX pipeline.

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

const i18nPlugin = createI18nPlugin({
    priority: 10, // install before plugins using the default priority of 40
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
});

console.log(i18nPlugin.name); // "i18n"
console.log(i18nPlugin.priority); // 10
```

---

## How do I log or report missing translations?

**Solution** — Pass an `onMissingTranslation(key, locale)` callback in the plugin config. It is forwarded to the `Translator` and fires on every lookup that cannot be resolved — collect keys in a `Set`, log them, or feed a metrics pipeline.

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";

const missingKeys = new Set<string>();

const i18nPlugin = createI18nPlugin({
    defaultLocale: "en",
    sources: [jsonFileSource({ paths: ["./translations/*.json"] })],
    onMissingTranslation: (key: string, locale: string) => {
        missingKeys.add(`${locale}:${key}`);
        console.warn(`[i18n] missing translation "${key}" for locale "${locale}"`);
    },
});

app.use(i18nPlugin);

export function listMissingTranslations(): string[] {
    return [...missingKeys].sort();
}
```

---

## How do I reload translations without restarting the application?

**Solution** — Resolve the `i18n:reload` singleton service — a `() => Promise<void>` — and await it. All sources are re-read, the catalogs re-merged, and the shared translator's catalog is swapped atomically for every subsequent lookup. On failure the error is logged and the previous catalog is kept; the reload function does not throw.

```typescript
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function reloadTranslations(req: Request, res: Response): Promise<void> {
    const reload = await req.services.get<() => Promise<void>>("i18n:reload");
    await reload();

    const translator = await req.services.get<Translator>("i18n");
    res.json({
        reloaded: true,
        sample: translator.translate("greeting", "en"),
    });
}
```

With a custom `serviceName`, the reload service is named `` `${serviceName}:reload` `` — see [How do I rename the i18n services to avoid name collisions?](#how-do-i-rename-the-i18n-services-to-avoid-name-collisions).

---

## How do I propagate a translation reload across every app instance?

**Solution** — Set `reloadChannel` to a pub/sub channel name. The plugin subscribes at startup through the provider registered under `pubsubServiceName` (default `"pubsub"`, provided by `blendsdk/webafx-cache`), and every message on the channel triggers the same full reload on every subscribed instance.

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createDistributedPlugin(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            postgresqlSource({ queryFn: (sql) => database.query(sql) }),
        ],
        reloadChannel: "i18n:reload",
        pubsubServiceName: "pubsub",
    });
}
```

Publishing a single message on `i18n:reload` — from an admin endpoint, a webhook, or a deployment script — refreshes every running instance without a restart. If the pub/sub provider is not registered (for example, because `blendsdk/webafx-cache` is not installed), the plugin logs that the channel is not available and startup continues normally; only the distributed trigger is inactive, and the manual `i18n:reload` service still works.

---

## How do I plug in my own translation backend?

**Solution** — Implement the `TranslationSource` contract — only `name` and `load()` are required — and add an instance to the plugin's `sources` array. Load order still applies, so an in-memory source placed last acts as a final override layer (handy for tests).

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog, TranslationSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export class InMemorySource implements TranslationSource {
    readonly name = "InMemorySource";

    constructor(private readonly catalog: TranslationCatalog) {}

    async load(): Promise<TranslationCatalog> {
        // Return a defensive copy so callers cannot mutate the source
        return structuredClone(this.catalog);
    }
}

export function createTestAwarePlugin(): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            new InMemorySource({ greeting: { en: "Hi from memory" } }), // wins for "en"
        ],
    });
}
```

Error semantics are worth knowing: a source that throws during `load()` at startup fails plugin initialization, surfacing the problem immediately. The same error during a reload is caught and logged, and the previous catalog is kept — a broken backend never takes down a running application.

---

## How do I support a custom value format in PostgreSQLSource?

**Solution** — `PostgreSQLSource.parseValue()` is `protected`, so subclass it and override the method to add a value encoding — for example pipe-separated `singular | plural` pairs alongside the built-in JSON arrays. Delegate to `super.parseValue()` for anything your format does not handle.

```typescript
import { PostgreSQLSource } from "blendsdk/webafx-i18n";
import type { PostgreSQLSourceConfig } from "blendsdk/webafx-i18n";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export class PipeSeparatedPluralSource extends PostgreSQLSource {
    protected override parseValue(value: string): string | [string, string] {
        // Support "singular | plural" in addition to the built-in JSON array format
        const parts = value.split(" | ");
        const [singular, plural] = parts;
        if (parts.length === 2 && singular && plural) {
            return [singular, plural];
        }
        return super.parseValue(value);
    }
}

export function createCustomSource(database: DatabaseClient): PostgreSQLSource {
    const config: PostgreSQLSourceConfig = {
        queryFn: (sql) => database.query(sql),
        tableName: "translations",
    };
    return new PipeSeparatedPluralSource(config);
}
```

How the subclass parses stored values:

| Stored `value` | Resulting `TranslationValue` | Handled by |
| --- | --- | --- |
| `Hello` | `"Hello"` | delegated to `super.parseValue()` |
| `1 book \| N books` | tuple `["1 book", "N books"]` | overridden `parseValue()` |
| `["1 book","N books"]` | tuple `["1 book", "N books"]` | delegated to `super.parseValue()` |

Because `parseValue()` only runs while normalizing rows, the override applies both at plugin startup and on every reload.

---

**See also**

- Overview — what the package is and its key features
- Core Concepts — deep dive into every abstraction
- Basic Usage — step-by-step setup

---

# webafx-i18n Examples Library

---

This library collects copy-paste-ready examples for every feature area of `blendsdk/webafx-i18n`. Every example is a complete ESM TypeScript module with all of its imports; server-side examples assume a WebAFX application instance named `app`, and request handlers resolve services through the request-scoped container (`await req.services.get<T>(name)`).

- **Plugin Setup** — create, configure, and install the plugin
- **Translation Sources** — file, database, and custom translation backends
- **Locale Resolution** — the query → `Accept-Language` → cookie → default priority chain
- **Using the Translator** — translating in handlers, missing-key hooks, and catalog merging
- **Runtime Reload** — refreshing translations manually and via pub/sub
- **Testing Patterns** — mocks and assertions modeled on the package test suite

For conceptual background, see Overview and Core Concepts.

---

## Plugin Setup

### Create a Minimal Plugin Definition

The smallest valid configuration takes an empty `sources` array. All three services are still registered, and the returned definition exposes the standard `name`, `priority`, and `factory` shape.

```typescript
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

// Even without sources, the plugin registers the "i18n", "i18n:reload",
// and "locale" services so the container wiring is always in place.
const plugin: PluginDefinition = createI18nPlugin({
    sources: [],
});

console.log(plugin.name); // "i18n"
console.log(plugin.priority); // 40
console.log(typeof plugin.factory); // "function"
```

### Install the Plugin with JSON File Translations

The typical setup: point `jsonFileSource` at a glob of translation files and install the plugin during application bootstrap.

```typescript
import { createI18nPlugin, jsonFileSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

export function createAppI18n(): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            // Loads every JSON file matching the glob pattern
            jsonFileSource({ paths: ["./translations/*.json"] }),
        ],
    });
}

// In your application bootstrap (`app` is your WebAFX application instance):
// app.use(createAppI18n());
```

### Customize Service Names and Plugin Priority

Rename the registered services when the defaults collide with your own container entries, and use `priority` to control install order (lower numbers install first).

```typescript
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

const plugin: PluginDefinition = createI18nPlugin({
    sources: [],
    // Translator service is registered as "translations"
    // (the reload helper becomes "translations:reload")
    serviceName: "translations",
    // Resolved per-request locale is registered as "request-locale"
    localeServiceName: "request-locale",
    // Install before the default priority of 40
    priority: 10,
});

console.log(plugin.name); // "translations"
console.log(plugin.priority); // 10
```

### Full Production Configuration

A complete configuration that combines both source types with missing-key reporting, locale cookie persistence, and distributed reload.

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createProductionI18n(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        // Fallback when query, header, and cookie yield nothing
        defaultLocale: "en",
        // Loaded in order — later sources override earlier ones per key + locale
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            postgresqlSource({
                queryFn: (sql) => database.query(sql),
                tableName: "translations",
                filter: "active = true",
            }),
        ],
        // Report gaps to logs or metrics
        onMissingTranslation: (key, locale) => {
            console.warn(`[i18n] missing key="${key}" locale="${locale}"`);
        },
        // Persist the resolved locale in a "locale" cookie
        localeCookieName: "locale",
        // Refresh across instances via blendsdk/webafx-cache pub/sub
        reloadChannel: "i18n:reload",
        pubsubServiceName: "pubsub",
        priority: 40,
    });
}

// In your bootstrap (`app` is your WebAFX instance, `database` your client):
// app.use(createProductionI18n(database));
```

---

## Translation Sources

Translation sources are the backends the plugin loads translations from. Sources are loaded in order and merged — for the same key + locale, later sources override earlier ones. The package ships with the sources below, and any object implementing the `TranslationSource` contract (a `name` plus an async `load()`) works just as well.

| Source | Factory | Backend |
| --- | --- | --- |
| `JsonFileSource` | `jsonFileSource({ paths: [...] })` | JSON files matched by glob patterns |
| `ContentFileSource` | `contentFileSource(config)` | Content-managed translation files |
| `PostgreSQLSource` | `postgresqlSource({ queryFn, tableName?, filter? })` | `key` / `locale` / `value` table through an injected query function |
| Custom | — | Any object with `name: string` and `load(): Promise<TranslationCatalog>` |

### Implement an In-Memory Translation Source

Custom sources only need a `name` and an async `load()`. In-memory catalogs are useful for fixtures, tests, and small applications that keep translations in code.

```typescript
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";

export class InMemorySource implements TranslationSource {
    readonly name = "InMemorySource";

    constructor(private readonly catalog: TranslationCatalog) {}

    async load(): Promise<TranslationCatalog> {
        return this.catalog;
    }
}

const source = new InMemorySource({
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye", nl: "Tot ziens" },
});

const catalog: TranslationCatalog = await source.load();
console.log(catalog.greeting.nl); // "Hallo"
```

### Load a Catalog Directly from a Source

Sources are self-contained — call `load()` yourself when you only need the data (tooling, scripts, pre-flight checks) instead of going through the plugin.

```typescript
import { jsonFileSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

const source = jsonFileSource({ paths: ["./translations/*.json"] });

const catalog: TranslationCatalog = await source.load();

console.log(Object.keys(catalog).length);
// Number of translation keys found across all matched files
```

### Layer File and Database Sources

The order of `sources` defines precedence: for the same key + locale, later sources win. A common pattern is files as the base and database rows as the override layer.

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createLayeredI18n(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            // Base strings from files, loaded first
            jsonFileSource({ paths: ["./translations/*.json"] }),
            // Database rows override the base per key + locale
            postgresqlSource({
                queryFn: (sql) => database.query(sql),
                filter: "active = true",
            }),
        ],
    });
}

// Merge behavior for a key that exists in both sources:
//   file source:  greeting → { en: "Hello", nl: "Hallo" }
//   database row: greeting → { en: "Hi there" } (active = true)
//   merged:       greeting → { en: "Hi there", nl: "Hallo" }
```

### Implement a Remote API Source

Implement `TranslationSource` to pull translations from a remote API, keeping the plugin unaware of the transport. Note the payload validation — a custom source should fail loudly on unexpected data.

```typescript
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";

export class RemoteApiSource implements TranslationSource {
    readonly name = "RemoteApiSource";

    constructor(private readonly endpoint: string) {}

    async load(): Promise<TranslationCatalog> {
        const response = await fetch(this.endpoint);
        if (!response.ok) {
            throw new Error(`RemoteApiSource: HTTP ${response.status} from ${this.endpoint}`);
        }

        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null) {
            throw new Error(`RemoteApiSource: malformed catalog from ${this.endpoint}`);
        }

        return payload as TranslationCatalog;
    }
}

const source = new RemoteApiSource("https://translations.example.com/api/catalog");
const catalog = await source.load();
console.log(Object.keys(catalog).length);
// Number of keys served by the remote API
```

### Load Translations from PostgreSQL

`PostgreSQLSource` generates SQL against a `key` / `locale` / `value` table and runs it through your `queryFn` — no database driver is baked in. The example uses an inline stand-in client; in production, wire `queryFn` to your real client (for example from `blendsdk/postgresql`).

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

interface TranslationRow {
    key: string;
    locale: string;
    value: string;
}

interface DatabaseClient {
    query(sql: string): Promise<TranslationRow[]>;
}

// Stand-in for your real database client
const database: DatabaseClient = {
    async query(sql: string): Promise<TranslationRow[]> {
        console.log(`SQL: ${sql}`);
        return [
            { key: "greeting", locale: "en", value: "Hello" },
            { key: "greeting", locale: "nl", value: "Hallo" },
            { key: "farewell", locale: "en", value: "Goodbye" },
        ];
    },
};

const source = postgresqlSource({ queryFn: (sql) => database.query(sql) });
const catalog: TranslationCatalog = await source.load();

console.log(catalog);
// SQL: SELECT key, locale, value FROM translations ORDER BY key, locale
// {
//   greeting: { en: "Hello", nl: "Hallo" },
//   farewell: { en: "Goodbye" }
// }
```

### Use a Custom Table Name and Filter

`tableName` and `filter` adapt the generated query to your schema. Both are interpolated into the SQL verbatim — keep them static and trusted, never built from user input.

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";

interface TranslationRow {
    key: string;
    locale: string;
    value: string;
}

const database = {
    async query(sql: string): Promise<TranslationRow[]> {
        console.log(`SQL: ${sql}`);
        return [];
    },
};

const source = postgresqlSource({
    queryFn: (sql) => database.query(sql),
    tableName: "i18n_strings",
    filter: "active = true AND app = 'myapp'",
});

await source.load();
// SQL: SELECT key, locale, value FROM i18n_strings WHERE active = true AND app = 'myapp' ORDER BY key, locale
```

### Parse Plural Values from the Database

Values that look like two-element JSON arrays are parsed into `[singular, plural]` tuples; anything else — plain text or malformed JSON — stays a plain string.

```typescript
import { postgresqlSource } from "blendsdk/webafx-i18n";
import type { TranslationCatalog, TranslationValue } from "blendsdk/webafx-i18n";

interface TranslationRow {
    key: string;
    locale: string;
    value: string;
}

const rows: TranslationRow[] = [
    { key: "book", locale: "en", value: '["${count} book","${count} books"]' },
    { key: "book", locale: "nl", value: '["${count} boek","${count} boeken"]' },
    { key: "note", locale: "en", value: "[not valid json" },
];

const source = postgresqlSource({ queryFn: async () => rows });
const catalog: TranslationCatalog = await source.load();

const englishBook: TranslationValue | undefined = catalog.book?.en;
if (Array.isArray(englishBook)) {
    const [singular, plural] = englishBook;
    console.log(singular); // "${count} book"
    console.log(plural); // "${count} books"
}

console.log(catalog.note.en); // "[not valid json"
```

---

## Locale Resolution

Locale resolution decides the language of each request with a fixed priority chain: `?locale=` query parameter → `Accept-Language` header → cookie → configured default. Both helpers are exported for direct use, and the plugin wraps them in the per-request `locale` service.

### Resolve the Locale for an Incoming Request

`resolveLocale()` applies the full priority chain to an Express-style request. The helper below builds a minimal `Request` double that carries only the three properties the resolver reads.

```typescript
import { resolveLocale } from "blendsdk/webafx-i18n";
import type { Request } from "express";

// Minimal Request double — resolveLocale() only reads these three properties.
function mockRequest(overrides: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
} = {}): Request {
    const partialRequest: Partial<Request> = {
        query: overrides.query ?? {},
        headers: overrides.headers ?? {},
        cookies: overrides.cookies ?? {},
    };
    return partialRequest as Request;
}

// 1. Query parameter (?locale=nl) — trimmed, highest priority
console.log(resolveLocale(mockRequest({ query: { locale: "  nl  " } }), "en", "locale"));
// "nl"

// 2. Accept-Language header — quality-sorted, regions normalized
console.log(
    resolveLocale(
        mockRequest({ headers: { "accept-language": "en;q=0.8, de;q=0.9" } }),
        "en",
        "locale"
    )
);
// "de"

// 3. Cookie — default name "locale"; pass false to skip the cookie check
console.log(resolveLocale(mockRequest({ cookies: { locale: "fr" } }), "en", "locale"));
// "fr"

console.log(resolveLocale(mockRequest({ cookies: { locale: "fr" } }), "en", false));
// "en"

// 4. Default locale — nothing matched
console.log(resolveLocale(mockRequest(), "en", "locale"));
// "en"

// When several signals are present, the first match still wins
console.log(
    resolveLocale(
        mockRequest({
            query: { locale: "nl" },
            headers: { "accept-language": "de" },
            cookies: { locale: "fr" },
        }),
        "en",
        "locale"
    )
);
// "nl"
```

### Parse an `Accept-Language` Header

`parseAcceptLanguage()` ranks language preferences by their `q` values, skips wildcards and zero-quality entries, and normalizes the winner's region separator (`en-US` → `en_US`).

```typescript
import { parseAcceptLanguage } from "blendsdk/webafx-i18n";

console.log(parseAcceptLanguage("nl"));
// "nl"

console.log(parseAcceptLanguage("nl, en;q=0.8"));
// "nl"

console.log(parseAcceptLanguage("en;q=0.8, nl;q=0.9, de;q=0.7"));
// "nl" — highest quality wins

console.log(parseAcceptLanguage("en-US,en;q=0.9"));
// "en_US" — region separator normalized

console.log(parseAcceptLanguage("nl;q=0, en"));
// "en" — zero-quality entries are skipped

console.log(parseAcceptLanguage("*"));
// null — wildcard only; callers fall back to their default

console.log(parseAcceptLanguage(""));
// null — nothing usable in the header
```

### Configure Locale Cookie Persistence

By default the per-request `locale` service persists the resolved locale in a `locale` cookie (`httpOnly: false`, `sameSite: "lax"`, one-year max age, refreshed per request). Rename the cookie or disable persistence entirely through the plugin config.

```typescript
import { createI18nPlugin } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

// Default: resolved locale is written to a "locale" cookie and read back
const withDefaultCookie: PluginDefinition = createI18nPlugin({ sources: [] });

// Custom cookie name — resolution checks this cookie as well
const withCustomCookie: PluginDefinition = createI18nPlugin({
    sources: [],
    localeCookieName: "preferred-language",
});

// Disable persistence entirely — no cookie is read or written
const withoutCookie: PluginDefinition = createI18nPlugin({
    sources: [],
    localeCookieName: false,
});
```

---

## Using the Translator

### Translate Content for the Current Request

Inside handlers, resolve both services from the request container and translate with the resolved locale. The translator is a singleton; the locale is negotiated per request.

```typescript
import type { Translator } from "blendsdk/webafx-i18n";
import type { Request, Response } from "express";

export async function getGreeting(req: Request, res: Response): Promise<void> {
    const translator = await req.services.get<Translator>("i18n");
    const locale = await req.services.get<string>("locale");

    res.json({
        locale,
        greeting: translator.translate("greeting", locale),
        farewell: translator.translate("farewell", locale),
    });
}

// GET /greeting?locale=nl
// → { "locale": "nl", "greeting": "Hallo", "farewell": "Tot ziens" }
```

### Create and Update a Translator Instance

When you need a translator outside the plugin lifecycle — scripts, tests, background workers — construct one directly and swap its catalog with `setCatalog()` (the same method the plugin's reload path uses).

```typescript
import { Translator } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

const translator = new Translator({
    defaultLocale: "en",
    catalog: {
        greeting: { en: "Hello" },
    },
});

console.log(translator.translate("greeting", "en"));
// "Hello"

// Replace the live catalog — the swap is immediately visible to lookups
const updated: TranslationCatalog = {
    greeting: { en: "Hi there", nl: "Hallo daar" },
};

translator.setCatalog(updated);

console.log(translator.translate("greeting", "en"));
// "Hi there"

console.log(translator.translate("greeting", "nl"));
// "Hallo daar"
```

### Report Missing Translation Keys

The `onMissingTranslation` callback fires for every key that cannot be resolved — ideal for logging or feeding a metrics pipeline. Configure it on the plugin and it is forwarded to the internal `Translator` untouched; the example below uses a direct instance so the behavior is fully visible.

```typescript
import { Translator } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

const catalog: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
};

const translator = new Translator({
    defaultLocale: "en",
    catalog,
    onMissingTranslation: (key, locale) => {
        console.warn(`Missing translation: key="${key}" locale="${locale}"`);
    },
});

translator.translate("greeting", "en");
// "Hello" — no callback

translator.translate("farewell", "en");
// Console: Missing translation: key="farewell" locale="en"
```

### Merge Catalogs Manually

`mergeCatalogs()` applies a left-to-right merge: the union of all keys, with the last catalog winning per key + locale — the exact rule the plugin uses on your sources in order.

```typescript
import { mergeCatalogs } from "blendsdk/webafx-i18n";
import type { TranslationCatalog } from "blendsdk/webafx-i18n";

const base: TranslationCatalog = {
    greeting: { en: "Hello", nl: "Hallo" },
    farewell: { en: "Goodbye" },
};

const overrides: TranslationCatalog = {
    greeting: { en: "Hi there" },
};

const merged = mergeCatalogs([base, overrides]);

console.log(merged.greeting.en); // "Hi there" — later catalog wins per key + locale
console.log(merged.greeting.nl); // "Hallo" — locales not redefined survive
console.log(merged.farewell.en); // "Goodbye" — keys are the union of all catalogs
```

---

## Runtime Reload

Two mechanisms refresh the catalog at runtime: the always-registered `i18n:reload` service and an optional pub/sub channel. Both reload every source and swap the catalog atomically; if a reload fails, the previous catalog is kept.

### Trigger a Manual Reload

The plugin registers a reload function as a singleton service — expose it through a guarded admin endpoint.

```typescript
import type { Request, Response } from "express";

export async function reloadTranslations(req: Request, res: Response): Promise<void> {
    try {
        // Registered by the plugin; named `${serviceName}:reload` when a
        // custom serviceName is configured
        const reload = await req.services.get<() => Promise<void>>("i18n:reload");
        await reload();
        res.json({ reloaded: true });
    } catch (error) {
        // Source load failures are handled inside reload() — the previous
        // catalog is kept — so only unexpected errors reach this block.
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ reloaded: false, error: message });
    }
}

// POST /admin/i18n/reload
// → { "reloaded": true }
```

### Enable Distributed Reload via Pub/Sub

Set `reloadChannel` to make every instance refresh when a message arrives on the channel. The provider is looked up in the container under `pubsubServiceName` (default `"pubsub"`, provided by `blendsdk/webafx-cache`).

```typescript
import { createI18nPlugin, jsonFileSource, postgresqlSource } from "blendsdk/webafx-i18n";
import type { PluginDefinition } from "blendsdk/webafx";

interface DatabaseClient {
    query(sql: string): Promise<Array<{ key: string; locale: string; value: string }>>;
}

export function createReloadableI18n(database: DatabaseClient): PluginDefinition {
    return createI18nPlugin({
        defaultLocale: "en",
        sources: [
            jsonFileSource({ paths: ["./translations/*.json"] }),
            postgresqlSource({ queryFn: (sql) => database.query(sql) }),
        ],
        // Every instance subscribed to this channel reloads when a
        // message arrives — requires the blendsdk/webafx-cache pub/sub plugin
        reloadChannel: "i18n:reload",
        pubsubServiceName: "pubsub",
    });
}

// Publish to "i18n:reload" from any instance (or admin tooling) after
// updating translations to refresh all subscribed instances.
// If the pub/sub service is missing, the plugin logs that the channel
// is inactive and startup continues normally.
```

---

## Testing Patterns

The patterns below mirror the package's own vitest suite: mock sources, mock requests, and mocked query functions — no I/O required.

### Mock a TranslationSource

A typed mock source built on `vi.fn` — reusable across tests that need catalogs without touching disk or network.

```typescript
import { describe, expect, it, vi } from "vitest";
import type { TranslationSource, TranslationCatalog } from "blendsdk/webafx-i18n";

export function mockSource(name: string, catalog: TranslationCatalog): TranslationSource {
    return {
        name,
        load: vi.fn(async (): Promise<TranslationCatalog> => catalog),
    };
}

describe("mockSource", () => {
    it("returns the configured catalog and records load calls", async () => {
        const source = mockSource("TestSource", {
            greeting: { en: "Hello", nl: "Hallo" },
        });

        const catalog = await source.load();

        expect(source.name).toBe("TestSource");
        expect(source.load).toHaveBeenCalledTimes(1);
        expect(catalog.greeting.en).toBe("Hello");
        expect(catalog.greeting.nl).toBe("Hallo");
    });
});
```

### Assert Plugin Definition Metadata

The plugin definition is plain data: assert `name`, `priority`, and `factory` without booting an application.

```typescript
import { describe, expect, it } from "vitest";
import { createI18nPlugin } from "blendsdk/webafx-i18n";

describe("createI18nPlugin", () => {
    it("uses the default service name and priority", () => {
        const plugin = createI18nPlugin({ sources: [] });

        expect(plugin.name).toBe("i18n");
        expect(plugin.priority).toBe(40);
        expect(typeof plugin.factory).toBe("function");
    });

    it("honors custom service names and priority", () => {
        const plugin = createI18nPlugin({
            sources: [],
            serviceName: "translations",
            priority: 10,
        });

        expect(plugin.name).toBe("translations");
        expect(plugin.priority).toBe(10);
    });
});
```

### Test Locale Resolution with a Mock Request

Build minimal `Request` doubles that only carry the properties `resolveLocale()` reads, then assert the priority chain and `Accept-Language` parsing.

```typescript
import { describe, expect, it } from "vitest";
import { resolveLocale, parseAcceptLanguage } from "blendsdk/webafx-i18n";
import type { Request } from "express";

// Minimal Request double — resolveLocale() only reads these three properties.
function mockRequest(overrides: {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
} = {}): Request {
    const partialRequest: Partial<Request> = {
        query: overrides.query ?? {},
        headers: overrides.headers ?? {},
        cookies: overrides.cookies ?? {},
    };
    return partialRequest as Request;
}

describe("locale resolution", () => {
    it("prefers the query parameter over all other signals", () => {
        const req = mockRequest({
            query: { locale: "nl" },
            headers: { "accept-language": "de" },
            cookies: { locale: "fr" },
        });

        expect(resolveLocale(req, "en", "locale")).toBe("nl");
    });

    it("falls back through header, cookie, and default", () => {
        expect(
            resolveLocale(mockRequest({ headers: { "accept-language": "de" } }), "en", "locale")
        ).toBe("de");

        expect(
            resolveLocale(mockRequest({ cookies: { locale: "fr" } }), "en", "locale")
        ).toBe("fr");

        expect(resolveLocale(mockRequest(), "en", "locale")).toBe("en");
    });

    it("skips the cookie when cookieName is false", () => {
        const req = mockRequest({ cookies: { locale: "de" } });
        expect(resolveLocale(req, "en", false)).toBe("en");
    });

    it("parses quality values and normalizes regions", () => {
        expect(parseAcceptLanguage("en;q=0.8, nl;q=0.9, de;q=0.7")).toBe("nl");
        expect(parseAcceptLanguage("en-US,en;q=0.9")).toBe("en_US");
        expect(parseAcceptLanguage("*")).toBeNull();
    });
});
```

### Test PostgreSQLSource with a Mock Query Function

Mock the `queryFn` callback to test SQL generation, row normalization, plural parsing, and error propagation — all without a database.

```typescript
import { describe, expect, it, vi } from "vitest";
import { PostgreSQLSource } from "blendsdk/webafx-i18n";

interface TranslationRow {
    key: string;
    locale: string;
    value: string;
}

describe("PostgreSQLSource", () => {
    it("normalizes rows into a catalog and generates the default query", async () => {
        const queryFn = vi.fn(async (): Promise<TranslationRow[]> => [
            { key: "greeting", locale: "en", value: "Hello" },
            { key: "greeting", locale: "nl", value: "Hallo" },
            { key: "farewell", locale: "en", value: "Goodbye" },
        ]);

        const source = new PostgreSQLSource({ queryFn });
        const catalog = await source.load();

        expect(queryFn).toHaveBeenCalledWith(
            "SELECT key, locale, value FROM translations ORDER BY key, locale"
        );
        expect(catalog).toEqual({
            greeting: { en: "Hello", nl: "Hallo" },
            farewell: { en: "Goodbye" },
        });
    });

    it("parses plural tuples and keeps malformed JSON as plain text", async () => {
        const queryFn = vi.fn(async (): Promise<TranslationRow[]> => [
            { key: "book", locale: "en", value: '["${count} book","${count} books"]' },
            { key: "note", locale: "en", value: "[not valid json" },
        ]);

        const source = new PostgreSQLSource({ queryFn });
        const catalog = await source.load();

        expect(catalog.book.en).toEqual(["${count} book", "${count} books"]);
        expect(catalog.note.en).toBe("[not valid json");
    });

    it("propagates query failures", async () => {
        const queryFn = vi.fn(async (): Promise<TranslationRow[]> => {
            throw new Error("Connection refused");
        });

        const source = new PostgreSQLSource({ queryFn });

        await expect(source.load()).rejects.toThrow("Connection refused");
    });
});
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
