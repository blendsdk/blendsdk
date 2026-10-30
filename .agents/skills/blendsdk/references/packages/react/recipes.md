> **Package**: `blendsdk/react`

# react Advanced Patterns

This document collects patterns that combine more than one capability of `blendsdk/react`: the provider tree, the asynchronous BFF session, CSRF-aware requests, grant-driven UI, global-loader ownership, object-shaped form state, and expiry handling. Every example is self-contained — it imports only from `blendsdk/react` and React — so it can be pasted into an application module and compiled without additional context. Patterns cross-reference each other where composition helps, but each one stands alone.

| # | Pattern | Combines |
|---|---|---|
| 1 | Compose the provider tree once | Global loader, I18n, auth |
| 2 | Gate content on an asynchronous session | Auth state, `AuthGuard`, `RequireAccess` |
| 3 | Write CSRF-aware BFF requests | Auth session, `fetch` |
| 4 | Drive UI from grants | `useAuthorization`, `Can` |
| 5 | Scope loader ownership | Global loader |
| 6 | Save object-shaped forms through the BFF | Object state, auth, I18n, loader |
| 7 | Renew an expiring session | Auth state, I18n |

---

## 1. Compose the Provider Tree Once

**When to use it.** Always. Every BlendSDK React application mounts `GlobalLoaderProvider`, `I18nProvider`, and `AuthProvider` exactly once, at the root of the tree. Put that composition in a dedicated module so the required order is fixed, configuration is typed in one place, and feature code only ever imports hooks.

```tsx
import {
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    useAuth,
    useTranslations,
    type AuthConfig,
    type TranslationLoader,
} from "blendsdk/react";

const authConfig: AuthConfig = {
    basePath: "/api/auth",
    loginPath: "/login",
    notAuthorizedPath: "/not-authorized",
    defaultReturnTo: "/dashboard",
    autoRefresh: true,
    refreshLeadTime: 120,
};

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

function Dashboard() {
    const { t, locale, setLocale, ready } = useTranslations();
    const { user, isAuthenticated, isLoading, login } = useAuth();

    if (!ready) {
        // Translations are not loaded yet: render boot text without t().
        return <p role="status">Preparing application…</p>;
    }

    if (isLoading) {
        return <p role="status">{t("session.checking")}</p>;
    }

    if (!isAuthenticated || user === null) {
        return (
            <button type="button" onClick={() => login()}>
                {t("auth.signIn")}
            </button>
        );
    }

    return (
        <section lang={locale}>
            <h1>{t("dashboard.title")}</h1>
            <p>{t("dashboard.welcome", { name: user.sub })}</p>
            <button
                type="button"
                onClick={() => setLocale(locale === "en" ? "nl" : "en")}
            >
                {t("language.switch")}
            </button>
        </section>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider config={{ spinnerColor: "#25b09b", spinnerSize: 56 }}>
            <I18nProvider
                loader={loadTranslations}
                defaultLocale="en"
                onMissingTranslation={(key, missingLocale) => {
                    console.warn(`[i18n] missing "${key}" for "${missingLocale}"`);
                }}
            >
                <AuthProvider config={authConfig}>
                    <Dashboard />
                </AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Why it matters.** The three providers have a real dependency order. `I18nProvider` reports translation fetches through the global loader, so it must sit inside `GlobalLoaderProvider`. The auth subtree sits inside `I18nProvider` so sign-in buttons, denied pages, and session banners can be translated. Encoding that order in one component makes the constraint impossible to violate accidentally, keeps `AuthConfig` type-checked in one place, and lets every feature module depend on hooks only — which is also what makes those modules testable without wiring the whole application.

**Caveats and performance.**

- `GlobalLoaderProvider` captures its `config` on mount and is not reactive. To change spinner colors or size, remount the provider — do not pass a new object and expect a change.
- Keep `authConfig` as a module-level constant rather than an inline object literal. Endpoint resolution, refresh scheduling, and session hydration happen on mount; a stable configuration reference documents that intent and avoids accidental provider remounts when the tree re-renders.
- Do not call `t()` before `ready` is `true`. The catalog is empty until the loader resolves; render provider-independent boot text instead of translation keys.
- Never mount these providers per route. Remounting `AuthProvider` re-runs the `/me` session check and resets auth state.
- Every context update re-renders every consumer of that context. Keeping the provider at the root is correct, but keep heavy, non-auth subtrees out of components that only consume `useAuth()` for a single boolean.

---

## 2. Gate Content on an Asynchronous Session

**When to use it.** Every authenticated area of the application — dashboards, settings, admin screens. The session check is asynchronous (`isLoading` covers the initial `/me` call), and the answer is two-dimensional: the user may be signed in but not authorized by the server.

Before, each page repeats the rule and gets it subtly wrong:

```tsx fragment
function InvoicesPage() {
    const { isAuthenticated, login } = useAuth();

    if (!isAuthenticated) {
        login();      // side effect during render
        return null;  // also renders while isLoading is still true
    }

    return <main>Invoices</main>;
}
```

After, the bootstrap gate renders the loading state once, `AuthGuard` owns the redirect, and `RequireAccess` owns the grant check:

```tsx
import type { ReactNode } from "react";
import {
    AuthGuard,
    AuthProvider,
    Can,
    RequireAccess,
    useAuth,
    type AuthConfig,
} from "blendsdk/react";

const authConfig: AuthConfig = {
    basePath: "/api/auth",
    loginPath: "/login",
    notAuthorizedPath: "/not-authorized",
    defaultReturnTo: "/invoices",
};

function SessionBootstrap({ children }: { children: ReactNode }) {
    const { isLoading } = useAuth();

    if (isLoading) {
        return <p role="status">Checking your session…</p>;
    }

    return <>{children}</>;
}

function InvoicesPage() {
    const { user, authorized } = useAuth();

    return (
        <main>
            <h1>Invoices</h1>
            <p>
                Signed in as {user?.sub ?? "unknown"} —{" "}
                {authorized ? "authorized by the server" : "not authorized by the server"}
            </p>

            <Can permission="invoice:write">
                <button type="button">New invoice</button>
            </Can>

            <Can permission="invoice:export">
                <button type="button">Export</button>
            </Can>
        </main>
    );
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <SessionBootstrap>
                <AuthGuard>
                    <RequireAccess permission="invoices:read">
                        <InvoicesPage />
                    </RequireAccess>
                </AuthGuard>
            </SessionBootstrap>
        </AuthProvider>
    );
}
```

**Why it matters.** The three failure modes of hand-rolled gates disappear at once: no side effect during render, no flash of unauthenticated content while `isLoading` is `true`, and no page-level duplication of the redirect policy. The redirect destinations come from the resolved configuration (`loginPath`, `notAuthorizedPath`, `defaultReturnTo`), so changing where the app sends anonymous users is a one-line configuration change instead of a search across pages. `Can` then handles the in-page, non-redirecting case without repeating hooks.

**Caveats and performance.**

- `AuthGuard` and `RequireAccess` navigate, so they require the optional `react-router` peer. `Can` and `useAuth()` do not.
- The bootstrap gate is a user-experience concern, not a security control. The BFF must reject unauthorized requests regardless of what the client renders.
- `isAuthenticated` and `authorized` are different questions. A session can be signed in and denied by the server. Surface that state explicitly rather than treating it as “logged out”:

```tsx fragment
function SessionDeniedNotice() {
    const { isAuthenticated, authorized } = useAuth();

    if (!isAuthenticated || authorized) {
        return null;
    }

    return <p role="alert">Signed in, but the server has not authorized this session.</p>;
}
```

- Keep `SessionBootstrap` above the guards, not inside each page: it renders once per navigation instead of once per route component instance.
- `Can` is presentation only. Hiding a button never protects an endpoint; the server enforces the same grant.

---

## 3. Write CSRF-Aware BFF Requests

**When to use it.** Any state-changing call to the BFF (`POST`, `PUT`, `PATCH`, `DELETE`). Those requests must carry the per-session CSRF token in the header named by `config.csrfHeader`, and the token is only available through `useAuth()`. Wrapping that in one hook removes the per-call header bookkeeping and gives every failure a single shape.

```tsx
import { useCallback, useEffect, useState } from "react";
import { AuthProvider, useAuth, type AuthConfig } from "blendsdk/react";

const authConfig: AuthConfig = { basePath: "/api/auth" };

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface BffRequestOptions {
    method?: HttpMethod;
    body?: unknown;
    signal?: AbortSignal;
}

class BffError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "BffError";
        this.status = status;
    }
}

function useBffRequest() {
    const { csrfToken, config } = useAuth();

    return useCallback(
        async <TResponse,>(
            path: string,
            options: BffRequestOptions = {},
        ): Promise<TResponse | null> => {
            const method = options.method ?? "GET";
            const headers: Record<string, string> = { accept: "application/json" };

            if (options.body !== undefined) {
                headers["content-type"] = "application/json";
            }

            if (method !== "GET" && csrfToken !== null) {
                headers[config.csrfHeader] = csrfToken;
            }

            const response = await fetch(path, {
                method,
                headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                credentials: "same-origin",
                signal: options.signal,
            });

            if (!response.ok) {
                throw new BffError(
                    `${method} ${path} failed with ${response.status}`,
                    response.status,
                );
            }

            if (response.status === 204) {
                return null;
            }

            const payload: TResponse = await response.json();
            return payload;
        },
        [csrfToken, config.csrfHeader],
    );
}

interface InvoiceSummary {
    id: string;
    total: number;
}

function InvoiceList() {
    const request = useBffRequest();
    const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();

        const load = async (): Promise<void> => {
            try {
                const data = await request<InvoiceSummary[]>("/api/bff/invoices", {
                    signal: controller.signal,
                });
                setInvoices(data ?? []);
            } catch (caught) {
                if (controller.signal.aborted) {
                    return;
                }
                setError(caught instanceof BffError ? caught.message : "Could not load invoices");
            }
        };

        void load();
        return () => controller.abort();
    }, [request]);

    const remove = async (id: string): Promise<void> => {
        setError(null);
        try {
            await request<null>(`/api/bff/invoices/${id}`, { method: "DELETE" });
            setInvoices((previous) => previous.filter((invoice) => invoice.id !== id));
        } catch (caught) {
            setError(caught instanceof BffError ? caught.message : "Could not delete invoice");
        }
    };

    return (
        <section>
            {error !== null && <p role="alert">{error}</p>}
            <ul>
                {invoices.map((invoice) => (
                    <li key={invoice.id}>
                        {invoice.id} — {invoice.total.toFixed(2)}
                        <button type="button" onClick={() => void remove(invoice.id)}>
                            Delete
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <InvoiceList />
        </AuthProvider>
    );
}
```

**Why it matters.** The CSRF header is easy to forget on exactly the calls that need it, and the consequences are intermittent `403` responses that are hard to reproduce. Centralizing the header name, the token lookup, JSON encoding, abort support, and the error shape means every mutation behaves the same way and every caller can discriminate on `status`. Typed payloads (`request<InvoiceSummary[]>`) keep response handling honest without scattering casts through components. `204 No Content` is modelled explicitly as `null`, so callers do not have to guess.

**Caveats and performance.**

- The returned function is recreated when `csrfToken` changes — after the initial `/me` resolves and after every refresh. Effects that list `request` in their dependency array re-run; in the example that refetches the list, which is usually the behaviour you want after a session renewal. If you need a stable identity, hold the token in a ref updated in an effect, at the cost of occasionally sending the previous token.
- `csrfToken` is a snapshot. When session-id rotation is enabled, a token replaced by another browsing context is not observed until the next session check, so a request made with an outdated token can be rejected with `403`. Treat `BffError.status === 403` as retryable after a `refresh()` and a re-render — never retry blindly in a loop.
- `credentials: "same-origin"` assumes the SPA and the BFF share an origin, which is the point of the BFF pattern. A cross-origin split requires CORS credentials handling and changes the CSRF story; do not adopt it casually.
- `BffError` does not parse structured error bodies. If your BFF returns problem details, extend the class with a parsed payload rather than parsing ad hoc at call sites.
- Combine this with the loader scope from [pattern 5](#5-scope-loader-ownership) rather than toggling `showLoader` inside individual call sites.

---

## 4. Drive UI from Grants

**When to use it.** Toolbars, navigation, and action lists whose entries depend on roles or permissions. The naive version scatters string comparisons through JSX and re-evaluates them in inconsistent ways:

```tsx fragment
const { permissions } = useAuthorization();
const canEdit = permissions.includes("invoice:write");
const canDelete = permissions.includes("invoice:delete") || permissions.includes("invoice:admin");
```

The table-driven version keeps each permission next to its label and filters once:

```tsx
import { useMemo, useState } from "react";
import {
    AuthProvider,
    Can,
    useAuthorization,
    type AuthConfig,
} from "blendsdk/react";

const authConfig: AuthConfig = { basePath: "/api/auth" };

interface ToolbarAction {
    id: string;
    label: string;
    permission: string;
}

interface InvoiceToolbarProps {
    invoiceId: string;
    onAction: (actionId: string) => void;
}

function InvoiceToolbar({ invoiceId, onAction }: InvoiceToolbarProps) {
    const { can, hasRole, roles, permissions } = useAuthorization();

    const actions = useMemo<readonly ToolbarAction[]>(() => {
        const candidates: ToolbarAction[] = [
            { id: "edit", label: "Edit", permission: "invoice:write" },
            { id: "approve", label: "Approve", permission: "invoice:approve" },
            { id: "delete", label: "Delete", permission: "invoice:delete" },
        ];
        return candidates.filter((action) => can(action.permission));
    }, [can]);

    return (
        <section>
            <h2>Invoice {invoiceId}</h2>
            <p>
                Roles: {roles.length > 0 ? roles.join(", ") : "none"} · Permissions held:{" "}
                {permissions.length}
            </p>

            {hasRole("finance") && <p>Finance view available</p>}

            {actions.length === 0 ? (
                <p>No actions are available for this invoice.</p>
            ) : (
                <div>
                    {actions.map((action) => (
                        <button
                            key={action.id}
                            type="button"
                            onClick={() => onAction(action.id)}
                        >
                            {action.label}
                        </button>
                    ))}
                </div>
            )}

            <Can permission="invoice:share">
                <button type="button" onClick={() => onAction("share")}>
                    Share
                </button>
            </Can>
        </section>
    );
}

function InvoicePage({ invoiceId }: { invoiceId: string }) {
    const [selected, setSelected] = useState<string | null>(null);

    return (
        <>
            <InvoiceToolbar
                invoiceId={invoiceId}
                onAction={(actionId) => setSelected(actionId)}
            />
            {selected !== null && <p role="status">Selected action: {selected}</p>}
        </>
    );
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <InvoicePage invoiceId="INV-1042" />
        </AuthProvider>
    );
}
```

**Why it matters.** `useAuthorization()` derives the principal from the session user once per user object and memoizes the result, so `can` and `hasRole` keep a stable identity between renders — which is exactly what makes the `useMemo` above correct. Building the action list from data means a single filter decides visibility, an empty result degrades to an explanatory message instead of a broken toolbar, and role-based accents (`hasRole("finance")`) and one-off elements (`Can`) compose in the same component. Because the hook delegates to `hasRole()` and `hasPermission()` from `blendsdk/authz`, client checks use the same grant vocabulary the server issued.

**Caveats and performance.**

- This is presentation only. The server is the authority; every action must also be enforced on the BFF endpoint.
- Grants come from `user.roles` and `user.permissions` as untrusted runtime data. Non-array values, non-string entries, and duplicates are resolved fail-closed by the hook — but you should still not assume a claim exists.
- `can` changes identity when the user object changes (a refresh that returns a new `/me` payload). Everything memoized on it recomputes, which is the desired behaviour.
- Centralize permission strings so a typo is a compile error rather than a permanently hidden button:

```tsx fragment
export const INVOICE_PERMISSIONS = {
    write: "invoice:write",
    approve: "invoice:approve",
    delete: "invoice:delete",
    share: "invoice:share",
} as const;
```

- Avoid calling `can()` inside a `.map()` over hundreds of rows on every render; filter once in a memo and render the result.

---

## 5. Scope Loader Ownership

**When to use it.** When two or more operations in the same screen can be in flight at once. The global loader is a single boolean, not a reference-counted stack: an operation that calls `showLoader(false)` hides the overlay for every other operation. Build a scope that counts active tasks and only clears the overlay when the last one finishes.

```tsx
import {
    createContext,
    useCallback,
    useContext,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

type LoaderTaskRunner = <T>(task: () => Promise<T>, text: string) => Promise<T>;

const LoaderScopeContext = createContext<LoaderTaskRunner | null>(null);

export function LoaderScope({ children }: { children: ReactNode }) {
    const { showLoader, setText } = useGlobalLoader();
    const activeTasks = useRef(0);

    const run = useCallback(
        async <T,>(task: () => Promise<T>, text: string): Promise<T> => {
            activeTasks.current += 1;
            if (activeTasks.current === 1) {
                setText(text);
                showLoader(true);
            }

            try {
                return await task();
            } finally {
                activeTasks.current -= 1;
                if (activeTasks.current === 0) {
                    showLoader(false);
                }
            }
        },
        [showLoader, setText],
    );

    return (
        <LoaderScopeContext.Provider value={run}>
            {children}
        </LoaderScopeContext.Provider>
    );
}

export function useLoaderTask(): LoaderTaskRunner {
    const run = useContext(LoaderScopeContext);
    if (run === null) {
        throw new Error("useLoaderTask() must be used within a <LoaderScope>.");
    }
    return run;
}

interface SyncResult {
    updated: number;
}

interface ExportResult {
    url: string;
}

function DataMaintenancePanel() {
    const runTask = useLoaderTask();
    const [status, setStatus] = useState("Idle");

    const sync = async (): Promise<void> => {
        try {
            const result = await runTask(async () => {
                const response = await fetch("/api/maintenance/sync", { method: "POST" });
                if (!response.ok) {
                    throw new Error(`Sync failed with ${response.status}`);
                }
                const payload: SyncResult = await response.json();
                return payload;
            }, "Synchronizing records…");
            setStatus(`Updated ${result.updated} records`);
        } catch (caught) {
            setStatus(caught instanceof Error ? caught.message : "Sync failed");
        }
    };

    const createExport = async (): Promise<void> => {
        try {
            const result = await runTask(async () => {
                const response = await fetch("/api/maintenance/export", { method: "POST" });
                if (!response.ok) {
                    throw new Error(`Export failed with ${response.status}`);
                }
                const payload: ExportResult = await response.json();
                return payload;
            }, "Preparing export…");
            setStatus(`Export ready: ${result.url}`);
        } catch (caught) {
            setStatus(caught instanceof Error ? caught.message : "Export failed");
        }
    };

    return (
        <section>
            <button type="button" onClick={() => void sync()}>
                Synchronize
            </button>
            <button type="button" onClick={() => void createExport()}>
                Export
            </button>
            <p role="status">{status}</p>
        </section>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <LoaderScope>
                <DataMaintenancePanel />
            </LoaderScope>
        </GlobalLoaderProvider>
    );
}
```

**Why it matters.** Loader bugs are race bugs: the overlay vanishes mid-request because a faster operation finished second. Counting active tasks inside one provider makes visibility a function of outstanding work rather than of call order, and `finally` guarantees the count is released on both success and failure. Mounting the counter in a provider — rather than a module-level variable or a per-component ref — means every consumer in the subtree shares the same count, while the scope still composes on top of the public `useGlobalLoader()` contract instead of reaching into the provider internals.

**Caveats and performance.**

- The counter only knows about tasks routed through `run`. A raw `showLoader(false)` elsewhere in the tree still hides the overlay. Adopt the scope as the single way to drive the loader and treat direct calls as exceptional.
- The first task's text wins; the second concurrent task does not replace it. If you need changing messages, call `setText` inside `run` on every task and accept that the last writer wins.
- `showLoader(false)` already clears the text, so the scope does not need a separate `setText(null)`.
- Do not start a task that outlives the provider and then expect the `finally` call to be meaningful; if `GlobalLoaderProvider` unmounts, there is no overlay left to hide. Abort in-flight work on unmount instead.
- If a screen genuinely has one owner of the loading state — a single submit button, a single route transition — skip the scope. It is overhead when the simple boolean is already unambiguous.

---

## 6. Save Object-Shaped Form State Through the BFF

**When to use it.** A form with several related fields that must be validated, submitted with the CSRF token, and reset. Per-field `useState` makes the draft, validation, and reset drift apart:

```tsx fragment
const [customer, setCustomer] = useState("");
const [amount, setAmount] = useState("");
const [note, setNote] = useState("");
// three setters, three resets, three dependency entries
```

One object, one setter, one reset, one place to build the request body:

```tsx
import { useState, type FormEvent } from "react";
import {
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    useAuth,
    useGlobalLoader,
    useObjectState,
    useTranslations,
    type AuthConfig,
    type TranslationLoader,
} from "blendsdk/react";

const authConfig: AuthConfig = { basePath: "/api/auth" };

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

interface InvoiceDraft {
    customer: string;
    amount: string;
    note: string;
}

function InvoiceForm() {
    const { t } = useTranslations();
    const { csrfToken, config } = useAuth();
    const { showLoader, setText } = useGlobalLoader();
    const [draft, setDraft, resetDraft] = useObjectState<InvoiceDraft>(() => ({
        customer: "",
        amount: "",
        note: "",
    }));
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setError(null);
        setSaved(false);

        if (draft.customer.trim() === "") {
            setError(t("invoice.form.customerRequired"));
            return;
        }

        const amount = Number.parseFloat(draft.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            setError(t("invoice.form.amountInvalid"));
            return;
        }

        const headers: Record<string, string> = { "content-type": "application/json" };
        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        setText(t("invoice.form.saving"));
        showLoader(true);

        try {
            const response = await fetch("/api/bff/invoices", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    customer: draft.customer.trim(),
                    amount,
                    note: draft.note,
                }),
            });

            if (!response.ok) {
                throw new Error(t("invoice.form.saveFailed", { status: response.status }));
            }

            resetDraft();
            setSaved(true);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : t("invoice.form.unexpectedError"),
            );
        } finally {
            showLoader(false);
        }
    };

    return (
        <form onSubmit={(event) => void save(event)}>
            <label>
                {t("invoice.form.customer")}
                <input
                    value={draft.customer}
                    onChange={(event) => setDraft({ customer: event.target.value })}
                />
            </label>

            <label>
                {t("invoice.form.amount")}
                <input
                    inputMode="decimal"
                    value={draft.amount}
                    onChange={(event) => setDraft({ amount: event.target.value })}
                />
            </label>

            <label>
                {t("invoice.form.note")}
                <textarea
                    value={draft.note}
                    onChange={(event) => setDraft({ note: event.target.value })}
                />
            </label>

            {error !== null && <p role="alert">{error}</p>}
            {saved && <p role="status">{t("invoice.form.saved")}</p>}

            <button type="submit">{t("invoice.form.submit")}</button>
            <button type="button" onClick={resetDraft}>
                {t("common.reset")}
            </button>
        </form>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <AuthProvider config={authConfig}>
                    <InvoiceForm />
                </AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Why it matters.** The draft is a single value, so validation reads one object, the request body is built from the same object, and `resetDraft()` restores every field at once — the reset baseline is a fresh object produced by the factory, not the initial reference. The raw `amount` string is kept in state and parsed only at the boundary, which avoids rendering `NaN` into a controlled input while still sending a number to the BFF. The submit path combines all four modules in the order they exist at runtime: `t()` for field labels and errors, `csrfToken`/`config.csrfHeader` for the mutation, `showLoader`/`setText` for progress, and the object setter for the draft.

**Caveats and performance.**

- `showLoader(false)` in `finally` makes this form the single owner of the overlay during submit. If other work can run concurrently, route the submit through the loader scope from [pattern 5](#5-scope-loader-ownership) instead.
- `setDraft` shallow-merges, so nested structures are replaced wholesale. Keep `InvoiceDraft` flat, or replace the nested object explicitly.
- `reset()` re-runs the factory captured on the first render. If the initial values must come from props, they will not update after mount; key the component to remount when the source changes.
- The direct `fetch` here is deliberate to keep the example self-contained. In a real application, submit through the client from [pattern 3](#3-write-csrf-aware-bff-requests) so error handling and header logic are shared.
- Translation keys are evaluated during submit. If the screen must not render before translations are ready, gate the route on `ready` in the provider composition from [pattern 1](#1-compose-the-provider-tree-once).

---

## 7. Renew an Expiring Session

**When to use it.** Long-lived screens — editors, wizards, dashboards — where a session expiring mid-task would lose work. With `autoRefresh` enabled the provider already renews before expiry; this pattern surfaces the remaining time and gives the user an explicit recovery path when the automatic refresh fails or is disabled.

```tsx
import { useEffect, useState } from "react";
import {
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    useAuth,
    useTranslations,
    type AuthConfig,
    type TranslationLoader,
} from "blendsdk/react";

const authConfig: AuthConfig = {
    basePath: "/api/auth",
    autoRefresh: true,
    refreshLeadTime: 60,
};

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

const WARNING_THRESHOLD_SECONDS = 300;

function useSecondsUntilExpiry(): number | null {
    const { expiresAt } = useAuth();
    const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

    useEffect(() => {
        if (expiresAt === null) {
            setSecondsLeft(null);
            return;
        }

        const compute = (): void => {
            const remaining = Math.floor(expiresAt - Date.now() / 1000);
            setSecondsLeft(Math.max(0, remaining));
        };

        compute();
        const timer = window.setInterval(compute, 1000);
        return () => window.clearInterval(timer);
    }, [expiresAt]);

    return secondsLeft;
}

function SessionExpiryBanner() {
    const { t } = useTranslations();
    const { isAuthenticated, isLoading, refresh, login } = useAuth();
    const secondsLeft = useSecondsUntilExpiry();
    const [refreshFailed, setRefreshFailed] = useState(false);

    if (
        isLoading ||
        !isAuthenticated ||
        secondsLeft === null ||
        secondsLeft > WARNING_THRESHOLD_SECONDS
    ) {
        return null;
    }

    const staySignedIn = async (): Promise<void> => {
        setRefreshFailed(false);
        try {
            const refreshed = await refresh();
            if (!refreshed) {
                setRefreshFailed(true);
            }
        } catch {
            setRefreshFailed(true);
        }
    };

    const signInAgain = (): void => {
        login(window.location.pathname + window.location.search);
    };

    if (secondsLeft === 0) {
        return (
            <div role="alert">
                <p>{t("session.expired")}</p>
                <button type="button" onClick={signInAgain}>
                    {t("session.signInAgain")}
                </button>
            </div>
        );
    }

    return (
        <div role="status">
            <p>{t("session.expiresIn", { seconds: secondsLeft })}</p>
            <button type="button" onClick={() => void staySignedIn()}>
                {t("session.staySignedIn")}
            </button>
            {refreshFailed && (
                <p role="alert">
                    {t("session.refreshFailed")}{" "}
                    <button type="button" onClick={signInAgain}>
                        {t("session.signInAgain")}
                    </button>
                </p>
            )}
        </div>
    );
}

function Dashboard() {
    const { t } = useTranslations();
    const { user } = useAuth();

    return <h1>{t("dashboard.welcome", { name: user?.sub ?? "guest" })}</h1>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <AuthProvider config={authConfig}>
                    <SessionExpiryBanner />
                    <Dashboard />
                </AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Why it matters.** `expiresAt` is a Unix timestamp in seconds, so the remaining time can be recomputed from the clock instead of decremented — the display cannot drift, and a refresh that returns a new expiry automatically restarts the countdown through the effect dependency. `refresh()` resolves to a boolean rather than throwing, so failure is an ordinary branch: retry with the manual button, or fall back to `login(returnTo)` with the current path so the user returns to the same screen after the OIDC round-trip. Every string is translated, which lets the banner sit in the same i18n subtree as the rest of the shell.

**Caveats and performance.**

- Mount the banner once, near the root. Each instance runs its own one-second interval; several copies add timers without adding information.
- `autoRefresh` already performs renewal `refreshLeadTime` seconds before expiry. Treat the banner as visibility plus manual recovery, not as a replacement for automatic refresh. If you disable `autoRefresh`, this becomes the primary renewal path.
- Never call `login()` during render — it navigates. Call it from an event handler, as shown.
- `expiresAt` is `null` when the server did not report an expiry; the hook then renders nothing rather than inventing a countdown.
- A `refresh()` that succeeds updates the auth context on the next render. Components that read `csrfToken` directly keep the previous token until then, so do not pair this pattern with a synchronous retry that assumes the new token is already available.
- Overlapping refreshes are possible if the automatic schedule fires while the user also presses the button. The provider serializes its own refresh logic, but guard against double-clicks locally if the operation is expensive.

---

## Choosing a Pattern

| Problem | Pattern | Modules involved |
|---|---|---|
| Providers are mounted in different places, or in the wrong order | [1](#1-compose-the-provider-tree-once) | Loader, I18n, auth |
| Content flashes before `/me` resolves, or pages call `login()` during render | [2](#2-gate-content-on-an-asynchronous-session) | Auth, guards |
| Mutations intermittently fail with `403` | [3](#3-write-csrf-aware-bff-requests) | Auth, `fetch` |
| Permission strings are scattered through JSX | [4](#4-drive-ui-from-grants) | Authorization |
| The overlay disappears while work is still running | [5](#5-scope-loader-ownership) | Loader |
| A form has one `useState` per field and three reset paths | [6](#6-save-object-shaped-form-state-through-the-bff) | State, auth, I18n, loader |
| Users lose work when the session expires | [7](#7-renew-an-expiring-session) | Auth, I18n |

## Rules That Hold Across All Patterns

- **The server is the authority.** Every client-side check in this document — `AuthGuard`, `RequireAccess`, `Can`, `useAuthorization()` — is presentation. The BFF must enforce the same rules on every endpoint.
- **Hooks throw outside their provider.** `useGlobalLoader`, `useTranslations`, `useAuth`, and `useAuthorization` fail with a descriptive error when the provider is missing. The `useLoaderTask()` hook in [pattern 5](#5-scope-loader-ownership) follows the same convention; any new capability you build on top of these primitives should too.
- **The loader is a boolean, not a stack.** Either give a workflow one owner (patterns 6 and 7) or route every task through a counting scope (pattern 5). Mixing both reintroduces the race.
- **The CSRF token is a snapshot.** It can be rotated by the server and is only as fresh as the last `/me` or `/refresh`. Treat `403` on a mutation as a possible stale-token outcome, not automatically as a permission bug.
- **Configuration is captured on mount.** `GlobalLoaderProvider` appearance and `AuthProvider` endpoint resolution are fixed for the lifetime of the provider. Changing either requires a remount.
- **`useObjectState` is provider-independent.** It composes with every pattern here but depends on none of them; keep its state flat and its factory pure.

---

# react Common Scenarios

This document answers common implementation questions with complete, runnable examples. All examples import from the public `blendsdk/react` entry point, use React 19 function components, and follow strict TypeScript conventions.

---

## How do I compose the providers for an application?

**Solution:** Mount `GlobalLoaderProvider` outermost, then `I18nProvider`, then `AuthProvider`. The I18n provider uses the global loader while fetching translations, so it must sit inside `GlobalLoaderProvider`. `AuthProvider` can sit inside or outside the I18n subtree depending on whether auth UI needs translations. `useObjectState` requires no provider.

| Provider | Responsibility | Required by |
|---|---|---|
| `GlobalLoaderProvider` | Full-screen loading overlay | `useGlobalLoader`, `I18nProvider` |
| `I18nProvider` | Translation loading and `t()` | `useTranslations` |
| `AuthProvider` | BFF session, actions, CSRF token | `useAuth`, `useAuthorization`, auth guards |

```tsx
import { AuthProvider, GlobalLoaderProvider, I18nProvider } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

function Application() {
    return <main>BlendSDK application</main>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <AuthProvider config={{ basePath: "/api/auth" }}>
                    <Application />
                </AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## How do I show a global loading overlay during an async operation?

**Solution:** Call `setText()` and `showLoader(true)` before the operation, and clear the loader in a `finally` block. `showLoader(false)` also clears the message. The loader is a single visibility flag, not a reference-counted stack, so overlapping operations share the same overlay.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function SaveInvoiceButton() {
    const { showLoader, setText, visible } = useGlobalLoader();

    const save = async (): Promise<void> => {
        setText("Saving invoice…");
        showLoader(true);

        try {
            const response = await fetch("/api/invoices/42", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ status: "sent" }),
            });

            if (!response.ok) {
                throw new Error(`Save failed with ${response.status}`);
            }
        } catch (error) {
            console.error("Could not save invoice", error);
        } finally {
            showLoader(false);
        }
    };

    return (
        <button type="button" onClick={() => void save()} disabled={visible}>
            {visible ? "Saving…" : "Save invoice"}
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <SaveInvoiceButton />
        </GlobalLoaderProvider>
    );
}
```

---

## How do I customize the global loader's spinner and message?

**Solution:** Pass a `GlobalLoaderConfig` to `GlobalLoaderProvider`. All properties are optional. The configuration is captured on mount and is not reactive, so changing it requires remounting the provider. Use `textComponent` to replace the default message renderer.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function LoaderPreview() {
    const { showLoader, setText, visible } = useGlobalLoader();

    const preview = (): void => {
        setText("Preparing your workspace…");
        showLoader(true);
        window.setTimeout(() => {
            showLoader(false);
        }, 1500);
    };

    return (
        <button type="button" onClick={preview} disabled={visible}>
            Preview loader
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
                backgroundColor: "rgba(15, 23, 42, 0.35)",
                textColor: "#f8fafc",
                zIndex: 1000000,
                textComponent: ({ text, textColor }) => (
                    <span style={{ color: textColor, fontWeight: 600 }}>{text}</span>
                ),
            }}
        >
            <LoaderPreview />
        </GlobalLoaderProvider>
    );
}
```

---

## How do I load translations from an API?

**Solution:** Supply a `TranslationLoader` to `I18nProvider`. The provider calls it for the default locale on mount and exposes the result through `t()`. Use `ready` to avoid rendering untranslated UI. If the loader rejects, the provider exposes no public error field; catch failures inside the loader or surface them through an error boundary.

```tsx
import { GlobalLoaderProvider, I18nProvider, useTranslations } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

function WelcomePanel() {
    const { t, ready } = useTranslations();

    if (!ready) {
        return <p>Loading translations…</p>;
    }

    return (
        <section>
            <h1>{t("dashboard.title")}</h1>
            <p>{t("dashboard.welcome", { name: "Ada" })}</p>
            <p>{t("cart.items", { count: 3 })}</p>
        </section>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <WelcomePanel />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## How do I change the active locale or reload translations at runtime?

**Solution:** `setLocale(locale)` switches the language and re-fetches translations through the loader. `reloadTranslations()` re-fetches the current locale, which is useful after translations change on the server. Both operations report progress through the global loader.

```tsx
import { GlobalLoaderProvider, I18nProvider, useTranslations } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

function TranslationControls() {
    const { t, locale, setLocale, reloadTranslations, ready } = useTranslations();

    if (!ready) {
        return <p>Loading translations…</p>;
    }

    return (
        <section lang={locale}>
            <h1>{t("settings.language.title")}</h1>

            <button
                type="button"
                onClick={() => setLocale("en")}
                disabled={locale === "en"}
            >
                English
            </button>

            <button
                type="button"
                onClick={() => setLocale("nl")}
                disabled={locale === "nl"}
            >
                Nederlands
            </button>

            <button type="button" onClick={reloadTranslations}>
                {t("translations.reload")}
            </button>

            <p>{t("settings.language.current", { locale })}</p>
        </section>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <TranslationControls />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## How do I report missing translation keys?

**Solution:** Pass `onMissingTranslation` to `I18nProvider`. The callback receives the missing key and locale and is intended for reporting only; it cannot supply a fallback value. Pair it with logging or your monitoring service.

```tsx
import { GlobalLoaderProvider, I18nProvider, useTranslations } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

function TranslationProbe() {
    const { t } = useTranslations();
    return <p>{t("dashboard.title")}</p>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider
                loader={loadTranslations}
                defaultLocale="en"
                onMissingTranslation={(key, locale) => {
                    console.warn(
                        `Missing translation "${key}" for locale "${locale}"`,
                    );
                }}
            >
                <TranslationProbe />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## How do I configure the BFF auth endpoints?

**Solution:** Provide `basePath` and any optional `AuthConfig` overrides. The provider merges them with `AUTH_DEFAULTS` on mount. Endpoint paths are relative to `basePath`. The resolved values are available through `useAuth().config`.

| Setting | Default |
|---|---|
| `basePath` | Required |
| `endpoints.login` | `"/login"` |
| `endpoints.callback` | `"/callback"` |
| `endpoints.logout` | `"/logout"` |
| `endpoints.me` | `"/me"` |
| `endpoints.refresh` | `"/refresh"` |
| `loginPath` | `"/login"` |
| `notAuthorizedPath` | `"/not-authorized"` |
| `defaultReturnTo` | `"/"` |
| `autoRefresh` | `true` |
| `refreshLeadTime` | `60` |
| `csrfHeader` | `"x-csrf-token"` |

```tsx
import { AUTH_DEFAULTS, AuthProvider, useAuth } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";

const authConfig: AuthConfig = {
    basePath: "/api/auth",
    endpoints: {
        ...AUTH_DEFAULTS.endpoints,
        me: "/session",
        refresh: "/session/refresh",
    },
    loginPath: "/sign-in",
    notAuthorizedPath: "/no-access",
    defaultReturnTo: "/dashboard",
    autoRefresh: true,
    refreshLeadTime: 30,
    csrfHeader: "x-csrf-token",
};

function ResolvedEndpoints() {
    const { config } = useAuth();

    return (
        <ul>
            <li>
                Login endpoint: {config.basePath}
                {config.endpoints.login}
            </li>
            <li>
                Session endpoint: {config.basePath}
                {config.endpoints.me}
            </li>
            <li>
                Refresh endpoint: {config.basePath}
                {config.endpoints.refresh}
            </li>
            <li>Login route: {config.loginPath}</li>
            <li>Not-authorized route: {config.notAuthorizedPath}</li>
            <li>CSRF header: {config.csrfHeader}</li>
        </ul>
    );
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <ResolvedEndpoints />
        </AuthProvider>
    );
}
```

---

## How do I sign a user in and out?

**Solution:** Use `useAuth()`. `login(returnTo?)` navigates the browser to the BFF login endpoint; it is a navigation, not an async function. `logout()` calls the BFF logout endpoint and clears local state, so await it and handle errors. Check `isLoading` before treating an absent user as anonymous.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionControls() {
    const { user, isAuthenticated, isLoading, login, logout } = useAuth();

    if (isLoading) {
        return <p>Checking your session…</p>;
    }

    if (!isAuthenticated || user === null) {
        return (
            <button type="button" onClick={() => login("/dashboard")}>
                Sign in
            </button>
        );
    }

    const handleLogout = async (): Promise<void> => {
        try {
            await logout();
        } catch (error) {
            console.error("Could not sign out", error);
        }
    };

    return (
        <section>
            <p>Signed in as {user.sub}</p>
            <button type="button" onClick={() => void handleLogout()}>
                Sign out
            </button>
        </section>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionControls />
        </AuthProvider>
    );
}
```

---

## How do I protect a route so unauthenticated users are redirected to login?

**Solution:** Wrap the protected route element with `AuthGuard`, place it inside `AuthProvider`, and render it inside a router. `AuthGuard` redirects unauthenticated users to `config.loginPath`. This scenario requires the optional `react-router` peer; install it alongside the `blendsdk` umbrella, `react`, and `react-dom`.

```tsx
import { AuthGuard, AuthProvider, useAuth } from "blendsdk/react";
import { BrowserRouter, Route, Routes } from "react-router";

function LoginPage() {
    const { isAuthenticated, isLoading, login } = useAuth();

    if (isLoading) {
        return <p>Checking your session…</p>;
    }

    if (isAuthenticated) {
        return <p>You are already signed in.</p>;
    }

    return (
        <button type="button" onClick={() => login()}>
            Sign in
        </button>
    );
}

function DashboardPage() {
    return <h1>Dashboard</h1>;
}

export function App() {
    return (
        <BrowserRouter>
            <AuthProvider
                config={{
                    basePath: "/api/auth",
                    loginPath: "/login",
                    defaultReturnTo: "/dashboard",
                }}
            >
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route
                        path="/dashboard"
                        element={
                            <AuthGuard>
                                <DashboardPage />
                            </AuthGuard>
                        }
                    />
                </Routes>
            </AuthProvider>
        </BrowserRouter>
    );
}
```

For grant-based gating, `RequireAccess` applies the same redirect pattern but sends signed-in users without the required grant to `config.notAuthorizedPath`. `Can` conditionally renders a UI fragment without redirecting. Both use the same roles and permissions as `useAuthorization()`.

---

## How do I distinguish an authenticated session from an authorized one?

**Solution:** `isAuthenticated` means a user object exists. `authorized` is the server's separate decision and is `false` before the first session check, for anonymous or failed checks, for a session the application denied, and after logout. Check `isLoading` first, then branch on both flags.

| Value | Meaning |
|---|---|
| `user` | `AuthUser` or `null` |
| `isAuthenticated` | `user !== null` |
| `authorized` | Server returned a session that is not marked `authorized: false` |
| `isLoading` | Initial session check is in progress |

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionStatus() {
    const { isLoading, isAuthenticated, authorized, user } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated || user === null) {
        return <p>No session. Sign in to continue.</p>;
    }

    if (!authorized) {
        return (
            <p>
                Signed in as {user.sub}, but the server has not authorized this
                session.
            </p>
        );
    }

    return <p>Signed in and authorized as {user.sub}.</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionStatus />
        </AuthProvider>
    );
}
```

---

## How do I send the CSRF token with a state-changing request?

**Solution:** Read `csrfToken` and `config.csrfHeader` from `useAuth()`, then add the token as a request header when it is not `null`. If CSRF is not enforced, the token is `null` and the header can be omitted. The token is a snapshot; if the server rotates the session token, a request made with an outdated value can be rejected with `403`.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function DeleteInvoiceButton() {
    const { csrfToken, config, isAuthenticated } = useAuth();

    const remove = async (): Promise<void> => {
        const headers: Record<string, string> = {};

        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        try {
            const response = await fetch("/api/invoices/42", {
                method: "DELETE",
                headers,
            });

            if (!response.ok) {
                throw new Error(`Delete failed with ${response.status}`);
            }
        } catch (error) {
            console.error("Could not delete invoice", error);
        }
    };

    if (!isAuthenticated) {
        return null;
    }

    return (
        <button type="button" onClick={() => void remove()}>
            Delete invoice
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <DeleteInvoiceButton />
        </AuthProvider>
    );
}
```

---

## How do I show UI based on roles and permissions?

**Solution:** Use `useAuthorization()`, which derives the principal from the session user and exposes `roles`, `permissions`, `hasRole()`, and `can()`. The values are readonly and the predicates are stable while the user object is unchanged. Authorization is presentation only: the server must enforce the same grants on every endpoint.

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";

function InvoiceToolbar() {
    const { roles, permissions, hasRole, can } = useAuthorization();

    return (
        <section>
            <p>Roles: {roles.length > 0 ? roles.join(", ") : "none"}</p>
            <p>
                Permissions:{" "}
                {permissions.length > 0 ? permissions.join(", ") : "none"}
            </p>

            {hasRole("finance") && <strong>Finance approval</strong>}

            {can("invoice:write") && (
                <button type="button">Edit invoice</button>
            )}

            {can("invoice:delete") && (
                <button type="button">Delete invoice</button>
            )}
        </section>
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

Anonymous users and malformed `roles` or `permissions` claims produce an empty principal, so every check returns `false` instead of throwing. For declarative element gating, `Can` wraps the same kind of check; for route-level grant gating, `RequireAccess` redirects to `config.notAuthorizedPath`.

---

## How do I manage a form with a single object state?

**Solution:** Use `useObjectState<T>()` with an interface type. The factory runs lazily on mount, `setState` accepts a partial patch or a functional updater, and `reset` re-runs the original factory. The setter and reset callbacks are stable across renders. The hook is provider-independent.

```tsx
import { useObjectState } from "blendsdk/react";
import type { FormEvent } from "react";

interface ProfileFormState {
    firstName: string;
    lastName: string;
    age: number;
    newsletter: boolean;
}

export function ProfileForm() {
    const [form, setForm, resetForm] = useObjectState<ProfileFormState>(() => ({
        firstName: "",
        lastName: "",
        age: 0,
        newsletter: false,
    }));

    const submit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        console.log("Submitting profile", form);
    };

    return (
        <form onSubmit={submit}>
            <label>
                First name
                <input
                    value={form.firstName}
                    onChange={(event) =>
                        setForm({ firstName: event.target.value })
                    }
                />
            </label>

            <label>
                Last name
                <input
                    value={form.lastName}
                    onChange={(event) =>
                        setForm({ lastName: event.target.value })
                    }
                />
            </label>

            <label>
                Age
                <input
                    type="number"
                    value={form.age}
                    onChange={(event) => {
                        const age = Number.parseInt(event.target.value, 10);
                        setForm({ age: Number.isNaN(age) ? 0 : age });
                    }}
                />
            </label>

            <label>
                <input
                    type="checkbox"
                    checked={form.newsletter}
                    onChange={(event) =>
                        setForm({ newsletter: event.target.checked })
                    }
                />
                Newsletter
            </label>

            <button type="submit">Save</button>
            <button type="button" onClick={resetForm}>
                Reset
            </button>
        </form>
    );
}
```

---

## How do I update a nested field or apply two updates in one event?

**Solution:** The merge is shallow. To update a nested object, spread the previous nested value into the patch. To apply multiple updates in the same event, use the functional updater form so each update receives the latest state instead of a stale render value.

```tsx
import { useObjectState } from "blendsdk/react";

interface CheckoutState {
    customer: {
        name: string;
        email: string;
    };
    quantity: number;
}

export function CheckoutEditor() {
    const [checkout, setCheckout, resetCheckout] =
        useObjectState<CheckoutState>(() => ({
            customer: { name: "", email: "" },
            quantity: 1,
        }));

    const setEmail = (email: string): void => {
        setCheckout((previous) => ({
            customer: { ...previous.customer, email },
        }));
    };

    const addTwo = (): void => {
        setCheckout((previous) => ({ quantity: previous.quantity + 1 }));
        setCheckout((previous) => ({ quantity: previous.quantity + 1 }));
    };

    return (
        <section>
            <label>
                Name
                <input
                    value={checkout.customer.name}
                    onChange={(event) =>
                        setCheckout((previous) => ({
                            customer: {
                                ...previous.customer,
                                name: event.target.value,
                            },
                        }))
                    }
                />
            </label>

            <label>
                Email
                <input
                    value={checkout.customer.email}
                    onChange={(event) => setEmail(event.target.value)}
                />
            </label>

            <p>Quantity: {checkout.quantity}</p>

            <button type="button" onClick={addTwo}>
                Add two
            </button>
            <button type="button" onClick={resetCheckout}>
                Reset
            </button>
        </section>
    );
}
```

Nested objects are replaced, not deep-merged, so always spread the previous nested value when updating it. Arrays, class instances, and function values are outside the hook's contract. Setting a property to `undefined` leaves the key present in the object.

---

# react Examples Library

Copy-paste-ready examples for every module of `blendsdk/react`. Each example is a complete ES module: it includes its imports, uses strict TypeScript, and sits inside the provider it needs. Within each category, examples are ordered from simple to complex.

| Category | Covers | Provider requirement |
|---|---|---|
| [Application Setup](#application-setup) | Provider composition | `GlobalLoaderProvider`, `I18nProvider`, `AuthProvider` |
| [Global Loader](#global-loader) | Overlay visibility, text, appearance | `GlobalLoaderProvider` |
| [Internationalization](#internationalization) | `t()`, locales, reloads | `I18nProvider` (inside `GlobalLoaderProvider`) |
| [Authentication](#authentication) | Session state, actions, CSRF, route guards | `AuthProvider`; `react-router` for `AuthGuard` |
| [Authorization](#authorization) | Grants, predicates, visibility | `AuthProvider` |
| [Object State](#object-state) | Partial patches, functional updates, reset | None |
| [Full Application](#full-application) | All modules combined | All of the above |

---

## Application Setup

`GlobalLoaderProvider` sits at the root, `I18nProvider` mounts inside it (translation fetches surface the global overlay), and `AuthProvider` wraps the parts of the tree that read the session. `useObjectState` needs no provider at all.

### Minimal Auth Provider Setup

The shortest complete session wiring: one provider and a component that switches between loading, anonymous, and authenticated states.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionBar() {
    const { user, isAuthenticated, isLoading, login, logout } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated || user === null) {
        return (
            <button type="button" onClick={() => login()}>
                Sign in
            </button>
        );
    }

    return (
        <button type="button" onClick={() => void logout()}>
            Sign out ({user.sub})
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionBar />
        </AuthProvider>
    );
}
```

**Expected result:** While the initial `GET /api/auth/me` check runs, the bar shows “Checking session…”. Anonymous visitors see a single “Sign in” button that starts the BFF login flow; once the session is established the same slot shows “Sign out (<sub>)”.

### Full Provider Composition

Compose the loading overlay, internationalization, and authentication providers so every descendant hook resolves. Only the I18n-inside-GlobalLoader edge is required.

```tsx
import {
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    useAuth,
    useTranslations,
} from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

function HomePage() {
    const { t } = useTranslations();
    const { isAuthenticated } = useAuth();

    return (
        <main>
            <h1>{t("home.title")}</h1>
            <p>{isAuthenticated ? t("home.signedIn") : t("home.anonymous")}</p>
        </main>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider config={{ spinnerColor: "#25b09b" }}>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <AuthProvider config={{ basePath: "/api/auth" }}>
                    <HomePage />
                </AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Expected result:** The page renders the translated heading, and the second line switches between the signed-in and anonymous strings after the session check. The teal overlay is available to every descendant, including `I18nProvider` while it loads a locale.

---

## Global Loader

The overlay is one visibility flag plus optional text. `showLoader(true)` blocks the page, `setText()` updates the message, and `showLoader(false)` hides the overlay and clears the text. Configuration is captured on mount and is not reactive.

### Show and Hide the Overlay Around an Async Operation

The canonical pattern: set the message, show the overlay, and clear both in `finally` so a failed request never leaves the page blocked.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function SaveInvoiceButton() {
    const { showLoader, setText, visible } = useGlobalLoader();

    const save = async (): Promise<void> => {
        setText("Saving invoice…");
        showLoader(true);
        try {
            const response = await fetch("/api/invoices/42", { method: "PUT" });
            if (!response.ok) {
                throw new Error(`Save failed with ${response.status}`);
            }
        } catch (error) {
            console.error("Could not save invoice", error);
        } finally {
            showLoader(false);
        }
    };

    return (
        <button type="button" disabled={visible} onClick={() => void save()}>
            {visible ? "Saving…" : "Save invoice"}
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <SaveInvoiceButton />
        </GlobalLoaderProvider>
    );
}
```

**Expected result:** The overlay blocks the page for the duration of the `PUT`, and the button is disabled while `visible` is true. `showLoader(false)` in `finally` hides the overlay and clears the “Saving invoice…” text even when the request fails.

### Customize the Overlay Appearance

Pass a `GlobalLoaderConfig` to restyle the spinner, background, text color, and stacking order.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";
import type { GlobalLoaderConfig } from "blendsdk/react";

const loaderConfig: GlobalLoaderConfig = {
    spinnerColor: "#25b09b",
    spinnerWidth: 4,
    spinnerSize: 64,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
    textColor: "#f8fafc",
    zIndex: 2000,
};

function PreviewButton() {
    const { showLoader, setText } = useGlobalLoader();

    const show = (): void => {
        setText("Loading preview…");
        showLoader(true);
        window.setTimeout(() => showLoader(false), 1500);
    };

    return (
        <button type="button" onClick={show}>
            Show loader for 1.5 s
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider config={loaderConfig}>
            <PreviewButton />
        </GlobalLoaderProvider>
    );
}
```

**Expected result:** A 64 px teal spinner on a dark translucent overlay for 1.5 seconds. Because the configuration is captured on mount, changing `loaderConfig` later requires remounting the provider.

### Render a Custom Loader Message

Use `textComponent` to replace the default paragraph below the spinner with your own element while keeping the `text`/`textColor` contract.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";
import type { GlobalLoaderConfig } from "blendsdk/react";

const loaderConfig: GlobalLoaderConfig = {
    spinnerColor: "#2563eb",
    textComponent: ({ text, textColor }) => (
        <span
            style={{
                color: textColor,
                fontSize: "16px",
                fontWeight: 600,
                marginTop: "20px",
            }}
        >
            {text}
        </span>
    ),
};

function RefreshButton() {
    const { showLoader, setText } = useGlobalLoader();

    const refresh = async (): Promise<void> => {
        setText("Refreshing data…");
        showLoader(true);
        try {
            const response = await fetch("/api/statistics", { method: "POST" });
            if (!response.ok) {
                throw new Error(`Refresh failed with ${response.status}`);
            }
        } catch (error) {
            console.error("Could not refresh statistics", error);
        } finally {
            showLoader(false);
        }
    };

    return (
        <button type="button" onClick={() => void refresh()}>
            Refresh statistics
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider config={loaderConfig}>
            <RefreshButton />
        </GlobalLoaderProvider>
    );
}
```

**Expected result:** The message below the spinner renders as a bold 16 px span instead of the default paragraph, colored with the configured `textColor`.

---

## Internationalization

`I18nProvider` loads a flat key/value catalog through an application-supplied `TranslationLoader` and exposes `t()`, `locale`, `setLocale()`, `reloadTranslations()`, and `ready`. Mount it inside `GlobalLoaderProvider`, because locale switches surface the global overlay while the loader runs.

### Translate with Interpolation and Plurals

Load a locale on mount, gate rendering on `ready`, and call `t()` with interpolation parameters and a `count` for plural selection.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
} from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

function CartSummary() {
    const { t, ready } = useTranslations();

    if (!ready) {
        return <p>Loading translations…</p>;
    }

    return (
        <section>
            <h1>{t("cart.title")}</h1>
            <p>{t("cart.greeting", { name: "Ada" })}</p>
            <p>{t("cart.itemCount", { count: 1 })}</p>
            <p>{t("cart.itemCount", { count: 3 })}</p>
            <p>{t("cart.total", { amount: "€ 42.50" })}</p>
        </section>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <CartSummary />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Expected result:** After the catalog loads, `t("cart.greeting", { name: "Ada" })` interpolates the name, and `t("cart.itemCount", { count })` selects the singular entry for 1 and the plural entry for 3.

### Switch Locales at Runtime

`setLocale()` re-fetches through the loader while the global overlay reports progress, then re-renders every `t()` call.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
} from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

const locales = ["en", "nl", "de"] as const;

function LocaleSwitcher() {
    const { t, locale, setLocale, ready } = useTranslations();

    return (
        <div>
            <p>{ready ? t("common.greeting") : "…"}</p>
            {locales.map((code) => (
                <button
                    key={code}
                    type="button"
                    disabled={code === locale}
                    onClick={() => setLocale(code)}
                >
                    {code.toUpperCase()}
                </button>
            ))}
        </div>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <LocaleSwitcher />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Expected result:** Clicking NL calls `setLocale("nl")`, the global overlay appears while the loader re-fetches, and the greeting re-renders in Dutch. The active locale's button stays disabled.

### Reload Translations and Report Missing Keys

`reloadTranslations()` re-fetches the current locale, and `onMissingTranslation` reports keys that the catalog does not contain.

```tsx
import {
    GlobalLoaderProvider,
    I18nProvider,
    useTranslations,
} from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

function TranslationsPanel() {
    const { t, locale, reloadTranslations } = useTranslations();

    return (
        <section lang={locale}>
            <h2>{t("translations.title")}</h2>
            <p>{t("translations.lastUpdated", { date: "2025-01-15" })}</p>
            <button type="button" onClick={reloadTranslations}>
                {t("common.reload")}
            </button>
        </section>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider
                loader={loadTranslations}
                defaultLocale="en"
                onMissingTranslation={(key, missingLocale) => {
                    console.warn(`Missing translation "${key}" for "${missingLocale}"`);
                }}
            >
                <TranslationsPanel />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Expected result:** Pressing reload re-fetches the current locale and re-renders all translated text; a key that is absent from the catalog is reported to `onMissingTranslation` with its key and locale.

---

## Authentication

These examples cover the session lifecycle: hydrating from `/me`, signing in and out through the BFF, refreshing before expiry, sending the CSRF token, and protecting routes. Remember that `isAuthenticated` (a user object exists) and `authorized` (the server's decision) are separate flags.

### Display Session Status

Read the session state and render the subject, the authorization decision, and the local expiry time.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionStatus() {
    const { user, isAuthenticated, isLoading, authorized, expiresAt } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated || user === null) {
        return <p>Not signed in.</p>;
    }

    return (
        <dl>
            <dt>Subject</dt>
            <dd>{user.sub}</dd>
            <dt>Authorized</dt>
            <dd>{authorized ? "yes" : "no"}</dd>
            <dt>Expires</dt>
            <dd>
                {expiresAt === null
                    ? "unknown"
                    : new Date(expiresAt * 1000).toLocaleString()}
            </dd>
        </dl>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionStatus />
        </AuthProvider>
    );
}
```

**Expected result:** “Checking session…” during the initial check, “Not signed in.” for anonymous visitors, and the three-row list once a session exists. `Authorized` can read “no” while a subject is shown.

### Sign In and Sign Out

`login(returnTo?)` navigates to the BFF login endpoint with a post-login path; `logout()` ends the session through the BFF and clears local state.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function AccountMenu() {
    const { user, isAuthenticated, login, logout } = useAuth();

    if (!isAuthenticated || user === null) {
        return (
            <button type="button" onClick={() => login("/invoices")}>
                Sign in to continue
            </button>
        );
    }

    const handleLogout = async (): Promise<void> => {
        try {
            await logout();
        } catch (error) {
            console.error("Logout request failed", error);
        }
    };

    return (
        <div>
            <span>{user.sub}</span>
            <button type="button" onClick={() => void handleLogout()}>
                Sign out
            </button>
        </div>
    );
}

export function App() {
    return (
        <AuthProvider
            config={{ basePath: "/api/auth", defaultReturnTo: "/dashboard" }}
        >
            <AccountMenu />
        </AuthProvider>
    );
}
```

**Expected result:** `login("/invoices")` sends the browser to the BFF login endpoint, and after the OIDC round trip the BFF returns the browser to `/invoices`. `logout()` resolves once the BFF ended the session; a failed request is logged without crashing the menu.

### Manually Refresh the Session

Call `refresh()` when you want to extend the session on demand — for example with `autoRefresh` disabled. It resolves to `true` on success and `false` on failure.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionExtender() {
    const { isAuthenticated, expiresAt, refresh } = useAuth();

    const extend = async (): Promise<void> => {
        try {
            const refreshed = await refresh();
            if (!refreshed) {
                console.warn("The server could not refresh the session");
            }
        } catch (error) {
            console.error("Refresh request failed", error);
        }
    };

    if (!isAuthenticated) {
        return <p>Sign in to extend your session.</p>;
    }

    return (
        <div>
            <p>
                Current expiry:{" "}
                {expiresAt === null
                    ? "unknown"
                    : new Date(expiresAt * 1000).toLocaleTimeString()}
            </p>
            <button type="button" onClick={() => void extend()}>
                Extend session
            </button>
        </div>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth", autoRefresh: false }}>
            <SessionExtender />
        </AuthProvider>
    );
}
```

**Expected result:** The button sends `POST /api/auth/refresh`; the expiry line updates when the BFF grants an extension, and a `false` result leaves the current session untouched.

### Send the CSRF Token on a State-Changing Request

Read `csrfToken` from the session and send it in the header named by `config.csrfHeader` on mutating BFF calls.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function DeleteInvoiceButton() {
    const { isAuthenticated, authorized, csrfToken, config } = useAuth();

    if (!isAuthenticated || !authorized) {
        return null;
    }

    const handleDelete = async (): Promise<void> => {
        const headers: Record<string, string> = {
            "content-type": "application/json",
        };
        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        try {
            const response = await fetch("/api/invoices/42", {
                method: "DELETE",
                headers,
            });
            if (!response.ok) {
                throw new Error(`Delete failed with ${response.status}`);
            }
        } catch (error) {
            console.error("Could not delete invoice", error);
        }
    };

    return (
        <button type="button" onClick={() => void handleDelete()}>
            Delete invoice
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <DeleteInvoiceButton />
        </AuthProvider>
    );
}
```

**Expected result:** The `DELETE` carries the session's CSRF token in `x-csrf-token` (or the configured header). A `403` response means the token was superseded or rejected; the next `/me` or `/refresh` check replaces it.

### Override Auth Endpoints with AUTH_DEFAULTS

Spread `AUTH_DEFAULTS.endpoints`, override only the paths that differ, and read the fully resolved configuration back from `useAuth()`.

```tsx
import { AUTH_DEFAULTS, AuthProvider, useAuth } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";

const authConfig: AuthConfig = {
    basePath: "/api/session",
    endpoints: {
        ...AUTH_DEFAULTS.endpoints,
        me: "/whoami",
        login: "/start",
        logout: "/end",
    },
    loginPath: "/sign-in",
    notAuthorizedPath: "/access-denied",
    defaultReturnTo: "/dashboard",
    autoRefresh: true,
    refreshLeadTime: 30,
    csrfHeader: "x-xsrf-token",
};

function ResolvedEndpoints() {
    const { config } = useAuth();

    return (
        <ul>
            <li>
                login: {config.basePath}
                {config.endpoints.login}
            </li>
            <li>
                callback: {config.basePath}
                {config.endpoints.callback}
            </li>
            <li>
                logout: {config.basePath}
                {config.endpoints.logout}
            </li>
            <li>
                me: {config.basePath}
                {config.endpoints.me}
            </li>
            <li>
                refresh: {config.basePath}
                {config.endpoints.refresh}
            </li>
        </ul>
    );
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <ResolvedEndpoints />
        </AuthProvider>
    );
}

// Renders:
//   login:    /api/session/start
//   callback: /api/session/callback
//   logout:   /api/session/end
//   me:       /api/session/whoami
//   refresh:  /api/session/refresh
```

**Expected result:** Overridden paths replace their defaults; every endpoint not overridden (`callback`, `refresh`) keeps its `AUTH_DEFAULTS` path relative to the new `basePath`.

### Protect Routes with AuthGuard and React Router

`AuthGuard` gates authentication and redirects unauthenticated visitors to `config.loginPath`. It performs a router redirect, so it needs the optional `react-router` peer.

```tsx
import { AuthGuard, AuthProvider, useAuth } from "blendsdk/react";
import { BrowserRouter, Link, Route, Routes } from "react-router";

function Dashboard() {
    const { user } = useAuth();

    return <h1>Dashboard for {user === null ? "unknown" : user.sub}</h1>;
}

function LoginPage() {
    const { login } = useAuth();

    return (
        <button type="button" onClick={() => login("/dashboard")}>
            Sign in
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth", loginPath: "/login" }}>
            <BrowserRouter>
                <nav>
                    <Link to="/dashboard">Dashboard</Link>
                </nav>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route
                        path="/dashboard"
                        element={
                            <AuthGuard>
                                <Dashboard />
                            </AuthGuard>
                        }
                    />
                </Routes>
            </BrowserRouter>
        </AuthProvider>
    );
}
```

**Expected result:** An anonymous visit to `/dashboard` redirects to `/login` instead of rendering the dashboard. Once the session exists, `AuthGuard` renders the protected page.

---

## Authorization

`useAuthorization()` turns the session user's `roles` and `permissions` claims into predicates. The checks are presentation only and fail closed: missing or malformed grants resolve to an empty principal, and the server remains the enforcement point. The declarative components `Can`, `RequireAccess`, and `AuthGuard` apply the same rules in JSX; these examples focus on the hook and session flag, and `AuthGuard` is shown with React Router above.

### Read Roles and Permissions with useAuthorization

Display the canonical grants and branch on `hasRole()` and `can()`.

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";

function InvoiceToolbar() {
    const { roles, permissions, hasRole, can } = useAuthorization();

    return (
        <section>
            <p>Roles: {roles.length > 0 ? roles.join(", ") : "none"}</p>
            <p>
                Permissions:{" "}
                {permissions.length > 0 ? permissions.join(", ") : "none"}
            </p>
            {hasRole("finance") && <strong>Finance team</strong>}
            {can("invoice:write") && <button type="button">Edit invoice</button>}
            {can("invoice:approve") && (
                <button type="button">Approve invoice</button>
            )}
        </section>
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

**Expected result:** Anonymous visitors see “Roles: none” and no action buttons — checks fail closed. A user holding `finance` and `invoice:write` sees the badge and the edit button.

### Handle a Signed-In but Unauthorized Session

`isAuthenticated` and `authorized` answer different questions. This example renders a distinct message for a session the server has not authorized.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function AccountBanner() {
    const { user, isAuthenticated, authorized, logout } = useAuth();

    const handleLogout = async (): Promise<void> => {
        try {
            await logout();
        } catch (error) {
            console.error("Logout request failed", error);
        }
    };

    if (!isAuthenticated || user === null) {
        return <p>You are browsing anonymously.</p>;
    }

    if (!authorized) {
        return (
            <section role="alert">
                <p>
                    You are signed in as {user.sub}, but this application has not
                    granted your account access.
                </p>
                <button type="button" onClick={() => void handleLogout()}>
                    Sign out
                </button>
            </section>
        );
    }

    return <p>Welcome back, {user.sub}.</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AccountBanner />
        </AuthProvider>
    );
}
```

**Expected result:** An account the server marked `authorized: false` sees the explanatory alert and a sign-out button; a fully authorized account sees the welcome line.

### Filter Navigation by Permission

Build navigation items as data with a required permission, then filter with `can()`.

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";

interface NavItem {
    label: string;
    href: string;
    permission: string;
}

const navItems: NavItem[] = [
    { label: "Invoices", href: "/invoices", permission: "invoice:read" },
    { label: "Customers", href: "/customers", permission: "customer:read" },
    { label: "Reports", href: "/reports", permission: "report:read" },
    { label: "Settings", href: "/settings", permission: "settings:write" },
];

function MainNavigation() {
    const { can } = useAuthorization();
    const visibleItems = navItems.filter((item) => can(item.permission));

    return (
        <nav>
            <ul>
                {visibleItems.map((item) => (
                    <li key={item.href}>
                        <a href={item.href}>{item.label}</a>
                    </li>
                ))}
            </ul>
        </nav>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <MainNavigation />
        </AuthProvider>
    );
}
```

**Expected result:** Only links whose permission the user holds are rendered; an anonymous user gets an empty list. Hiding links is a convenience — the server must still enforce each route.

---

## Object State

`useObjectState` keeps one plain object of related fields. The setter shallow-merges a partial patch into the latest state, supports a functional updater, and `reset` re-runs the factory for a fresh object. The setter and reset callbacks are stable across renders.

### Manage a Form with Partial Patches

One state object for a whole form; each change patches a single field while the others keep their values.

```tsx
import { useObjectState } from "blendsdk/react";

interface ProfileFormState {
    displayName: string;
    email: string;
    newsletter: boolean;
}

export function ProfileForm() {
    const [form, setForm] = useObjectState<ProfileFormState>(() => ({
        displayName: "",
        email: "",
        newsletter: true,
    }));

    const submit = async (): Promise<void> => {
        try {
            const response = await fetch("/api/profile", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(form),
            });
            if (!response.ok) {
                throw new Error(`Save failed with ${response.status}`);
            }
        } catch (error) {
            console.error("Could not save profile", error);
        }
    };

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <label>
                Display name
                <input
                    value={form.displayName}
                    onChange={(event) => setForm({ displayName: event.target.value })}
                />
            </label>
            <label>
                Email
                <input
                    type="email"
                    value={form.email}
                    onChange={(event) => setForm({ email: event.target.value })}
                />
            </label>
            <label>
                <input
                    type="checkbox"
                    checked={form.newsletter}
                    onChange={(event) => setForm({ newsletter: event.target.checked })}
                />
                Receive the newsletter
            </label>
            <button type="submit">Save profile</button>
        </form>
    );
}
```

**Expected result:** Each keystroke patches one property while the other fields keep their values, and the submit handler sends the complete object as the request body.

### Apply Functional Updates

The updater form receives the latest state, so consecutive updates in one event build on each other instead of on a stale render value.

```tsx
import { useObjectState } from "blendsdk/react";

interface CounterState {
    count: number;
    lastAction: "increment" | "decrement" | "reset";
}

export function QuantityStepper() {
    const [state, setState, reset] = useObjectState<CounterState>(() => ({
        count: 0,
        lastAction: "reset",
    }));

    const increment = (): void => {
        setState((previous) => ({
            count: previous.count + 1,
            lastAction: "increment",
        }));
    };

    const decrement = (): void => {
        setState((previous) => ({
            count: Math.max(0, previous.count - 1),
            lastAction: "decrement",
        }));
    };

    const incrementTwice = (): void => {
        // Both functional updates read the latest count, so this adds two.
        setState((previous) => ({
            count: previous.count + 1,
            lastAction: "increment",
        }));
        setState((previous) => ({
            count: previous.count + 1,
            lastAction: "increment",
        }));
    };

    return (
        <div>
            <p>
                Quantity: {state.count} (last action: {state.lastAction})
            </p>
            <button type="button" onClick={increment}>+</button>
            <button type="button" onClick={decrement}>−</button>
            <button type="button" onClick={incrementTwice}>+2</button>
            <button type="button" onClick={reset}>Reset</button>
        </div>
    );
}
```

**Expected result:** “+2” increments by two because both functional updates read the latest state; “−” floors at zero; “Reset” restores `count: 0` and `lastAction: "reset"`.

### Reset to the Factory Defaults

`reset()` re-runs the original factory and stores a fresh object, so the reset baseline cannot be mutated by later edits.

```tsx
import { useObjectState } from "blendsdk/react";

interface SearchState {
    query: string;
    category: string;
    includeArchived: boolean;
}

const emptySearch = (): SearchState => ({
    query: "",
    category: "all",
    includeArchived: false,
});

export function SearchPanel() {
    const [search, setSearch, resetSearch] = useObjectState<SearchState>(emptySearch);

    const activeFilters =
        (search.query !== "" ? 1 : 0) +
        (search.category !== "all" ? 1 : 0) +
        (search.includeArchived ? 1 : 0);

    return (
        <section>
            <input
                placeholder="Search…"
                value={search.query}
                onChange={(event) => setSearch({ query: event.target.value })}
            />
            <select
                value={search.category}
                onChange={(event) => setSearch({ category: event.target.value })}
            >
                <option value="all">All categories</option>
                <option value="invoices">Invoices</option>
                <option value="customers">Customers</option>
            </select>
            <label>
                <input
                    type="checkbox"
                    checked={search.includeArchived}
                    onChange={(event) =>
                        setSearch({ includeArchived: event.target.checked })
                    }
                />
                Include archived
            </label>
            <p>{activeFilters} active filter(s)</p>
            <button type="button" onClick={resetSearch}>
                Clear filters
            </button>
        </section>
    );
}
```

**Expected result:** The counter reflects the number of non-default fields; “Clear filters” re-runs `emptySearch()` and stores a fresh object, so later edits cannot leak into the reset baseline.

### Update Nested Objects Safely

The merge is shallow: nested objects are replaced, not deep-merged. Spread the current nested value inside the patch.

```tsx
import { useObjectState } from "blendsdk/react";

interface SettingsState {
    profile: { name: string; title: string };
    notifications: { email: boolean; sms: boolean };
}

export function SettingsForm() {
    const [settings, setSettings, resetSettings] = useObjectState<SettingsState>(() => ({
        profile: { name: "Ada Lovelace", title: "Engineer" },
        notifications: { email: true, sms: false },
    }));

    const rename = (name: string): void => {
        setSettings((previous) => ({
            profile: { ...previous.profile, name },
        }));
    };

    return (
        <form>
            <input
                value={settings.profile.name}
                onChange={(event) => rename(event.target.value)}
            />
            <label>
                <input
                    type="checkbox"
                    checked={settings.notifications.email}
                    onChange={(event) =>
                        setSettings((previous) => ({
                            notifications: {
                                ...previous.notifications,
                                email: event.target.checked,
                            },
                        }))
                    }
                />
                Email notifications
            </label>
            <button type="button" onClick={resetSettings}>
                Restore defaults
            </button>
        </form>
    );
}
```

**Expected result:** Each handler spreads the current nested object before overriding one field, so the sibling fields (`title`, `sms`) survive the patch. `Restore defaults` swaps in fresh nested objects from the factory.

### Share the Setter with Typed Child Components

Pass the stable setter to a child and type the prop with the exported `ObjectStateSetter<T>`.

```tsx
import { useObjectState } from "blendsdk/react";
import type { ObjectStateSetter } from "blendsdk/react";

interface FormState {
    name: string;
    age: number;
}

interface NameFieldProps {
    value: string;
    onChange: ObjectStateSetter<FormState>;
}

function NameField({ value, onChange }: NameFieldProps) {
    return (
        <input
            value={value}
            onChange={(event) => onChange({ name: event.target.value })}
        />
    );
}

export function PersonForm() {
    const [form, setForm] = useObjectState<FormState>(() => ({
        name: "",
        age: 0,
    }));

    return (
        <form>
            <NameField value={form.name} onChange={setForm} />
            <input
                type="number"
                value={form.age}
                onChange={(event) => setForm({ age: Number(event.target.value) })}
            />
        </form>
    );
}
```

**Expected result:** The child applies patches typed against `FormState`; a patch with an unknown property or a wrong value type fails compilation, and the setter identity stays stable across renders.

---

## Full Application

### Compose Every Module in One Application

The final example combines the overlay, translations, session, route guard, permission-gated UI, and object-shaped filters in one application tree.

```tsx
import {
    AuthGuard,
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    useAuth,
    useAuthorization,
    useGlobalLoader,
    useObjectState,
    useTranslations,
} from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";
import { BrowserRouter, Link, Route, Routes } from "react-router";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

interface InvoiceFiltersState {
    query: string;
    status: "all" | "open" | "paid";
}

function isFilterStatus(value: string): value is InvoiceFiltersState["status"] {
    return value === "all" || value === "open" || value === "paid";
}

function InvoiceList() {
    const { t } = useTranslations();
    const { can } = useAuthorization();
    const { showLoader, setText } = useGlobalLoader();
    const [filters, setFilters, resetFilters] = useObjectState<InvoiceFiltersState>(
        () => ({ query: "", status: "all" }),
    );

    const refresh = async (): Promise<void> => {
        setText(t("invoices.refreshing"));
        showLoader(true);
        try {
            const response = await fetch("/api/invoices");
            if (!response.ok) {
                throw new Error(`Refresh failed with ${response.status}`);
            }
        } catch (error) {
            console.error("Could not refresh invoices", error);
        } finally {
            showLoader(false);
        }
    };

    return (
        <section>
            <h1>{t("invoices.title")}</h1>
            <input
                value={filters.query}
                placeholder={t("invoices.searchPlaceholder")}
                onChange={(event) => setFilters({ query: event.target.value })}
            />
            <select
                value={filters.status}
                onChange={(event) => {
                    const value = event.target.value;
                    if (isFilterStatus(value)) {
                        setFilters({ status: value });
                    }
                }}
            >
                <option value="all">{t("invoices.status.all")}</option>
                <option value="open">{t("invoices.status.open")}</option>
                <option value="paid">{t("invoices.status.paid")}</option>
            </select>
            <button type="button" onClick={() => void refresh()}>
                {t("common.refresh")}
            </button>
            <button type="button" onClick={resetFilters}>
                {t("common.clear")}
            </button>
            {can("invoice:write") && (
                <button type="button">{t("invoices.create")}</button>
            )}
        </section>
    );
}

function Header() {
    const { t } = useTranslations();
    const { user, isAuthenticated, logout } = useAuth();

    const handleLogout = async (): Promise<void> => {
        try {
            await logout();
        } catch (error) {
            console.error("Could not sign out", error);
        }
    };

    if (!isAuthenticated || user === null) {
        return null;
    }

    return (
        <header>
            <span>{user.sub}</span>
            <button type="button" onClick={() => void handleLogout()}>
                {t("auth.signOut")}
            </button>
        </header>
    );
}

function LoginPage() {
    const { login } = useAuth();
    const { t } = useTranslations();

    return (
        <button type="button" onClick={() => login("/invoices")}>
            {t("auth.signIn")}
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider config={{ spinnerColor: "#25b09b" }}>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <AuthProvider config={{ basePath: "/api/auth", loginPath: "/login" }}>
                    <BrowserRouter>
                        <Header />
                        <nav>
                            <Link to="/invoices">Invoices</Link>
                        </nav>
                        <Routes>
                            <Route path="/login" element={<LoginPage />} />
                            <Route
                                path="/invoices"
                                element={
                                    <AuthGuard>
                                        <InvoiceList />
                                    </AuthGuard>
                                }
                            />
                        </Routes>
                    </BrowserRouter>
                </AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Expected result:** A signed-out visitor to `/invoices` is redirected to `/login`; after signing in, the page shows translated labels, filter controls backed by `useObjectState`, the teal overlay during refresh, and the create button only when `invoice:write` is held. Refreshing a filter or a locale always passes through the same global overlay, so the application never shows two competing spinners.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
