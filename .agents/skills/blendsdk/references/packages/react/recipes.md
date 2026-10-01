> **Package**: `blendsdk/react`

# react Advanced Patterns

Applications rarely use one feature in isolation: loading overlays appear during authenticated saves, menus hide links the session may not open, and locale switches reload localized server content. This document collects the compositions that emerge in production — each pattern solves a concrete problem by combining the package's providers, hooks, and guards.

Two ground rules apply throughout:

- The helper hooks and test utilities shown here (`useBffClient`, `useBlockingTask`, `renderWithProviders`) are **application-level code** built on the public API. They are not package exports — copy them into your project and adapt them.
- Every package import comes from the `blendsdk/react` root. `react-router` appears only in patterns that navigate, since the redirect-based components require it (optional peer dependency).

| Pattern | Problem It Solves | Features Combined |
|---------|-------------------|-------------------|
| Application Provider Shell | One deliberate composition and configuration point for all providers | GlobalLoader + I18n + Auth |
| Session-Aware BFF Client | CSRF headers, 401 refresh-and-retry, and typed errors for every BFF call | Auth |
| Loader-Managed Blocking Actions | Consistent, translated blocking UX with guaranteed cleanup | GlobalLoader + I18n |
| Layered Route Protection | Authentication and authorization applied at the right route depth | Auth + Authorization + react-router |
| Grant-Driven Navigation | Menus and links derived from the user's grants | Authorization + I18n + react-router |
| Locale-Aware Data Loading | Server-localized content that follows locale switches without races | I18n |
| Testing Provider-Composed Components | Rendering hook-consuming components in tests with real providers | GlobalLoader + I18n + Auth |

---

## Application Provider Shell

**When to use it:** once, at the root of the application — the moment you adopt more than one feature. The order of the providers is not cosmetic: `I18nProvider` drives the global loader during translation loads and locale switches, so it must sit *inside* `GlobalLoaderProvider`. The guard components navigate through `react-router`, so they must sit inside your router — but they belong to the route table, not the shell, because public routes (`/login`, `/not-authorized`) must stay outside the guarded area to avoid redirect loops.

### The Pattern

`AppProviders.tsx` — the single composition point for every provider:

```tsx
import {
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";
import type { ReactNode } from "react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

/**
 * Mount once, as high in the tree as the features are needed.
 * Configuration is captured on mount — see the caveats below.
 */
export function AppProviders({ children }: { children: ReactNode }) {
    return (
        <GlobalLoaderProvider config={{ spinnerColor: "#25b09b" }}>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <AuthProvider config={{ basePath: "/api/auth" }}>{children}</AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

`App.tsx` — the router sits above everything that navigates; the shell provides the features; `AppRoutes` supplies the route table (filled in by the [Layered Route Protection](#layered-route-protection) pattern):

```tsx
import { BrowserRouter } from "react-router";
import { AppProviders } from "./AppProviders";
import { AppRoutes } from "./AppRoutes";

export function App() {
    return (
        <BrowserRouter>
            <AppProviders>
                <AppRoutes />
            </AppProviders>
        </BrowserRouter>
    );
}
```

Why this order, from the outside in:

1. **`GlobalLoaderProvider` first** — `I18nProvider` shows the overlay while translations load and switch, so the loader must be its ancestor.
2. **`I18nProvider` second** — every auth screen (login prompts, error banners, guard fallbacks) may render translated text.
3. **`AuthProvider` third** — scope it to the subtree where sessions matter; an admin console can mount the whole shell at the admin root instead of the application root.
4. **Guards are not in the shell** — `AuthGuard` and the grant gates go into the route table so that `/login` and `/not-authorized` remain reachable for signed-out users.

### Why This Pattern Is Valuable

- **Correct by construction**: the one ordering that works (loader above i18n, guards below the router and the auth provider) is encoded in a single file instead of being rediscovered per screen.
- **One configuration surface**: `basePath`, the translation loader, `defaultLocale`, and loader theming are reviewed in one place. Everything else falls back to the built-in defaults — only `basePath` is required, because `AuthProvider` merges your config with `AUTH_DEFAULTS` on mount.
- **Public routes stay public**: because the shell deliberately omits the guards, there is no path from "signed out" into a redirect loop through the login page.

### Caveats and Performance Notes

- **Configuration is captured on mount, not reactive.** Changing the `config` prop of `GlobalLoaderProvider` or `AuthProvider`, or the `loader` of `I18nProvider`, has no effect until the provider remounts. When a configuration genuinely must change at runtime, force a remount with a `key`:

    ```tsx fragment
    <GlobalLoaderProvider key={themeId} config={{ spinnerColor: themeColor }}>
        <App />
    </GlobalLoaderProvider>
    ```

- **Pick the initial locale before mount.** `defaultLocale` fixes the language of the first catalog; users change it afterwards through `setLocale()`, which re-fetches and shows the overlay. Detect the browser language above the provider and pass it in — do not try to "correct" it with props later.
- **`react-router` is only for the redirect-based components.** Providers and the plain hooks (`useGlobalLoader`, `useTranslations`, `useAuth`, `useAuthorization`) never touch it; an application without route protection does not need the dependency.
- **Remounts are not free.** Remounting `AuthProvider` repeats the session check and re-schedules auto-refresh; remounting `I18nProvider` re-fetches translations. Use `key`-based remounts deliberately, not as a state-management tool.

---

## Session-Aware BFF Client

**When to use it:** as soon as more than one component calls authenticated endpoints. Left to itself, each call site re-reads the CSRF token (or forgets it, producing sporadic `403`s), re-implements 401 handling (or doesn't, leaving screens stuck), and parses response bodies ad hoc. This pattern funnels the entire BFF contract — credentials, CSRF header, session refresh, typed errors — through one hook.

### The Pattern

`useBffClient.ts` — the request wrapper:

```typescript
import { useCallback } from "react";
import { useAuth } from "blendsdk/react";

/** Error thrown for any non-2xx response from the BFF. */
export class BffError extends Error {
    /** HTTP status code of the failed response. */
    readonly status: number;
    /** Parsed JSON body of the failed response, when present. */
    readonly body: unknown;

    constructor(status: number, message: string, body: unknown) {
        super(message);
        this.name = "BffError";
        this.status = status;
        this.body = body;
    }
}

export interface BffRequestOptions {
    /** HTTP method; defaults to "GET". */
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    /** JSON-serializable request body. */
    body?: unknown;
    /** Optional signal for cancellation. */
    signal?: AbortSignal;
}

/** Call signature returned by useBffClient. */
export type BffRequest = <T>(path: string, options?: BffRequestOptions) => Promise<T>;

/**
 * Cookie-session aware fetch wrapper for BFF endpoints.
 *
 * - prefixes `apiBase` (the business API root — not the auth `basePath`)
 * - sends the per-session CSRF token on state-changing calls
 * - retries once after a successful session refresh when the session expired
 */
export function useBffClient(apiBase: string): BffRequest {
    const { config, csrfToken, refresh, login } = useAuth();

    return useCallback(
        async function request<T>(path: string, options: BffRequestOptions = {}): Promise<T> {
            const method = options.method ?? "GET";
            const headers: Record<string, string> = { Accept: "application/json" };

            let payload: string | undefined;
            if (options.body !== undefined) {
                headers["Content-Type"] = "application/json";
                payload = JSON.stringify(options.body);
            }

            // State-changing calls carry the per-session CSRF token.
            if (method !== "GET" && csrfToken !== null) {
                headers[config.csrfHeader] = csrfToken;
            }

            const send = async (): Promise<Response> =>
                fetch(`${apiBase}${path}`, {
                    method,
                    headers,
                    body: payload,
                    credentials: "same-origin",
                    signal: options.signal,
                });

            let response = await send();

            // The cookie session expired or was cleared: refresh once and retry.
            if (response.status === 401) {
                const renewed = await refresh();
                if (!renewed) {
                    login(window.location.pathname);
                    throw new BffError(401, `Session expired: ${method} ${path}`, null);
                }
                response = await send();
            }

            if (!response.ok) {
                let body: unknown = null;
                try {
                    body = await response.json();
                } catch {
                    // The error response carried no JSON body.
                }
                throw new BffError(
                    response.status,
                    `${method} ${path} failed with HTTP ${response.status}`,
                    body,
                );
            }

            // 204 No Content — callers type T as void.
            if (response.status === 204) {
                return undefined as T;
            }

            return (await response.json()) as T;
        },
        [apiBase, config, csrfToken, refresh, login],
    );
}
```

A caller, using the typed surface:

```tsx
import { useState } from "react";
import { BffError, useBffClient } from "./useBffClient";

interface Document {
    id: string;
    title: string;
}

export function DocumentTitleForm({ documentId }: { documentId: string }) {
    const request = useBffClient("/api");
    const [title, setTitle] = useState("");
    const [errorStatus, setErrorStatus] = useState<number | null>(null);

    const handleSave = async () => {
        setErrorStatus(null);
        try {
            await request<Document>(`/documents/${documentId}`, {
                method: "PUT",
                body: { title },
            });
        } catch (error) {
            if (error instanceof BffError) {
                setErrorStatus(error.status);
                return;
            }
            // Not an HTTP failure — let your error reporting surface it.
            throw error;
        }
    };

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
            }}
        >
            <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Title" />
            <button type="submit">Save</button>
            {errorStatus !== null && <p role="alert">The save failed (HTTP {errorStatus}).</p>}
        </form>
    );
}
```

| Without the pattern | With the pattern |
|---------------------|------------------|
| Each call site re-reads `csrfToken` — or forgets it, causing sporadic `403`s | One place attaches `config.csrfHeader` for state-changing calls |
| Expired sessions surface as raw errors and stuck screens | One refresh attempt with retry; a failed refresh redirects to login |
| Response bodies parsed and cast ad hoc | One generic `request<T>` with a typed `BffError` |

### Why This Pattern Is Valuable

- **The CSRF contract lives in one place.** `config.csrfHeader` and `csrfToken` are read once; when the server changes the header name, you change one config value, not a hundred call sites.
- **Sessions heal once, transparently.** A 401 triggers one `refresh()`; if it succeeds the original request is retried, and if it fails the user is sent to the login flow with the current path as `returnTo`.
- **Typed at the boundary.** `request<T>` and `BffError.status` replace stringly-typed error handling, so `403` (denied) and `401` (no session) are distinguishable in a typed `instanceof` check.
- **Stable identity.** The `useCallback` result only changes when the session data it depends on changes, so it is safe to list in effect dependencies.

### Caveats and Performance Notes

- **One retry, no loops.** A second 401 after a successful refresh becomes a `BffError`; the user sees the failure instead of the request retrying forever.
- **CSRF rotation on refresh.** The retried request re-sends the token captured in the current render. If your deployment rotates the session id (and therefore the CSRF token) on refresh, that retry can still be rejected with `403`; the *next* call from the UI picks up the fresh token from context. Keep error handling for that case.
- **Retry idempotency.** The retry fires only after a 401, meaning the server rejected the request without processing it. For strict guarantees on non-idempotent `POST`s, pair the pattern with an idempotency key if your BFF supports one.
- **Same-origin only.** The wrapper sends `credentials: "same-origin"`; do not reuse it for third-party APIs.
- **No global loader here, on purpose.** Background reads should not freeze the UI. Blocking belongs at the action layer — the next pattern.
- **Provider dependency.** The hook calls `useAuth()` and therefore throws if mounted outside `AuthProvider`, just like the package's own hooks.

---

## Loader-Managed Blocking Actions

**When to use it:** for user-initiated work that should visibly freeze the interface — saves, submits, destructive actions. The `GlobalLoader` overlay is a single shared instance, and manual driving of `showLoader`/`setText` leaks: one forgotten `showLoader(false)` leaves the app blocked, and English literals creep into every handler. This pattern wraps any task in translated, self-cleaning blocking feedback.

### The Pattern

`useBlockingTask.ts` — the wrapper, with a depth counter so overlapping tasks inside one owner hide the overlay only when the last one finishes:

```typescript
import { useCallback, useRef } from "react";
import { useGlobalLoader, useTranslations } from "blendsdk/react";

export type BlockingTask = <T>(messageKey: string, task: () => Promise<T>) => Promise<T>;

/**
 * Runs a task behind the global loader with a translated message.
 * The overlay is hidden (and its text cleared) when the last nested
 * task settles — success or failure.
 */
export function useBlockingTask(): BlockingTask {
    const { showLoader, setText } = useGlobalLoader();
    const { t } = useTranslations();
    const depth = useRef(0);

    return useCallback(
        async function run<T>(messageKey: string, task: () => Promise<T>): Promise<T> {
            depth.current += 1;
            setText(t(messageKey));
            showLoader(true);
            try {
                return await task();
            } finally {
                depth.current -= 1;
                if (depth.current === 0) {
                    showLoader(false); // hides the overlay and clears the text
                }
            }
        },
        [showLoader, setText, t],
    );
}
```

This is the save form from the [previous pattern](#session-aware-bff-client), now with blocking feedback, translated messaging, and the request client composed in:

```tsx
import { useState } from "react";
import { useGlobalLoader, useTranslations } from "blendsdk/react";
import { BffError, useBffClient } from "./useBffClient";
import { useBlockingTask } from "./useBlockingTask";

interface Document {
    id: string;
    title: string;
}

export function DocumentTitleForm({ documentId }: { documentId: string }) {
    const request = useBffClient("/api");
    const runBlocking = useBlockingTask();
    const { t } = useTranslations();
    const { visible } = useGlobalLoader();
    const [title, setTitle] = useState("");
    const [errorKey, setErrorKey] = useState<string | null>(null);

    const handleSave = async () => {
        setErrorKey(null);
        try {
            await runBlocking("documents.saving", () =>
                request<Document>(`/documents/${documentId}`, {
                    method: "PUT",
                    body: { title },
                }),
            );
        } catch (error) {
            // Store a message key — not a translated string — so the alert
            // follows later locale switches like every other text.
            if (error instanceof BffError && error.status === 403) {
                setErrorKey("documents.saveDenied");
            } else {
                setErrorKey("documents.saveFailed");
            }
        }
    };

    return (
        <section aria-busy={visible}>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void handleSave();
                }}
            >
                <label>
                    {t("documents.titleLabel")}
                    <input value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
                <button type="submit" disabled={visible}>
                    {t("documents.save")}
                </button>
            </form>
            {errorKey !== null && <p role="alert">{t(errorKey)}</p>}
        </section>
    );
}
```

| Without the pattern | With the pattern |
|---------------------|------------------|
| `setText` + `showLoader(true/false)` + `try/finally` duplicated in every handler | One `runBlocking(messageKey, task)` wrapper |
| English literals baked into the overlay | Message keys resolved through `t()` |
| A missed `showLoader(false)` leaves the app blocked | Cleanup in `finally`, depth-tracked |
| Errors stored as rendered strings that ignore locale changes | Errors stored as keys, translated at render |

### Why This Pattern Is Valuable

- **Every blocking operation looks identical.** The overlay, its message placement, and its lifecycle are uniform because every action goes through the same wrapper.
- **Cleanup cannot be forgotten.** The `finally` block hides the overlay whether the task succeeds, fails, or throws a validation error; the depth counter prevents an early finish from uncovering a still-running sibling task.
- **Translated by construction.** Callers pass a message *key*; the text follows the active locale, and error alerts are stored as keys so they re-render in the user's language even if the locale changes after the failure.

### Caveats and Performance Notes

- **The overlay is shared; last writer wins.** A second component calling `showLoader(true)` or `setText(...)` affects the same instance, and a hide from anywhere removes it for everyone. The depth counter protects overlap *within one `useBlockingTask` instance* only — keep one owner per screen, or accept last-wins semantics for cross-feature overlap.
- **Reserve it for user-initiated work.** A background refetch behind a full-screen overlay is hostile; expose a local busy state instead (see [Locale-Aware Data Loading](#locale-aware-data-loading)).
- **Hiding clears the text automatically** — never read or reuse `text` after `showLoader(false)`.
- **Accessibility beyond the visual overlay.** The overlay covers the screen, but keyboard users can still tab to elements behind it. Reflect the state with `aria-busy` and disabled controls (as above) so the block is real for every input method.
- **Toggling is cheap; blocking is not.** The overlay is a single CSS-only element, so rendering cost is negligible — the cost you manage is *delaying the user's next action*. Scope the block to what truly must be exclusive.
- **A hung task keeps the overlay up.** Pair blocking operations with request timeouts or `AbortSignal` from the [request client](#session-aware-bff-client) so a stalled network call cannot freeze the UI indefinitely.

---

## Layered Route Protection

**When to use it:** whenever the application has both public and protected areas, and protected routes with different grant requirements. Two distinct states need two distinct destinations: an **anonymous** visitor belongs on the login page (`AuthGuard` → `config.loginPath`), while a **signed-in user without the right grant** belongs on the not-authorized page (grant gate → `config.notAuthorizedPath`). Getting this layering wrong produces redirect loops or — worse — silently reachable deep links.

The package covers the common cases directly:

| Requirement | How to express it |
|-------------|-------------------|
| Signed-in users only | `AuthGuard` around the area's layout route |
| A single grant (role or permission) on a route or area | `RequireAccess` (built-in) |
| A single grant around an element | `Can` (built-in) |
| Compound or any-of requirements (role AND permission, lists) | A small custom gate over `useAuthorization` — below |

### The Pattern

`RequireInvoicesAccess.tsx` — a compound gate for requirements the built-ins cannot express in one check:

```tsx
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAuth, useAuthorization } from "blendsdk/react";

/**
 * The invoices area requires both the "finance" role AND the "invoice:read"
 * permission. `RequireAccess` covers single grants; combining checks (or
 * any-of lists like `can("a") || can("b")`) takes a small component like this.
 */
export function RequireInvoicesAccess({ children }: { children: ReactNode }) {
    const { hasRole, can } = useAuthorization();
    const { config } = useAuth();

    if (!(hasRole("finance") && can("invoice:read"))) {
        return <Navigate to={config.notAuthorizedPath} replace />;
    }

    return <>{children}</>;
}
```

`AppRoutes.tsx` — the layers in the route table: public routes first, then the authenticated area, then the section-level gate:

```tsx
import { Navigate, Outlet, Route, Routes } from "react-router";
import { AuthGuard } from "blendsdk/react";
import { RequireInvoicesAccess } from "./RequireInvoicesAccess";
import { DashboardPage } from "./pages/DashboardPage";
import { InvoicesPage } from "./pages/InvoicesPage";
import { LoginPage } from "./pages/LoginPage";
import { NotAuthorizedPage } from "./pages/NotAuthorizedPage";

/** Layout for the protected area — rendered only for authenticated sessions. */
function AppLayout() {
    return (
        <main>
            <Outlet />
        </main>
    );
}

export function AppRoutes() {
    return (
        <Routes>
            {/* Public routes: reachable without a session. */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/not-authorized" element={<NotAuthorizedPage />} />

            {/* Authenticated area: everything below AuthGuard sees a session. */}
            <Route
                path="/app"
                element={
                    <AuthGuard>
                        <AppLayout />
                    </AuthGuard>
                }
            >
                <Route index element={<DashboardPage />} />
                <Route
                    path="invoices"
                    element={
                        <RequireInvoicesAccess>
                            <InvoicesPage />
                        </RequireInvoicesAccess>
                    }
                />
            </Route>

            {/* Unknown paths fall back into the guarded area. */}
            <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
    );
}
```

### Why This Pattern Is Valuable

- **Two states, two destinations.** Anonymous visitors are handled once, at the top (`AuthGuard` → `loginPath`); signed-in users lacking a grant are sent to `notAuthorizedPath` — never to the login page they cannot use.
- **Deep links pass the same stack.** Entering `/app/invoices` by URL runs exactly the same checks as clicking through the interface, because the protection *is* the route definition.
- **Declarative redirects have no races.** The gate renders `<Navigate>` during render — no effects, no flash of protected content, no "check then navigate" timing.
- **Composable predicates.** The gate builds on `useAuthorization`, so any logic the business defines — role AND permission, any-of lists, exception carve-outs — is expressible while the single-grant cases stay on the built-ins.

### Caveats and Performance Notes

- **Mount grant gates inside an `AuthGuard`.** By the time a gate evaluates, the user is signed in (or `AuthGuard` is already redirecting). A gate reached without a session would send an anonymous visitor to the *not-authorized* page, which is the wrong destination.
- **Client-side protection is UX, not security.** Redirects shape what the interface offers; the server remains the authority and must reject what the user may not do.
- **`authorized` is not a grant.** The context's `authorized` flag is the server's verdict on the session itself, separate from `can`/`hasRole`. If your BFF uses it, surface it distinctly (for example a banner) rather than treating it as an empty permission set.
- **Keep the redirect targets public.** `/login` and `/not-authorized` live outside the guarded branch, and named pages — not wildcards — own those paths.
- **Cost is negligible.** Gates are tiny components; the memoized predicates make re-evaluation cheap, so the checks can sit at whatever depth the requirements dictate.

---

## Grant-Driven Navigation

**When to use it:** for sidebars, tabs, menus, and command palettes — any set of links whose visibility depends on grants. Ad-hoc `can()` calls sprinkled through JSX drift apart; a single data-driven navigation model keeps routes, labels, and requirements in one place and lets the menu refilter itself when the session changes.

### The Pattern

`Sidebar.tsx` — one nav model, filtered by the memoized predicates:

```tsx
import { useMemo } from "react";
import { NavLink } from "react-router";
import { useAuthorization, useTranslations } from "blendsdk/react";

interface NavItem {
    /** Route path of the destination. */
    to: string;
    /** Translation key for the visible label. */
    labelKey: string;
    /** Permission required to see the entry; omit to show it to everyone. */
    permission?: string;
    /** Match only the exact path (dashboard-style entries). */
    end?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
    { to: "/app", labelKey: "nav.dashboard", end: true },
    { to: "/app/invoices", labelKey: "nav.invoices", permission: "invoice:read" },
    { to: "/app/users", labelKey: "nav.users", permission: "user:manage" },
    { to: "/app/audit", labelKey: "nav.audit", permission: "audit:read" },
];

export function Sidebar() {
    const { can } = useAuthorization();
    const { t } = useTranslations();

    // `can` is memoized on the session user, so this list only recomputes
    // when the user's grants actually change.
    const visibleItems = useMemo(
        () => NAV_ITEMS.filter((item) => item.permission === undefined || can(item.permission)),
        [can],
    );

    return (
        <nav aria-label={t("nav.ariaLabel")}>
            <ul>
                {visibleItems.map((item) => (
                    <li key={item.to}>
                        <NavLink
                            to={item.to}
                            end={item.end === true}
                            className={({ isActive }) => (isActive ? "nav-active" : undefined)}
                        >
                            {t(item.labelKey)}
                        </NavLink>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
```

The protected layout from the [previous pattern](#layered-route-protection) hosts it:

```tsx
import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar";

export function AppLayout() {
    return (
        <div className="app-shell">
            <Sidebar />
            <main>
                <Outlet />
            </main>
        </div>
    );
}
```

### Why This Pattern Is Valuable

- **Single source of truth.** A destination's path, label, and grant requirement are declared once in `NAV_ITEMS`; adding a section is a one-line change, not a scavenger hunt through JSX.
- **No offers the user cannot accept.** Hiding links up front beats the dead-end click to a not-authorized page — the interface stays honest about what is possible.
- **Localized and reactive.** Labels resolve through translation keys, so the menu follows locale switches; because `can` is memoized on the session user, the menu refilters automatically after a session refresh delivers new grants.
- **Composable extension.** Entries that need a role instead of a permission filter through `hasRole` from the same hook — the model accepts whatever predicate the entry carries.

### Caveats and Performance Notes

- **Hiding is cosmetic — again.** The server enforces access; the *routes* must enforce it too. Every `to` in the nav model should have a guarded destination ([Layered Route Protection](#layered-route-protection)), or a bookmarked URL re-opens what the menu hid.
- **Prefer permissions for feature areas, roles for personas.** Roles are bundles that change with org structure; per-feature permissions age better. Use `hasRole` for badges and coarse personas rather than gating every link on a role.
- **The memoization is the performance story.** The filter is O(items) and runs only when the user's grants change; do not defeat it by including unstable dependencies (fresh objects, inline functions) in the `useMemo`.
- **`NavLink` matching gotcha.** Parent paths like `/app` stay active on every child route unless you pass `end` — hence the flag on the dashboard entry.

---

## Locale-Aware Data Loading

**When to use it:** for views whose *content* — not just labels — is localized by the server: reports, generated documents, taxonomy lists, exported previews. This pattern binds such content to the active `locale` from `useTranslations()` and cancels stale loads, so rapid locale switching can never display the wrong language.

### The Pattern

`LocalizedReport.tsx` — the effect is the locale subscription; translations are resolved at render, so the effect depends only on data-relevant values:

```tsx
import { useEffect, useState } from "react";
import { useTranslations } from "blendsdk/react";

interface Report {
    id: string;
    title: string;
    body: string;
}

/**
 * Loads a server-localized report and follows the active locale.
 * Stale loads are ignored on locale switches so a slow response for an
 * old locale can never overwrite a newer one.
 */
export function LocalizedReport({ reportId }: { reportId: string }) {
    const { locale, ready, t } = useTranslations();
    const [report, setReport] = useState<Report | null>(null);
    const [errorKey, setErrorKey] = useState<string | null>(null);

    useEffect(() => {
        // Wait until the first catalog is in place so labels and errors
        // resolve like everywhere else in the application.
        if (!ready) {
            return;
        }

        let cancelled = false;

        // Clear immediately: last locale's text under the new language's
        // chrome reads as a bug.
        setReport(null);
        setErrorKey(null);

        const load = async () => {
            try {
                const response = await fetch(`/api/reports/${reportId}?locale=${locale}`);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const data = (await response.json()) as Report;
                if (!cancelled) {
                    setReport(data);
                }
            } catch {
                if (!cancelled) {
                    setErrorKey("reports.loadFailed");
                }
            }
        };

        void load();

        return () => {
            cancelled = true;
        };
    }, [reportId, locale, ready]);

    if (errorKey !== null) {
        return <p role="alert">{t(errorKey)}</p>;
    }

    if (report === null) {
        return <p aria-busy="true">{t("reports.loading")}</p>;
    }

    return (
        <article>
            <h2>{report.title}</h2>
            <p>{report.body}</p>
        </article>
    );
}
```

### Why This Pattern Is Valuable

- **One reactive trigger.** `locale` from context is the single source of truth; the effect re-runs exactly when it changes — no wiring of language pickers, no duplicated "current language" state.
- **Race-proof by cleanup.** The cancellation flag ensures that when responses arrive out of order during fast switching, only the newest locale's response is applied.
- **A deliberate loading split.** `setLocale()` already shows the global loader while the *translations* load — that block is correct, because nothing is readable without the catalog. Content on the page refreshes with a local busy state instead, keeping the chrome usable. Reserve the [blocking pattern](#loader-managed-blocking-actions) for user-initiated actions only.

### Caveats and Performance Notes

- **Clear vs. stale-while-revalidate.** This example clears content during reload to avoid mixed languages. If your content is expensive and rarely switching, "keep old content, show a subtle busy hint" is a legitimate alternative — decide per screen.
- **Cancellation flags ignore results; they do not abort connections.** When the request itself should be cancelled, add an `AbortController` and pass its `signal` to `fetch` — the cleanup function is the natural place to call `abort()`.
- **Locale belongs in your cache keys.** Any server-side caching, CDN, or ETag for localized content must vary by locale, or switching languages will serve the previous language from cache.
- **`reloadTranslations()` is the catalog counterpart.** When translations themselves change server-side (for example, an admin edits them), call `reloadTranslations()` — do not remount the provider.
- **Errors as keys, translated at render.** As in the blocking-actions pattern, storing `"reports.loadFailed"` rather than a translated string keeps the alert correct across subsequent locale switches.

---

## Testing Provider-Composed Components

**When to use it:** every time a component under test consumes one of the package's hooks — which is most of them, since hooks throw outside their providers. A single render helper that mirrors the application's provider composition keeps tests honest: they run against real context, real loader behavior, and real translation lookup, with a deterministic seam for async assertions. The stack is the same one the package itself uses: Vitest with React Testing Library under jsdom.

### The Pattern

`test/renderWithProviders.tsx` — the harness, mirroring the [Application Provider Shell](#application-provider-shell):

```tsx
import { render, type RenderResult } from "@testing-library/react";
import {
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";
import type { ReactNode } from "react";

/** Minimal catalogs: just the keys the tests assert on. */
const testCatalogs: Record<string, Record<string, TranslationValue>> = {
    en: {
        "documents.titleLabel": "Title",
        "documents.save": "Save",
        "documents.saving": "Saving…",
        "documents.saveDenied": "You are not allowed to edit this document.",
        "documents.saveFailed": "The document could not be saved.",
    },
    nl: {
        "documents.titleLabel": "Titel",
        "documents.save": "Opslaan",
        "documents.saving": "Opslaan…",
        "documents.saveDenied": "Je mag dit document niet bewerken.",
        "documents.saveFailed": "Het document kon niet worden opgeslagen.",
    },
};

const testTranslationLoader: TranslationLoader = async (locale) => testCatalogs[locale] ?? {};

/** Renders `ui` inside the same provider composition the application uses. */
export function renderWithProviders(ui: ReactNode): RenderResult {
    return render(
        <GlobalLoaderProvider>
            <I18nProvider loader={testTranslationLoader} defaultLocale="en">
                <AuthProvider config={{ basePath: "/api/auth" }}>{ui}</AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>,
    );
}
```

`test/DocumentTitleForm.test.tsx` — a deferred response lets the test observe the blocked state, not just the outcome:

```tsx
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentTitleForm } from "../src/DocumentTitleForm";
import { renderWithProviders } from "./renderWithProviders";

describe("DocumentTitleForm", () => {
    let resolveSave: (() => void) | null = null;

    beforeEach(() => {
        resolveSave = null;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url =
                    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

                // The save call is deferred so the test can observe the
                // blocking overlay before the request settles.
                if (url.endsWith("/api/documents/42") && init?.method === "PUT") {
                    await new Promise<void>((resolve) => {
                        resolveSave = resolve;
                    });
                    return new Response(JSON.stringify({ id: "42", title: "Updated title" }), {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                // Everything else — including the auth session check — fails,
                // which leaves the session anonymous.
                return new Response(null, { status: 404 });
            }),
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it("blocks the UI with a translated message while the save is in flight", async () => {
        renderWithProviders(<DocumentTitleForm documentId="42" />);

        const titleInput = await screen.findByLabelText("Title");
        fireEvent.change(titleInput, { target: { value: "Updated title" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        // The overlay message resolves through the test catalog.
        expect(await screen.findByText("Saving…")).toBeInTheDocument();

        // Release the request; the overlay hides and clears its message.
        resolveSave?.();
        await waitFor(() => {
            expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
        });
    });
});
```

The `toBeInTheDocument()` matchers come from `@testing-library/jest-dom`; register the Vitest entry point (for example `import "@testing-library/jest-dom/vitest";`) in your test setup file.

### Why This Pattern Is Valuable

- **Tests exercise the real contracts.** The component runs against genuine context wiring: the loader overlay really shows and clears, `t()` really resolves from catalogs, and hooks would throw if the composition were wrong — the same failure a user would hit.
- **Deterministic blocking assertions.** Deferring the response exposes the "in flight" state explicitly; tests assert *behavior while blocked*, not just the final result, and never race a microtask-fast mock.
- **Catalog gaps surface early.** Any key a test exercises must exist in the test catalogs, turning missing translations into an obvious test failure instead of a silent key echo in production.
- **Explicit lifecycle.** `cleanup()` and `vi.unstubAllGlobals()` in `afterEach` keep tests isolated regardless of your Vitest `globals` configuration.

### Caveats and Performance Notes

- **`AuthProvider` checks the session on mount.** Tests that mount the harness should stub `fetch`; an unstubbed check settles as an anonymous session. For authenticated scenarios, return your BFF's `/me` payload from the stub — its shape is defined by your backend, so mirror exactly what your server sends.
- **Await everything that settles asynchronously.** The initial catalog load is a promise: use `findBy*`/`waitFor` for translated text and loader state; a `getBy*` immediately after render may run before `ready` flips.
- **Assert user-observable behavior, not internals.** Query by role, label, and text. The overlay's markup is configurable (`textComponent`, colors) and therefore not a stable assertion target — the message text and the hide behavior are.
- **Keep a two-layer test strategy.** Pure presentational components (receiving grants and data via props) can be tested without any provider at all — fast and focused. Reserve the full harness for the integration cases where context behavior is the point.
- **One harness, many tests.** Centralizing the composition means when the application shell changes (a new provider, a new default locale), tests follow through a single edit.

---

All seven patterns compose: the shell provides the providers, the client carries the session, blocking actions and locale-aware loading shape the UX, the route layers and navigation enforce and reflect access, and the test harness verifies the result. Adopt them incrementally — each one is useful on its own, and none of them require the others to be in place first.

---

# react Common Scenarios

This document answers the everyday "how do I…" questions that come up when integrating `blendsdk/react` into an application. Each scenario is self-contained: a short explanation followed by a complete, runnable example. Scenarios are ordered from the simplest setup tasks to the more involved flows and troubleshooting cases.

| Area | What these scenarios cover |
|------|----------------------------|
| GlobalLoader | Showing and hiding the overlay, appearance and custom text, updating messages, config lifecycle |
| I18n | Loading catalogs from an API, interpolation, plurals, locale switching, readiness, missing keys, reloading |
| Auth | Session checks, `authorized` vs. `isAuthenticated`, endpoint configuration, sign-in and sign-out, return paths, route protection, CSRF, manual refresh |
| Authorization | Role and permission gating, diagnosing fail-closed checks |
| Composition & troubleshooting | Provider nesting order, fixing provider-scope errors |

---

## How do I show a global loading overlay during an async task?

Wrap your application in `GlobalLoaderProvider` and call `useGlobalLoader()` from any component inside it. Show the overlay before the async work starts and hide it in a `finally` block, so it can never get stuck on screen.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function RefreshStatsButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleRefresh = async () => {
        setText("Refreshing stats…");
        showLoader(true);
        try {
            const response = await fetch("/api/stats");
            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}`);
            }
        } catch (error) {
            console.error("Could not refresh stats:", error);
        } finally {
            showLoader(false);
        }
    };

    return <button onClick={() => void handleRefresh()}>Refresh stats</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <RefreshStatsButton />
        </GlobalLoaderProvider>
    );
}
```

The overlay is global — one instance is shared by every consumer inside the provider. `showLoader(false)` also clears any text set with `setText()`, so you never have to reset the message manually.

---

## How do I customize the spinner's colors, size, and background?

Pass a `GlobalLoaderConfig` object to the provider's `config` prop. Every property is optional; omitted ones fall back to the built-in defaults.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function OverlayToggle() {
    const { showLoader, visible } = useGlobalLoader();

    return (
        <button onClick={() => showLoader(!visible)}>
            {visible ? "Hide" : "Show"} overlay
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider
            config={{
                spinnerColor: "#25b09b",
                spinnerWidth: 4,
                spinnerSize: 64,
                backgroundColor: "rgba(255, 255, 255, 0.85)",
                textColor: "#1f2937",
                zIndex: 1200,
            }}
        >
            <OverlayToggle />
        </GlobalLoaderProvider>
    );
}
```

| Option | Type | Default |
|--------|------|---------|
| `spinnerColor` | `string` | `"#888888"` |
| `spinnerWidth` | `number` | `3` |
| `spinnerSize` | `number` | `50` |
| `backgroundColor` | `string` | `"#fafafa"` |
| `textColor` | `string` | `"#888888"` |
| `zIndex` | `number` | `999999` |

---

## How do I render custom text below the spinner?

Supply the `textComponent` render prop. It receives `{ text, textColor }` and must return a `ReactElement` that replaces the default caption entirely.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";
import type { ReactElement } from "react";

const renderLoadingText = ({ text, textColor }: { text: string; textColor: string }): ReactElement => (
    <span style={{ color: textColor, fontSize: 18, fontWeight: 600, letterSpacing: 0.5 }}>
        {text}
    </span>
);

function SyncButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleSync = async () => {
        setText("Synchronizing…");
        showLoader(true);
        try {
            await fetch("/api/sync", { method: "POST" });
        } finally {
            showLoader(false);
        }
    };

    return <button onClick={() => void handleSync()}>Sync now</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider config={{ textComponent: renderLoadingText, textColor: "#1f2937" }}>
            <SyncButton />
        </GlobalLoaderProvider>
    );
}
```

The default renderer is a `<p>` element with `color: textColor`, `fontSize: 14px`, and `marginTop: 16px`.

---

## How do I update or clear the loading message while the overlay stays visible?

Call `setText()` again with the new message to replace it mid-operation, or pass `null` (or `""`) to clear the message without hiding the overlay. Hiding always clears the text automatically.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function ImportButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleImport = async () => {
        showLoader(true);
        try {
            setText("Uploading file…");
            const upload = await fetch("/api/import/upload", { method: "POST" });
            if (!upload.ok) {
                throw new Error(`Upload failed with status ${upload.status}`);
            }

            // The overlay stays visible; only the message changes.
            setText("Validating rows…");
            const validate = await fetch("/api/import/validate", { method: "POST" });
            if (!validate.ok) {
                throw new Error(`Validation failed with status ${validate.status}`);
            }

            setText(null); // clears the message while the overlay is still visible
            const commit = await fetch("/api/import/commit", { method: "POST" });
            if (!commit.ok) {
                throw new Error(`Import failed with status ${commit.status}`);
            }
        } catch (error) {
            console.error("Import failed:", error);
        } finally {
            showLoader(false); // hides the overlay and clears the text
        }
    };

    return <button onClick={() => void handleImport()}>Run import</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <ImportButton />
        </GlobalLoaderProvider>
    );
}
```

---

## How do I change the loader configuration after the provider has mounted?

You can't update it in place — configuration is captured on mount and is not reactive. Remount the provider (for example with a React `key`) whenever the config must change, such as theme-dependent spinner colors.

```tsx
import { GlobalLoaderProvider, type GlobalLoaderConfig, useGlobalLoader } from "blendsdk/react";
import { useState } from "react";

type Theme = "light" | "dark";

const THEME_CONFIGS: Record<Theme, GlobalLoaderConfig> = {
    light: { spinnerColor: "#25b09b", backgroundColor: "#fafafa", textColor: "#1f2937" },
    dark: { spinnerColor: "#7dd3fc", backgroundColor: "#0f172a", textColor: "#e2e8f0" },
};

function ThemedWorkButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleRun = async () => {
        setText("Working…");
        showLoader(true);
        try {
            await fetch("/api/tasks/run", { method: "POST" });
        } finally {
            showLoader(false);
        }
    };

    return <button onClick={() => void handleRun()}>Run task</button>;
}

export function App() {
    const [theme, setTheme] = useState<Theme>("light");

    return (
        <div>
            <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
                Switch theme
            </button>
            {/* The key forces a remount so the new config is captured. */}
            <GlobalLoaderProvider key={theme} config={THEME_CONFIGS[theme]}>
                <ThemedWorkButton />
            </GlobalLoaderProvider>
        </div>
    );
}
```

Note that remounting the provider also resets the state of the subtree it wraps.

---

## How do I load translations from an API?

Pass a `TranslationLoader` to `I18nProvider` — an async function that receives a locale and returns a flat key/value map. The provider calls it for `defaultLocale` (default `'en'`) on mount and exposes `ready` when loading succeeds.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function HomePage() {
    const { t, ready } = useTranslations();

    if (!ready) {
        return <p>Loading…</p>;
    }

    return <h1>{t("home.title")}</h1>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <HomePage />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

Mount `I18nProvider` inside `GlobalLoaderProvider`: locale switching uses the global overlay while re-fetching, which is why the loader provider must sit above it.

---

## How do I translate a message with dynamic values?

Pass the interpolation values as the second argument to `t()`. Each entry in the params object is available to the translation under its key.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function WelcomeBanner({ name, company }: { name: string; company: string }) {
    const { t, ready } = useTranslations();

    if (!ready) {
        return null;
    }

    return <p>{t("welcome.message", { name, company })}</p>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <WelcomeBanner name="Ada" company="TrueSoftware" />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## How do I handle plural forms?

Pass a `count` value in the params object of `t()`. The translation engine selects the plural form that matches `count` instead of returning a single fixed string.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function UnreadCount({ count }: { count: number }) {
    const { t, ready } = useTranslations();

    if (!ready) {
        return null;
    }

    return <span>{t("inbox.unread", { count })}</span>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <UnreadCount count={1} />
                <UnreadCount count={5} />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

The catalog entry for the key defines the plural forms; `count` selects the matching form and is also available for interpolation within it.

---

## How do I switch the active locale at runtime?

Call `setLocale()` from `useTranslations()`. The provider re-fetches through your loader for the new locale and shows the global loader overlay while the fetch is in flight, so `GlobalLoaderProvider` must wrap `I18nProvider`.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function LocalePicker() {
    const { locale, setLocale, ready } = useTranslations();

    return (
        <select
            value={locale}
            disabled={!ready}
            onChange={(event) => setLocale(event.target.value)}
        >
            <option value="en">English</option>
            <option value="nl">Nederlands</option>
            <option value="de">Deutsch</option>
        </select>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <LocalePicker />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## How do I show a fallback while translations are not ready yet?

Check the `ready` boolean — it is `false` until the initial loader call has completed successfully. Render a placeholder or skeleton until then so the UI does not show untranslated content.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function CheckoutPage() {
    const { t, ready } = useTranslations();

    if (!ready) {
        return <p aria-busy="true">Loading translations…</p>;
    }

    return (
        <section>
            <h1>{t("checkout.title")}</h1>
            <button>{t("checkout.payNow")}</button>
        </section>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <CheckoutPage />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## How do I detect and report missing translation keys?

Pass the optional `onMissingTranslation` callback to the provider. It is invoked with `(key, locale)` whenever a key cannot be resolved — ideal for logging or feeding a translation-gap tracker.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function reportMissingTranslation(key: string, locale: string): void {
    console.warn(`Missing translation "${key}" for locale "${locale}"`);
    void fetch("/api/translations/missing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, locale }),
    });
}

function HomePage() {
    const { t, ready } = useTranslations();

    if (!ready) {
        return null;
    }

    return <h1>{t("home.title")}</h1>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider
                loader={loadTranslations}
                defaultLocale="en"
                onMissingTranslation={reportMissingTranslation}
            >
                <HomePage />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## How do I reload translations after the server-side catalog changes?

Call `reloadTranslations()` — it re-runs the loader for the current locale. Use it after a content deployment, or wire it to a refresh control so administrators can pull new copy without a full page reload.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function ContentToolbar() {
    const { t, reloadTranslations, ready } = useTranslations();

    return (
        <button onClick={reloadTranslations} disabled={!ready}>
            {ready ? t("toolbar.reload") : "Reload translations"}
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <ContentToolbar />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## How do I check whether a user is signed in?

Use `useAuth()` and check `isLoading` first, then `isAuthenticated`. This ordering prevents a "Sign in" button from flashing while the initial session check is still running.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function AccountMenu() {
    const { user, isAuthenticated, isLoading } = useAuth();

    if (isLoading) {
        return <span>Checking session…</span>;
    }

    if (!isAuthenticated) {
        return <span>Not signed in</span>;
    }

    return <span>Signed in as {user?.sub}</span>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AccountMenu />
        </AuthProvider>
    );
}
```

`isAuthenticated` is derived from `user !== null`; `user` holds the OIDC `sub` claim plus any additional claims the BFF attached to the session.

---

## How do I sign a user in and out?

Call `login()` to redirect the browser to the BFF login endpoint — the OIDC round-trip happens entirely server-side, so no tokens ever reach JavaScript. `logout()` is async; await it so the BFF can clear the cookie session and the local state is reset.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function AuthBar() {
    const { user, isAuthenticated, isLoading, login, logout } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return <button onClick={() => login()}>Sign in</button>;
    }

    const handleSignOut = async () => {
        try {
            await logout();
        } catch (error) {
            console.error("Sign-out failed:", error);
        }
    };

    return (
        <div>
            <span>Signed in as {user?.sub}</span>
            <button onClick={() => void handleSignOut()}>Sign out</button>
        </div>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AuthBar />
        </AuthProvider>
    );
}
```

---

## How do I return users to the page they were on after login?

Pass a `returnTo` path to `login()`. Capture the current route with your router and hand it back, so users land where they intended after the OIDC round-trip.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";
import { useLocation } from "react-router";
import type { ReactNode } from "react";

function SignInGate({ children }: { children: ReactNode }) {
    const { isAuthenticated, isLoading, login } = useAuth();
    const location = useLocation();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return (
            <button onClick={() => login(location.pathname)}>
                Sign in to continue to {location.pathname}
            </button>
        );
    }

    return <>{children}</>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth", defaultReturnTo: "/dashboard" }}>
            <SignInGate>
                <h1>Invoice 42</h1>
            </SignInGate>
        </AuthProvider>
    );
}
```

Without an argument, `login()` falls back to `config.defaultReturnTo` (default `'/'`).

---

## How do I protect a route so only signed-in users can see it?

Wrap the protected subtree in `AuthGuard`. It renders its children for authenticated sessions and redirects everyone else to `config.loginPath` (default `'/login'`). The guard relies on react-router, so it must be rendered inside a router.

```tsx
import { AuthGuard, AuthProvider } from "blendsdk/react";
import { BrowserRouter } from "react-router";

function Dashboard() {
    return (
        <main>
            <h1>Dashboard</h1>
            <p>Only authenticated users can see this content.</p>
        </main>
    );
}

export function App() {
    return (
        <BrowserRouter>
            <AuthProvider config={{ basePath: "/api/auth", loginPath: "/sign-in" }}>
                <AuthGuard>
                    <Dashboard />
                </AuthGuard>
            </AuthProvider>
        </BrowserRouter>
    );
}
```

For grant-based routing, the package also ships `RequireAccess`, which redirects signed-in users who lack a required grant to `config.notAuthorizedPath` (default `'/not-authorized'`).

---

## How do I tell the difference between a signed-in and an authorized session?

`isAuthenticated` and `authorized` are separate signals. A session is authenticated when `user` exists, but `authorized` is the server's verdict — `true` only when the session check returned a session that was not denied by the application. Handle the "signed in but not authorized" state explicitly.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function AppShell() {
    const { user, isAuthenticated, isLoading, authorized } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return <p>You are not signed in.</p>;
    }

    if (!authorized) {
        return (
            <p>
                Signed in as {user?.sub}, but this application has not authorized the session.
            </p>
        );
    }

    return <p>Welcome back, {user?.sub}.</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AppShell />
        </AuthProvider>
    );
}
```

`authorized` is `false` before the first session check, for anonymous or failed checks, for a session the application denied, and after logout.

---

## How do I match the auth configuration to my BFF's endpoint layout?

Override `endpoints` — each path is relative to `basePath` and defaults to `/login`, `/callback`, `/logout`, `/me`, and `/refresh`. The frontend route paths (`loginPath`, `notAuthorizedPath`, `defaultReturnTo`) are SPA routes and are configured separately.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionInfo() {
    const { isLoading, isAuthenticated, config } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return <p>Signed out</p>;
    }

    return (
        <p>
            Session endpoint in use: {config.basePath}
            {config.endpoints.me}
        </p>
    );
}

export function App() {
    return (
        <AuthProvider
            config={{
                basePath: "/api/auth",
                endpoints: {
                    login: "/sign-in",
                    callback: "/sign-in/callback",
                    logout: "/sign-out",
                    me: "/session",
                    refresh: "/session/refresh",
                },
                loginPath: "/sign-in",
                notAuthorizedPath: "/forbidden",
                defaultReturnTo: "/dashboard",
            }}
        >
            <SessionInfo />
        </AuthProvider>
    );
}
```

Only `basePath` is required; everything else has a default from `AUTH_DEFAULTS`, and the merged result is exposed fully resolved as `config` on the context.

---

## How do I add the CSRF token to state-changing BFF requests?

Read `csrfToken` from `useAuth()` and send it in the header named by `config.csrfHeader` (default `'x-csrf-token'`) on POST, PUT, PATCH, and DELETE calls. The token is delivered by `GET /me` and may be replaced by `POST /refresh`; `null` means CSRF is not enforced.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SaveProfileButton({ displayName }: { displayName: string }) {
    const { csrfToken, config } = useAuth();

    const handleSave = async () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        const response = await fetch("/api/profile", {
            method: "PUT",
            headers,
            body: JSON.stringify({ displayName }),
        });

        if (response.status === 403) {
            console.error(
                "The CSRF token was rejected. Another tab may have rotated the session token; " +
                    "it will be observed again on the next session check.",
            );
            return;
        }
        if (!response.ok) {
            console.error(`Save failed with status ${response.status}`);
        }
    };

    return <button onClick={() => void handleSave()}>Save profile</button>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SaveProfileButton displayName="Ada Lovelace" />
        </AuthProvider>
    );
}
```

A request made with a token that another browsing context has since replaced can be rejected with `403` until the next session check. If your server uses a different header name, set `csrfHeader` in the auth config to match.

---

## How do I refresh the session manually before a critical operation?

Call `refresh()` from `useAuth()` — it returns `true` on success and `false` on failure, so you can decide whether to continue or ask the user to sign in again. Automatic refresh already runs ahead of expiry by default; a manual refresh is for critical moments such as checkout.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function CheckoutButton() {
    const { refresh } = useAuth();

    const handleCheckout = async () => {
        const refreshed = await refresh();
        if (!refreshed) {
            console.error("Session could not be refreshed — the user must sign in again.");
            return;
        }

        const response = await fetch("/api/checkout", { method: "POST" });
        if (!response.ok) {
            console.error(`Checkout failed with status ${response.status}`);
        }
    };

    return <button onClick={() => void handleCheckout()}>Checkout</button>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth", autoRefresh: true, refreshLeadTime: 120 }}>
            <CheckoutButton />
        </AuthProvider>
    );
}
```

Automatic refresh is on by default (`autoRefresh: true`, triggered 60 seconds before `expiresAt`); `refreshLeadTime` adjusts the lead time.

---

## How do I show or hide UI based on the user's roles and permissions?

Use the `hasRole()` and `can()` predicates from `useAuthorization()` directly in JSX conditionals. They read the canonical grants the server stored on the session user and stay stable between renders.

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";

function InvoiceToolbar() {
    const { can, hasRole } = useAuthorization();

    return (
        <div role="toolbar" aria-label="Invoice actions">
            {hasRole("finance") && <span>Finance</span>}
            {can("invoice:write") && <button>Edit invoice</button>}
            {can("invoice:approve") && <button>Approve invoice</button>}
            {!can("invoice:write") && !can("invoice:approve") && <p>Read-only access</p>}
        </div>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <InvoiceToolbar />
        </AuthProvider>
    );
}
```

For a single check expressed directly in JSX, the package also ships the declarative `Can` component, which renders its children only when the required grant is held; the hook remains the tool for anything computed. Either way, these checks shape the interface only — the server remains the authority that enforces access.

---

## How do I find out why a role or permission check returns false?

Grant checks read `roles` and `permissions` off the session user and fail closed — they never throw for bad data, they return `false`. Common causes:

- **No session yet** — before the initial `/me` check resolves, `user` is `null` and the principal is empty.
- **Anonymous** — a signed-out user holds nothing, so every check returns `false`.
- **Grants missing from the session** — `roles` and `permissions` must be attached to the user object by the BFF after translating the provider identity.
- **Malformed grants** — a missing value, a non-array, or an array containing non-strings is reduced to an empty list, so structural mistakes fail silently.
- **Name mismatch** — the strings passed to `hasRole()` and `can()` must match the stored grant names.

Inspect the resolved grants directly to confirm what the client actually received:

```tsx
import { AuthProvider, useAuth, useAuthorization } from "blendsdk/react";

function AccessDiagnostics() {
    const { isLoading, isAuthenticated, user } = useAuth();
    const { roles, permissions } = useAuthorization();

    if (isLoading) {
        return <p>Session check in progress — grant checks fail closed until it resolves.</p>;
    }

    if (!isAuthenticated) {
        return <p>No session — every hasRole() and can() check returns false.</p>;
    }

    return (
        <dl>
            <dt>Subject</dt>
            <dd>{user?.sub}</dd>
            <dt>Roles</dt>
            <dd>{roles.length > 0 ? roles.join(", ") : "none reported by the session"}</dd>
            <dt>Permissions</dt>
            <dd>{permissions.length > 0 ? permissions.join(", ") : "none reported by the session"}</dd>
        </dl>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AccessDiagnostics />
        </AuthProvider>
    );
}
```

If the diagnostic shows the expected grants but a specific check still fails, compare the check argument against the reported list — evaluation is by exact grant name.

---

## How do I compose all the providers for a full application?

Nest them in this order: `GlobalLoaderProvider` outermost, then `I18nProvider` (it uses the overlay while loading), then `AuthProvider` with `AuthGuard` around the protected subtree. Wrap everything in a router when you use the guard components.

```tsx
import {
    AuthGuard,
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    type TranslationLoader,
} from "blendsdk/react";
import { BrowserRouter } from "react-router";
import type { TranslationValue } from "blendsdk/i18n";
import type { ReactNode } from "react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

export function App({ children }: { children: ReactNode }) {
    return (
        <BrowserRouter>
            <GlobalLoaderProvider>
                <I18nProvider loader={loadTranslations} defaultLocale="en">
                    <AuthProvider config={{ basePath: "/api/auth" }}>
                        <AuthGuard>{children}</AuthGuard>
                    </AuthProvider>
                </I18nProvider>
            </GlobalLoaderProvider>
        </BrowserRouter>
    );
}
```

Order matters for `GlobalLoaderProvider` and `I18nProvider` only; `AuthProvider` is independent of the other two and can be mounted wherever the protected subtree begins.

---

## How do I fix "must be used within a Provider" errors?

Each hook throws when it is called outside its provider's subtree. The most common causes are rendering the consumer as a sibling of the provider, forgetting the provider entirely, or matching the wrong hook to the wrong provider.

| Hook | Error thrown outside its provider |
|------|-----------------------------------|
| `useGlobalLoader` | `useGlobalLoader() must be used within a <GlobalLoaderProvider>.` |
| `useTranslations` | `useTranslations() must be used within an <I18nProvider>.` |
| `useAuth` | `useAuth() must be used within an <AuthProvider>.` |
| `useAuthorization` | Throws through `useAuth()` when no `<AuthProvider>` is present. |

Move the component inside the provider subtree:

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

// This component can call useGlobalLoader() because it is rendered
// inside the <GlobalLoaderProvider> subtree below.
function LoaderStatus() {
    const { visible } = useGlobalLoader();

    return <p aria-live="polite">Overlay: {visible ? "visible" : "hidden"}</p>;
}

export function App() {
    return (
        <>
            <header>My application</header>
            <GlobalLoaderProvider>
                <LoaderStatus />
            </GlobalLoaderProvider>
        </>
    );
}
```

This fail-fast behavior is intentional: a hook used without its provider is a wiring bug, and the error surfaces it at render time instead of returning broken state.

---

For deeper explanations of the concepts behind these scenarios, see Core Concepts and the Overview.

---

# react Examples Library

---

This library collects complete, copy-paste ready examples for every feature area of `blendsdk/react`: the global loading overlay, runtime internationalization, BFF authentication, and UI authorization. Every example is self-contained — all imports are included — and each category progresses from simple to advanced. Auth examples assume a backend-for-frontend that exposes the configured endpoints; the guard and redirect examples additionally assume `react-router` is installed.

| Category | Covers |
|----------|--------|
| [Getting Started](#getting-started) | Minimal loader integration and full provider composition |
| [GlobalLoader Examples](#globalloader-examples) | Overlay control, appearance, custom captions, staged progress |
| [I18n Examples](#i18n-examples) | Catalog loading, interpolation, plurals, locale switching, reloads |
| [Auth Examples](#auth-examples) | Session state, route protection, refresh, CSRF, configuration |
| [Authorization Examples](#authorization-examples) | Grants, `Can`, `RequireAccess`, grant-aware navigation |

---

## Getting Started

These two examples cover the smallest possible integration and the recommended provider nesting for a complete application.

### Minimal Setup: The Global Loader

Wrap a subtree with `GlobalLoaderProvider` and drive the overlay from any child with `useGlobalLoader()`.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function SyncButton() {
    const { showLoader, setText } = useGlobalLoader();

    const sync = async () => {
        setText("Syncing…");
        showLoader(true);
        try {
            await fetch("/api/sync", { method: "POST" });
        } finally {
            showLoader(false);
        }
    };

    return <button onClick={() => { void sync(); }}>Sync</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <SyncButton />
        </GlobalLoaderProvider>
    );
}

// Result: the overlay shows the caption "Syncing…" for the duration of the request
// and hides when it settles — hiding clears the caption automatically.
```

### Composing All Providers

The recommended nesting for a full application: GlobalLoader outermost, I18n inside it, Auth around the guarded routes, and `AuthGuard` protecting a route with `react-router`.

```tsx
import {
    AuthGuard,
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";
import { BrowserRouter, Route, Routes } from "react-router";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function Dashboard() {
    return <h1>Dashboard</h1>;
}

function LoginPage() {
    return <h1>Sign in to continue</h1>;
}

export function App() {
    return (
        <BrowserRouter>
            <GlobalLoaderProvider>
                <I18nProvider loader={loadTranslations} defaultLocale="en">
                    <AuthProvider config={{ basePath: "/api/auth" }}>
                        <Routes>
                            <Route path="/login" element={<LoginPage />} />
                            <Route
                                path="/"
                                element={
                                    <AuthGuard>
                                        <Dashboard />
                                    </AuthGuard>
                                }
                            />
                        </Routes>
                    </AuthProvider>
                </I18nProvider>
            </GlobalLoaderProvider>
        </BrowserRouter>
    );
}

// Result: anonymous visitors to "/" are redirected to "/login"; authenticated visitors
// see the Dashboard. GlobalLoaderProvider is outermost because I18nProvider drives the
// overlay during locale switches.
```

---

## GlobalLoader Examples

The global overlay is driven entirely through `useGlobalLoader()`. These examples cover the standard patterns: wrapping async work, restyling the spinner, replacing the caption, and tracking staged progress.

### Wrapping an Async Task with Error Handling

A save operation that shows the overlay while the request is in flight and surfaces the failure reason after the overlay closes — hiding in `finally` means the loader can never get stuck.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";
import { useState } from "react";

function DocumentEditor() {
    const { showLoader, setText } = useGlobalLoader();
    const [status, setStatus] = useState<string | null>(null);

    const save = async () => {
        setStatus(null);
        setText("Saving document…");
        showLoader(true);
        try {
            const response = await fetch("/api/documents/42", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: "Quarterly report" }),
            });
            if (!response.ok) {
                throw new Error(`The server responded with HTTP ${response.status}`);
            }
            setStatus("Document saved.");
        } catch (error) {
            const message = error instanceof Error ? error.message : "Saving failed.";
            setStatus(message);
        } finally {
            showLoader(false);
        }
    };

    return (
        <div>
            <button onClick={() => { void save(); }}>Save</button>
            {status !== null && <p role="status">{status}</p>}
        </div>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <DocumentEditor />
        </GlobalLoaderProvider>
    );
}

// Result: the overlay carries "Saving document…" until the request settles; afterwards
// the status line reports success or the failure reason.
```

### Customizing the Spinner Appearance

Every visual aspect — spinner color and width, size, background, text color, and z-index — comes from provider configuration, captured on mount.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function RefreshButton() {
    const { showLoader } = useGlobalLoader();

    const refreshMetrics = async () => {
        showLoader(true);
        try {
            await fetch("/api/metrics/refresh", { method: "POST" });
        } finally {
            showLoader(false);
        }
    };

    return <button onClick={() => { void refreshMetrics(); }}>Refresh metrics</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider
            config={{
                spinnerColor: "#1d4ed8",
                spinnerWidth: 4,
                spinnerSize: 64,
                backgroundColor: "rgba(15, 23, 42, 0.65)",
                textColor: "#e2e8f0",
                zIndex: 1_000_000,
            }}
        >
            <RefreshButton />
        </GlobalLoaderProvider>
    );
}

// Result: a 64px spinner in #1d4ed8 over a translucent dark backdrop at z-index 1000000.
// Configuration is applied on mount — remount the provider to change it.
```

### Replacing the Caption with a Custom Renderer

`textComponent` is a render prop that receives the current text and the resolved text color; return any element you like.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function ImportButton() {
    const { showLoader, setText } = useGlobalLoader();

    const startImport = async () => {
        setText("Importing contacts…");
        showLoader(true);
        try {
            await fetch("/api/contacts/import", { method: "POST" });
        } finally {
            showLoader(false);
        }
    };

    return <button onClick={() => { void startImport(); }}>Import contacts</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider
            config={{
                textComponent: ({ text, textColor }) => (
                    <strong style={{ color: textColor, fontSize: 16, letterSpacing: "0.02em" }}>
                        {text}
                    </strong>
                ),
            }}
        >
            <ImportButton />
        </GlobalLoaderProvider>
    );
}

// Result: the caption under the spinner renders through textComponent as a bold label
// that inherits the resolved textColor.
```

### Tracking a Multi-Stage Operation

Advance the caption stage by stage, clear it with `setText(null)` while the spinner keeps running, and use `visible` to disable triggers while the overlay is up.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";
import { useState } from "react";

function PublishButton() {
    const { showLoader, setText, visible } = useGlobalLoader();
    const [published, setPublished] = useState(false);

    const publish = async () => {
        showLoader(true);
        try {
            setText("Uploading assets…");
            await fetch("/api/releases/upload", { method: "POST" });

            setText("Building site…");
            await fetch("/api/releases/build", { method: "POST" });

            setText(null); // spinner only for the final stage
            await fetch("/api/releases/deploy", { method: "POST" });

            setPublished(true);
        } finally {
            showLoader(false);
        }
    };

    return (
        <button onClick={() => { void publish(); }} disabled={visible || published}>
            {published ? "Published" : "Publish site"}
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <PublishButton />
        </GlobalLoaderProvider>
    );
}

// Result: the caption advances "Uploading assets…" → "Building site…" → no caption;
// the trigger stays disabled while the overlay is visible or the site is published.
```

---

## I18n Examples

`I18nProvider` is mounted inside `GlobalLoaderProvider` in every example, because locale switches and reloads drive the global overlay. The loader function is where your application decides where translations come from.

### Loading Translations and Gating on ready

Provide a loader that fetches the catalog for a locale, and gate rendering on `ready` so `t()` only runs after the catalog has loaded.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function Welcome() {
    const { t, ready } = useTranslations();

    if (!ready) {
        return <p aria-busy="true">Loading translations…</p>;
    }

    return <h1>{t("welcome.title")}</h1>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <Welcome />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}

// Result: while the catalog loads the component reads "Loading translations…";
// once ready is true it renders the catalog value for "welcome.title".
```

### Interpolating Parameters

Pass a parameters object as the second argument of `t()`; its values are interpolated into the matching catalog entry.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function ProfileCard({ name, company }: { name: string; company: string }) {
    const { t, ready } = useTranslations();

    if (!ready) {
        return <p aria-busy="true">Loading translations…</p>;
    }

    return (
        <section>
            <h2>{t("profile.greeting", { name })}</h2>
            <p>{t("profile.company", { name, company })}</p>
        </section>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <ProfileCard name="Ada" company="Analytical Engines Ltd" />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}

// Result: the t() calls resolve their catalog entries with the supplied name and
// company parameters interpolated into the placeholders.
```

### Pluralizing with count

A `count` parameter selects the plural form of a catalog entry, so one key covers zero, one, and many.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function UnreadBadges() {
    const { t, ready } = useTranslations();

    if (!ready) {
        return <p aria-busy="true">Loading translations…</p>;
    }

    return (
        <ul>
            <li>{t("inbox.unread", { count: 0 })}</li>
            <li>{t("inbox.unread", { count: 1 })}</li>
            <li>{t("inbox.unread", { count: 5 })}</li>
        </ul>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <UnreadBadges />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}

// Result: the count parameter picks the plural form — 1 resolves the singular entry
// for "inbox.unread" while 0 and 5 resolve the plural entry.
```

### Switching Locales at Runtime

`setLocale()` re-fetches through the loader — showing the global overlay while it works — and the UI re-renders with the new catalog.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function LanguagePicker() {
    const { t, locale, ready, setLocale } = useTranslations();

    if (!ready) {
        return <p aria-busy="true">Loading translations…</p>;
    }

    return (
        <div>
            <p>{t("settings.language")}: {locale}</p>
            <button onClick={() => setLocale("en")} disabled={locale === "en"}>
                English
            </button>
            <button onClick={() => setLocale("nl")} disabled={locale === "nl"}>
                Nederlands
            </button>
        </div>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <LanguagePicker />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}

// Result: selecting a language re-fetches through the loader — the global overlay
// covers the switch — and the component re-renders in the selected locale.
```

### Reporting Missing Translations

`onMissingTranslation` fires for every key that cannot be resolved — route it to logging or metrics to catch catalog gaps.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function reportMissing(key: string, locale: string): void {
    console.warn(`[i18n] missing "${key}" for locale "${locale}"`);
}

function CheckoutButton() {
    const { t, ready } = useTranslations();

    if (!ready) {
        return <button disabled>Loading…</button>;
    }

    return <button>{t("checkout.placeOrder")}</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider
                loader={loadTranslations}
                defaultLocale="en"
                onMissingTranslation={reportMissing}
            >
                <CheckoutButton />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}

// Result: whenever a key cannot be resolved, reportMissing fires with the key and
// locale — the console logs: [i18n] missing "checkout.placeOrder" for locale "en"
```

### Reloading Translations on Demand

`reloadTranslations()` re-runs the loader for the active locale, e.g. so content editors see changes without a full page reload.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function TranslationsToolbar() {
    const { reloadTranslations } = useTranslations();

    return <button onClick={reloadTranslations}>Refresh translations from the server</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <TranslationsToolbar />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}

// Result: clicking the button runs the loader again for the active locale; when the
// fresh catalog arrives, every t() call re-renders with the new values.
```

---

## Auth Examples

These examples assume a BFF that implements the configured endpoints — `GET {basePath}/me`, `POST {basePath}/refresh`, and the login, callback, and logout routes — and that `react-router` is installed wherever guard or redirect components are used.

### Reading Session State

The core `useAuth()` flow: a loading phase while the session check runs, a sign-in redirect for anonymous visitors, and the session user plus sign-out for authenticated ones.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionBar() {
    const { user, isAuthenticated, isLoading, login, logout } = useAuth();

    if (isLoading) {
        return <p>Checking your session…</p>;
    }

    if (!isAuthenticated) {
        return <button onClick={() => login(window.location.pathname)}>Sign in</button>;
    }

    return (
        <div>
            <span>Signed in as {user?.sub}</span>
            <button onClick={() => { void logout(); }}>Sign out</button>
        </div>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionBar />
        </AuthProvider>
    );
}

// Result: "Checking your session…" during the initial GET /api/auth/me; anonymous
// visitors get a Sign in button that returns them to the current path after the OIDC
// round-trip; signed-in visitors see their sub and a Sign out button.
```

### Protecting Routes with AuthGuard

`AuthGuard` renders protected content for authenticated sessions and redirects everyone else to the configured `loginPath`; the redirect uses `react-router`.

```tsx
import { AuthGuard, AuthProvider } from "blendsdk/react";
import { BrowserRouter, Route, Routes } from "react-router";

function Dashboard() {
    return <h1>Dashboard</h1>;
}

function SignInPage() {
    return <h1>Sign in to continue</h1>;
}

export function App() {
    return (
        <BrowserRouter>
            <AuthProvider config={{ basePath: "/api/auth", loginPath: "/sign-in" }}>
                <Routes>
                    <Route path="/sign-in" element={<SignInPage />} />
                    <Route
                        path="/"
                        element={
                            <AuthGuard>
                                <Dashboard />
                            </AuthGuard>
                        }
                    />
                </Routes>
            </AuthProvider>
        </BrowserRouter>
    );
}

// Result: visiting "/" without a session redirects to "/sign-in" — the configured
// loginPath; with a session, AuthGuard renders the Dashboard.
```

### Tracking Expiry and Refreshing

Read `expiresAt`, rely on automatic renewal before expiry, and trigger the same refresh manually with the boolean result.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";
import { useState } from "react";

function formatExpiry(expiresAt: number | null): string {
    if (expiresAt === null) {
        return "unknown";
    }
    return new Date(expiresAt * 1000).toLocaleTimeString();
}

function SessionStatus() {
    const { isAuthenticated, isLoading, expiresAt, refresh } = useAuth();
    const [refreshing, setRefreshing] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const refreshNow = async () => {
        setRefreshing(true);
        setMessage(null);
        try {
            const refreshed = await refresh();
            setMessage(refreshed ? "Session refreshed." : "Refresh failed — sign in again.");
        } finally {
            setRefreshing(false);
        }
    };

    if (isLoading) {
        return <p>Checking your session…</p>;
    }

    if (!isAuthenticated) {
        return <p>No active session.</p>;
    }

    return (
        <div>
            <p>Session expires at {formatExpiry(expiresAt)}</p>
            <button onClick={() => { void refreshNow(); }} disabled={refreshing}>
                Refresh session
            </button>
            {message !== null && <p role="status">{message}</p>}
        </div>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth", autoRefresh: true, refreshLeadTime: 120 }}>
            <SessionStatus />
        </AuthProvider>
    );
}

// Result: the provider renews the session 120 seconds before it expires; the button
// triggers the same POST /api/auth/refresh manually and reports the boolean result.
```

### Sending the CSRF Token on State-Changing Requests

The session check exposes a per-session CSRF token; send it in the header named by `config.csrfHeader` on every mutating BFF call.

```tsx
import { AuthProvider, useAuth, type ResolvedAuthConfig } from "blendsdk/react";

function buildHeaders(
    config: ResolvedAuthConfig,
    csrfToken: string | null,
): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (csrfToken !== null) {
        headers[config.csrfHeader] = csrfToken;
    }
    return headers;
}

function CreateNoteButton() {
    const { csrfToken, config } = useAuth();

    const createNote = async () => {
        const response = await fetch("/api/notes", {
            method: "POST",
            headers: buildHeaders(config, csrfToken),
            body: JSON.stringify({ text: "Remember the milk" }),
        });

        if (!response.ok) {
            console.error(`Creating the note failed with HTTP ${response.status}`);
        }
    };

    return <button onClick={() => { void createNote(); }}>Create note</button>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <CreateNoteButton />
        </AuthProvider>
    );
}

// Result: when GET /api/auth/me delivered a CSRF token, the POST carries it in the
// "x-csrf-token" header; a 403 can mean another tab rotated the token — the next
// session check delivers the current one.
```

### Authenticated Is Not Authorized

A session can be authenticated and still not authorized by the application — render those two states differently so users get an accurate explanation.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function AccessBanner() {
    const { user, isAuthenticated, authorized, isLoading } = useAuth();

    if (isLoading) {
        return <p>Checking your session…</p>;
    }

    if (!isAuthenticated) {
        return <p>Please sign in to continue.</p>;
    }

    if (!authorized) {
        return (
            <p role="alert">
                Signed in as {user?.sub}, but this application has not authorized the session.
            </p>
        );
    }

    return <p>Welcome back, {user?.sub}.</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AccessBanner />
        </AuthProvider>
    );
}

// Result: three distinct states — no session, a session the server denied
// (authorized === false while isAuthenticated stays true), and a fully authorized
// session.
```

### Overriding Endpoints on Top of AUTH_DEFAULTS

Start from the published defaults, override only what the BFF changes, and read the fully resolved configuration back from the context.

```tsx
import { AUTH_DEFAULTS, AuthProvider, useAuth, type AuthConfig } from "blendsdk/react";

/**
 * The provider merges any omitted value with AUTH_DEFAULTS on mount — spreading the
 * constant here documents the built-in endpoint names explicitly and overrides only
 * what this BFF actually changes.
 */
const authConfig: AuthConfig = {
    basePath: "/services/session",
    endpoints: {
        ...AUTH_DEFAULTS.endpoints,
        me: "/whoami",
        refresh: "/renew",
    },
    loginPath: "/sign-in",
    defaultReturnTo: "/dashboard",
    refreshLeadTime: 120,
};

function SessionEndpoint() {
    const { config } = useAuth();
    return (
        <code>
            {config.basePath}
            {config.endpoints.me}
        </code>
    );
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <SessionEndpoint />
        </AuthProvider>
    );
}

// Result: the probe renders "/services/session/whoami"; session checks call
// GET /services/session/whoami and renewals POST /services/session/renew. The
// overrides resolve loginPath to "/sign-in", defaultReturnTo to "/dashboard", and
// refreshLeadTime to 120 seconds; every other value comes from AUTH_DEFAULTS.
```

---

## Authorization Examples

Authorization turns the session user's `roles` and `permissions` into UI decisions. Remember: these checks shape the interface only — the server remains the authority.

### Reading Roles and Permissions

`useAuthorization()` exposes the session's canonical grants plus the `hasRole` and `can` predicates, memoized on the current user.

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";

function AccessPanel() {
    const { roles, permissions, hasRole, can } = useAuthorization();

    return (
        <dl>
            <dt>Roles</dt>
            <dd>{roles.length > 0 ? roles.join(", ") : "(none)"}</dd>
            <dt>Permissions</dt>
            <dd>{permissions.length > 0 ? permissions.join(", ") : "(none)"}</dd>
            <dt>Finance member</dt>
            <dd>{hasRole("finance") ? "yes" : "no"}</dd>
            <dt>Can write invoices</dt>
            <dd>{can("invoice:write") ? "yes" : "no"}</dd>
        </dl>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AccessPanel />
        </AuthProvider>
    );
}

// Result: a session whose user carries roles ["finance"] and permissions
// ["invoice:write"] lists both and answers "yes" to both checks; anonymous or
// malformed grant data fails closed to "(none)" and "no".
```

### Gating an Action with Can

`Can` renders its children only when the session holds the required `role` or `permission`. It is presentation only — the server remains the authority.

```tsx
import { AuthProvider, Can } from "blendsdk/react";

function InvoiceRow() {
    return (
        <div>
            <span>Invoice #1042</span>
            <Can permission="invoice:write">
                <button>Edit</button>
            </Can>
            <Can role="finance">
                <button>Approve</button>
            </Can>
        </div>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <InvoiceRow />
        </AuthProvider>
    );
}

// Result: Edit renders only for sessions holding "invoice:write"; Approve only for
// sessions holding the "finance" role.
```

### Requiring a Grant for a Route with RequireAccess

Authentication first with `AuthGuard`, then the grant check with `RequireAccess`, which redirects signed-in users who lack the grant to `notAuthorizedPath`.

```tsx
import { AuthGuard, AuthProvider, RequireAccess } from "blendsdk/react";
import { BrowserRouter, Route, Routes } from "react-router";

function FinanceReports() {
    return <h1>Finance reports</h1>;
}

function LoginPage() {
    return <h1>Sign in to continue</h1>;
}

function NotAuthorizedPage() {
    return <h1>You do not have access to this area.</h1>;
}

export function App() {
    return (
        <BrowserRouter>
            <AuthProvider config={{ basePath: "/api/auth" }}>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/not-authorized" element={<NotAuthorizedPage />} />
                    <Route
                        path="/finance"
                        element={
                            <AuthGuard>
                                <RequireAccess role="finance">
                                    <FinanceReports />
                                </RequireAccess>
                            </AuthGuard>
                        }
                    />
                </Routes>
            </AuthProvider>
        </BrowserRouter>
    );
}

// Result: anonymous visitors are redirected to "/login"; signed-in users without the
// "finance" role are redirected to "/not-authorized" (config.notAuthorizedPath).
```

### Building Grant-Aware Navigation

Hide menu entries the current session cannot use; anonymous visitors fall back to the public entries because every check fails closed.

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";

function Navigation() {
    const { hasRole, can } = useAuthorization();

    return (
        <nav>
            <a href="/">Home</a>
            {can("invoice:read") && <a href="/invoices">Invoices</a>}
            {hasRole("finance") && <a href="/finance">Finance reports</a>}
            {can("settings:admin") && <a href="/settings">Settings</a>}
        </nav>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <Navigation />
        </AuthProvider>
    );
}

// Result: each protected entry appears only while its grant is held; anonymous
// visitors fall back to "Home" alone.
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
