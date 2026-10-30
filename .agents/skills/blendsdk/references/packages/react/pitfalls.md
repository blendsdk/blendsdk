> **Package**: `blendsdk/react`

# react Best Practices

`blendsdk/react` is infrastructure, not a component kit: providers own the session, the translation catalog, and the loading overlay, while hooks read that state from React context. Most mistakes with this package are therefore behavioral rather than syntactic — a session that is re-checked on every navigation, an overlay that never hides, an authorization check that renders the wrong thing, or object state that silently stops updating.

Each practice below is presented as a pair: the failing pattern first, then the recommended one, followed by the consequence of getting it wrong. The rules apply to all four modules — auth, authorization, i18n, and object state — and to provider composition across them.

| Concern | Do | Don't |
|---|---|---|
| Provider placement | Mount providers once, above the router and every consumer | Mount providers inside route components or conditionals |
| Provider composition | Mount `I18nProvider` inside `GlobalLoaderProvider` | Mount the i18n provider outside the loader |
| Authentication | Distinguish `isAuthenticated` from `authorized`; wait for `isLoading` | Treat a present user as server authorization |
| Auth paths | Set `loginPath` for the frontend route; keep `endpoints.login` for the BFF | Use `endpoints.login` as a frontend route |
| Auth actions | `await logout()` and inspect the `boolean` from `refresh()` | Fire-and-forget promises and ignore failure |
| CSRF | Send `csrfToken` under `config.csrfHeader` | Hard-code `x-csrf-token` or send empty tokens |
| Authorization | Use `useAuthorization()` for grants | Read or cast raw `user.roles` / `user.permissions` |
| Global loader | Clear it in `finally`; one owner per visible period | Leave it visible on errors; run overlapping operations |
| I18n | Gate translated UI on `ready`; call `setLocale()` from events | Render `t()` before load; call `setLocale()` during render |
| Object state | Functional patches, immutable updates, pure factory | Stale patches, in-place mutation, shared baseline objects |

---

## Do / Don't Pairs

### Mount providers once, above every consumer

**❌ Wrong**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionBar() {
    const { user } = useAuth();
    return <span>{user?.sub ?? "anonymous"}</span>;
}

export function DashboardRoute() {
    // ❌ The provider is route-local: navigating away unmounts it, and every
    // return discards the session state and re-runs the initial /me check.
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionBar />
        </AuthProvider>
    );
}
```

**✅ Correct**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionBar() {
    const { user } = useAuth();
    return <span>{user?.sub ?? "anonymous"}</span>;
}

function DashboardRoute() {
    return <SessionBar />;
}

export function App() {
    // ✅ Mounted once at the root, outside route transitions.
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <DashboardRoute />
        </AuthProvider>
    );
}
```

**Why.** `AuthProvider` hydrates the session from `GET {basePath}/me` on mount and schedules automatic renewal. A provider mounted inside a route component unmounts whenever that route leaves the tree, so the next visit restarts the session check and re-fetches `/me`. During that window `isLoading` is `true` again, and any guard or UI that reacts to authentication state briefly sees an empty session. Hoist providers above the router; render routes and guards inside.

### Mount `I18nProvider` inside `GlobalLoaderProvider`

**❌ Wrong**

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

function Title() {
    const { t } = useTranslations();
    return <h1>{t("app.title")}</h1>;
}

export function App() {
    return (
        // ❌ I18nProvider reports translation fetches through the global
        // loader, but the loader is mounted below it here.
        <I18nProvider loader={loadTranslations} defaultLocale="en">
            <GlobalLoaderProvider>
                <Title />
            </GlobalLoaderProvider>
        </I18nProvider>
    );
}
```

**✅ Correct**

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

function Title() {
    const { t } = useTranslations();
    return <h1>{t("app.title")}</h1>;
}

export function App() {
    return (
        // ✅ Global loader outermost, translations inside it.
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <Title />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Why.** The i18n provider uses the global loader while fetching translations. When it is mounted outside `GlobalLoaderProvider`, its internal loader call has no context to consume and fails at the first translation load. The supported composition is outside in: `GlobalLoaderProvider` → `I18nProvider` → `AuthProvider` → routes and guards. Only the loader/i18n edge is mandatory; the auth subtree may sit inside or outside i18n depending on whether auth screens need translations.

### Separate `isAuthenticated` from `authorized`

**❌ Wrong**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function InvoicePage() {
    const { user, isAuthenticated } = useAuth();

    if (!isAuthenticated) {
        return <p>Please sign in.</p>;
    }

    // ❌ A user object only means the session exists. The BFF can still have
    // denied the session, in which case authorized === false and this renders
    // data the server has refused.
    return <h1>Invoices for {user?.sub}</h1>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <InvoicePage />
        </AuthProvider>
    );
}
```

**✅ Correct**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function InvoicePage() {
    const { user, isAuthenticated, isLoading, authorized } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated || user === null) {
        return <p>Please sign in.</p>;
    }

    if (!authorized) {
        return <p>Your account is not authorized to view invoices.</p>;
    }

    return <h1>Invoices for {user.sub}</h1>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <InvoicePage />
        </AuthProvider>
    );
}
```

**Why.** The two flags answer different questions. `isAuthenticated` is derived from `user !== null`; `authorized` is the server's decision for the session. A signed-in user can be authenticated and unauthorized at the same time, and `authorized` is also `false` before the first `/me` check, for anonymous or failed checks, and after logout. Checking `isLoading` first prevents the first render from showing a false "not authorized" state.

### Keep `loginPath` and `endpoints.login` distinct

**❌ Wrong**

```tsx
import { AuthProvider } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";

const authConfig: AuthConfig = {
    basePath: "/api/auth",
    // ❌ The sign-in page lives at /sign-in, so the login endpoint is
    // overridden. But endpoints.login is the BFF route: login() now
    // navigates to /api/auth/sign-in, and AuthGuard still redirects to
    // the default frontend route /login.
    endpoints: { login: "/sign-in" },
};

function Dashboard() {
    return <h1>Dashboard</h1>;
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <Dashboard />
        </AuthProvider>
    );
}
```

**✅ Correct**

```tsx
import { AuthProvider } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";

const authConfig: AuthConfig = {
    basePath: "/api/auth",
    // ✅ Frontend route used by AuthGuard for its redirect.
    loginPath: "/sign-in",
    // ✅ endpoints.login keeps its default: the BFF route /api/auth/login
    // that login() navigates to.
};

function Dashboard() {
    return <h1>Dashboard</h1>;
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <Dashboard />
        </AuthProvider>
    );
}
```

**Why.** `login()` navigates to `${basePath}${endpoints.login}`, which is a backend route; `AuthGuard` redirects to `loginPath`, which is a frontend route. They serve different layers and can legitimately have different values. Overriding the wrong one either sends the browser to a missing BFF endpoint or redirects users to a frontend page that does not exist. Set both deliberately and never put an absolute URL in `endpoints`; those paths are relative to `basePath`.

### Await `logout()` and surface failures

**❌ Wrong**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SignOutButton() {
    const { logout } = useAuth();

    // ❌ The promise is dropped. If the logout request fails, the failure is
    // unhandled, the user stays signed in, and the UI gives no feedback.
    return (
        <button type="button" onClick={() => { void logout(); }}>
            Sign out
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SignOutButton />
        </AuthProvider>
    );
}
```

**✅ Correct**

```tsx
import { useState } from "react";
import { AuthProvider, useAuth } from "blendsdk/react";

function SignOutButton() {
    const { logout } = useAuth();
    const [error, setError] = useState<string | null>(null);

    const handleSignOut = async (): Promise<void> => {
        setError(null);
        try {
            await logout();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Sign out failed.");
        }
    };

    return (
        <div>
            <button type="button" onClick={() => void handleSignOut()}>
                Sign out
            </button>
            {error !== null && <p role="alert">{error}</p>}
        </div>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SignOutButton />
        </AuthProvider>
    );
}
```

**Why.** `logout()` is asynchronous: it calls the BFF logout endpoint and then clears local state. Dropping the promise hides a failed logout from both the user and the console. Awaiting the call lets you show progress, keep the user informed on failure, and avoid navigating away before the session is actually cleared.

### Check the `boolean` returned by `refresh()`

**❌ Wrong**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function RefreshButton() {
    const { refresh } = useAuth();

    // ❌ refresh() resolves to false when the session could not be renewed.
    // Ignoring the result treats a failed refresh as a success.
    return (
        <button type="button" onClick={() => { void refresh(); }}>
            Refresh session
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <RefreshButton />
        </AuthProvider>
    );
}
```

**✅ Correct**

```tsx
import { useState } from "react";
import { AuthProvider, useAuth } from "blendsdk/react";

function RefreshButton() {
    const { refresh } = useAuth();
    const [status, setStatus] = useState<string | null>(null);

    const handleRefresh = async (): Promise<void> => {
        try {
            const renewed = await refresh();
            setStatus(renewed ? "Session renewed." : "Session could not be renewed.");
        } catch (cause) {
            setStatus(cause instanceof Error ? cause.message : "Refresh failed.");
        }
    };

    return (
        <div>
            <button type="button" onClick={() => void handleRefresh()}>
                Refresh session
            </button>
            {status !== null && <p role="status">{status}</p>}
        </div>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <RefreshButton />
        </AuthProvider>
    );
}
```

**Why.** Manual refresh reports failure through its `boolean` result, not only through exceptions. The provider already schedules renewal when `autoRefresh` is enabled, so this button should exist for explicit user action or recovery, never as a replacement for the schedule. Polling `refresh()` on a timer duplicates the built-in renewal and can race it.

### Send the CSRF token under the configured header

**❌ Wrong**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function DeleteInvoiceButton({ invoiceId }: { invoiceId: string }) {
    const { csrfToken } = useAuth();

    const handleDelete = async (): Promise<void> => {
        // ❌ Hard-codes the default header name and sends an empty value when
        // CSRF is not enforced (csrfToken === null).
        await fetch(`/api/bff/invoices/${invoiceId}`, {
            method: "DELETE",
            headers: { "x-csrf-token": csrfToken ?? "" },
        });
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
            <DeleteInvoiceButton invoiceId="42" />
        </AuthProvider>
    );
}
```

**✅ Correct**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function DeleteInvoiceButton({ invoiceId }: { invoiceId: string }) {
    const { csrfToken, config } = useAuth();

    const handleDelete = async (): Promise<void> => {
        const headers: Record<string, string> = {};
        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        try {
            const response = await fetch(`/api/bff/invoices/${invoiceId}`, {
                method: "DELETE",
                headers,
            });
            if (!response.ok) {
                throw new Error(`Delete failed with ${response.status}`);
            }
        } catch (cause) {
            console.error("Could not delete invoice", cause);
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
            <DeleteInvoiceButton invoiceId="42" />
        </AuthProvider>
    );
}
```

**Why.** The server decides which header carries the token; `csrfHeader` is configurable precisely because deployments differ, and the default `x-csrf-token` is only a default. Hard-coding the header breaks those deployments. When `csrfToken` is `null`, CSRF is not enforced, and sending an empty header can be rejected rather than ignored. Send the token only to same-origin BFF calls and only when it exists.

### Use `useAuthorization()` instead of reading raw claims

**❌ Wrong**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function InvoiceToolbar() {
    const { user } = useAuth();

    // ❌ user.roles is `unknown`. The assertion hides missing or malformed
    // claims, and the expression crashes when the value is not an array.
    const roles = user?.roles as string[];

    return <p>Roles: {roles?.join(", ") ?? "none"}</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <InvoiceToolbar />
        </AuthProvider>
    );
}
```

**✅ Correct**

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";

function InvoiceToolbar() {
    const { roles, permissions, hasRole, can } = useAuthorization();

    return (
        <section>
            <p>Roles: {roles.length > 0 ? roles.join(", ") : "none"}</p>
            <p>Permissions: {permissions.length > 0 ? permissions.join(", ") : "none"}</p>
            {hasRole("finance") && <strong>Finance</strong>}
            {can("invoice:write") && <button type="button">Edit invoice</button>}
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

**Why.** Session claims are untrusted runtime data: `user.roles` and `user.permissions` are typed as `unknown`, may be absent, may not be arrays, and may contain non-string entries. A cast moves that failure into render. `useAuthorization()` sanitizes the claims — non-arrays become empty lists, non-string entries are ignored, duplicates are removed — and returns an empty principal for anonymous users, so requirements fail closed. Its result is also memoized on the user, keeping `hasRole` and `can` stable between renders.

### Clear the global loader in `finally`

**❌ Wrong**

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function SaveButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleSave = async (): Promise<void> => {
        setText("Saving…");
        showLoader(true);

        // ❌ If the request rejects, the overlay is never hidden and blocks
        // the entire application.
        await fetch("/api/invoices/42", { method: "PUT" });
        showLoader(false);
    };

    return (
        <button type="button" onClick={() => void handleSave()}>
            Save
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <SaveButton />
        </GlobalLoaderProvider>
    );
}
```

**✅ Correct**

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function SaveButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleSave = async (): Promise<void> => {
        setText("Saving…");
        showLoader(true);
        try {
            const response = await fetch("/api/invoices/42", { method: "PUT" });
            if (!response.ok) {
                throw new Error(`Save failed with ${response.status}`);
            }
        } catch (cause) {
            console.error("Could not save invoice", cause);
        } finally {
            showLoader(false);
        }
    };

    return (
        <button type="button" onClick={() => void handleSave()}>
            Save
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <SaveButton />
        </GlobalLoaderProvider>
    );
}
```

**Why.** The overlay is full-screen and blocks interaction; leaving it visible on the error path makes the application unusable until a reload. `showLoader(false)` also clears the text, so the `finally` block handles both cleanup steps. Set the text while the loader is visible, and avoid setting it after hiding it.

### Give each visible loader period a single owner

**❌ Wrong**

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function InvoiceLoader() {
    const { showLoader, setText } = useGlobalLoader();

    const load = async (): Promise<void> => {
        setText("Loading invoices…");
        showLoader(true);
        await new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 400);
        });
        showLoader(false);
    };

    return <button type="button" onClick={() => void load()}>Load invoices</button>;
}

function ReportLoader() {
    const { showLoader, setText } = useGlobalLoader();

    const load = async (): Promise<void> => {
        setText("Building report…");
        showLoader(true);
        await new Promise<void>((resolve) => {
            setTimeout(() => resolve(), 800);
        });
        showLoader(false);
    };

    return <button type="button" onClick={() => void load()}>Build report</button>;
}

export function App() {
    return (
        // ❌ Two components control one visibility flag. The faster operation
        // hides the overlay while the slower one is still running.
        <GlobalLoaderProvider>
            <InvoiceLoader />
            <ReportLoader />
        </GlobalLoaderProvider>
    );
}
```

**✅ Correct**

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function WorkflowPanel() {
    const { showLoader, setText } = useGlobalLoader();

    const runBoth = async (): Promise<void> => {
        setText("Working…");
        showLoader(true);
        try {
            await Promise.all([
                new Promise<void>((resolve) => {
                    setTimeout(() => resolve(), 400);
                }),
                new Promise<void>((resolve) => {
                    setTimeout(() => resolve(), 800);
                }),
            ]);
        } finally {
            showLoader(false);
        }
    };

    return <button type="button" onClick={() => void runBoth()}>Run both</button>;
}

export function App() {
    return (
        // ✅ One component owns the visible period.
        <GlobalLoaderProvider>
            <WorkflowPanel />
        </GlobalLoaderProvider>
    );
}
```

**Why.** The loader is a single `visible` boolean, not a reference-counted stack. Every `showLoader(false)` hides the overlay for all operations, and every `setText` overwrites the shared message. Independent widgets should use local loading indicators; the global overlay is for coarse operations owned by one component that starts and finishes them together.

### Gate translated UI on `ready`

**❌ Wrong**

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

function Header() {
    const { t } = useTranslations();

    // ❌ Translations load asynchronously; the first render happens before the
    // catalog exists, so translated text cannot be displayed yet.
    return <h1>{t("app.title")}</h1>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <Header />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**✅ Correct**

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

function Header() {
    const { t, ready } = useTranslations();

    if (!ready) {
        // ✅ Stable fallback until the catalog is available.
        return <h1 aria-busy="true">Loading translations…</h1>;
    }

    return <h1>{t("app.title")}</h1>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <Header />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

**Why.** `I18nProvider` loads the default locale on mount; until that load succeeds, `ready` is `false` and the catalog is not available to `t()`. Rendering translated text unconditionally produces an untranslated first paint and unnecessary layout shifts. Gate the components that need translations, not unrelated static UI.

### Change the locale from an event, never during render

**❌ Wrong**

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

function LocaleSwitcher() {
    const { t, locale, setLocale } = useTranslations();

    // ❌ Calling setLocale during render triggers a loader fetch and a state
    // update on every render, which can loop indefinitely.
    setLocale(locale === "en" ? "nl" : "en");

    return <button type="button">{t("language.switch")}</button>;
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

**✅ Correct**

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

function LocaleSwitcher() {
    const { t, locale, setLocale } = useTranslations();

    const toggleLocale = (): void => {
        setLocale(locale === "en" ? "nl" : "en");
    };

    return (
        <button type="button" onClick={toggleLocale}>
            {t("language.switch")}
        </button>
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

**Why.** `setLocale()` is an action, not a value: it changes provider state and triggers a new loader call. React renders must stay pure; calling it during render updates the provider while rendering and re-triggers the same code, which can loop and fire a fetch per render. Call it from a click handler, or from an effect when syncing the locale to a route parameter.

### Use functional patches when the next value depends on the previous

**❌ Wrong**

```tsx
import { useObjectState } from "blendsdk/react";

interface CounterState {
    count: number;
    lastAction: string;
}

export function Counter() {
    const [state, setState] = useObjectState<CounterState>(() => ({
        count: 0,
        lastAction: "reset",
    }));

    const incrementTwice = (): void => {
        // ❌ Both patches are computed from the same render value. The second
        // write replaces the first, so count grows by one instead of two.
        setState({ count: state.count + 1, lastAction: "increment" });
        setState({ count: state.count + 1, lastAction: "increment" });
    };

    return (
        <button type="button" onClick={incrementTwice}>
            Count: {state.count}
        </button>
    );
}
```

**✅ Correct**

```tsx
import { useObjectState } from "blendsdk/react";

interface CounterState {
    count: number;
    lastAction: string;
}

export function Counter() {
    const [state, setState] = useObjectState<CounterState>(() => ({
        count: 0,
        lastAction: "reset",
    }));

    const incrementTwice = (): void => {
        // ✅ Each functional update receives the latest state.
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
        <button type="button" onClick={incrementTwice}>
            Count: {state.count}
        </button>
    );
}
```

**Why.** The setter applies a patch to the latest state internally, but the patch expression itself is evaluated when the call is made. Building the patch from `state` captured at render means consecutive updates all start from the same baseline, and the last one wins. The functional form moves the calculation inside React's updater, where `previous` is the latest state.

### Treat object state as immutable and flat

**❌ Wrong**

```tsx
import { useObjectState } from "blendsdk/react";

interface FilterState {
    query: string;
    statuses: string[];
}

export function InvoiceFilters() {
    const [filters, setFilters] = useObjectState<FilterState>(() => ({
        query: "",
        statuses: [],
    }));

    const addStatus = (status: string): void => {
        // ❌ Mutating the stored array keeps the same state object: no setter
        // call means no re-render, and the reset baseline can be polluted.
        filters.statuses.push(status);
    };

    return (
        <button type="button" onClick={() => addStatus("open")}>
            {filters.statuses.join(", ") || "No filters"}
        </button>
    );
}
```

**✅ Correct**

```tsx
import { useObjectState } from "blendsdk/react";

interface FilterState {
    query: string;
    statuses: string[];
}

export function InvoiceFilters() {
    const [filters, setFilters] = useObjectState<FilterState>(() => ({
        query: "",
        statuses: [],
    }));

    const addStatus = (status: string): void => {
        // ✅ Replace the array and send it through the setter.
        setFilters((previous) => ({
            statuses: [...previous.statuses, status],
        }));
    };

    return (
        <button type="button" onClick={() => addStatus("open")}>
            {filters.statuses.join(", ") || "No filters"}
        </button>
    );
}
```

**Why.** The hook detects updates only when the setter is called; in-place mutation keeps the same object reference and React has nothing to schedule. Replacement also preserves the reset contract. The hook is built for plain objects: top-level arrays and class instances are outside the contract because object spreading drops array behavior and prototypes. Nested objects are replaced, not deep-merged, so spread them yourself when updating a nested field. Setting a property to `undefined` leaves the key present; model optional properties explicitly instead of using `undefined` as a delete.

### Return a fresh object from the `useObjectState` factory

**❌ Wrong**

```tsx
import { useObjectState } from "blendsdk/react";

interface Settings {
    theme: "light" | "dark";
    notifications: boolean;
}

// ❌ Every factory call returns the same object reference.
const sharedDefaults: Settings = { theme: "light", notifications: true };

export function SettingsEditor() {
    const [settings, setSettings, reset] = useObjectState<Settings>(() => sharedDefaults);

    return (
        <div>
            <p>Theme: {settings.theme}</p>
            <button type="button" onClick={() => setSettings({ theme: "dark" })}>
                Use dark theme
            </button>
            <button type="button" onClick={reset}>
                Reset
            </button>
        </div>
    );
}
```

**✅ Correct**

```tsx
import { useObjectState } from "blendsdk/react";

interface Settings {
    theme: "light" | "dark";
    notifications: boolean;
}

// ✅ A new plain object on every call, so state never aliases the baseline.
const createDefaults = (): Settings => ({
    theme: "light",
    notifications: true,
});

export function SettingsEditor() {
    const [settings, setSettings, reset] = useObjectState<Settings>(createDefaults);

    return (
        <div>
            <p>Theme: {settings.theme}</p>
            <button type="button" onClick={() => setSettings({ theme: "dark" })}>
                Use dark theme
            </button>
            <button type="button" onClick={reset}>
                Reset
            </button>
        </div>
    );
}
```

**Why.** The factory runs lazily on mount, may run twice in development StrictMode, and runs again on every `reset()`. If it returns a shared object, the state and the reset baseline alias the same reference; any in-place mutation leaks into every reset, and later mounts observe mutated defaults. The factory must be pure and return a new plain object each time. It is captured on the first render, so changing the `create` argument later does not change the reset baseline.

---

## Anti-Patterns

### Using client-side authorization as the security boundary

`Can`, `RequireAccess`, `hasRole()`, and `can()` decide what the UI renders. They are not enforcement: React code is visible to users, requests can be issued outside the application, and every client check can be bypassed. The BFF must reject the same operation when the grant is missing. A hidden button is a convenience; a rejected request is the actual control.

```typescript fragment
const { can } = useAuthorization();
const mayEdit = can("invoice:write");
// Render the control only when mayEdit is true — but the API must still
// return 403 when the caller lacks invoice:write.
```

### Calling provider hooks from non-React code

`useAuth()`, `useAuthorization()`, `useTranslations()`, `useGlobalLoader()`, and `useObjectState()` are React hooks: they must be called from a component or another hook during render. Calling them from a utility function, an event bus, a route loader, or a module-level initializer either violates the rules of hooks or throws because the context is only available inside the provider subtree. Read the value in a component and pass it to the utility, or wrap the logic in a custom hook.

### Building a parallel auth client

Manually fetching `/me`, storing the user in another store, and scheduling your own refresh timer duplicates the provider and drifts from it. `AuthProvider` is the only thing maintaining `user`, `authorized`, `expiresAt`, and `csrfToken`; a second client will miss session changes, double the refresh calls, and disagree with the guards. Consume `useAuth()` instead.

### Storing tokens in browser storage

The auth model is a BFF session: tokens stay on the server and the browser holds an HttpOnly cookie that JavaScript cannot read. Do not copy tokens into `localStorage` or `sessionStorage`, and do not try to read the session cookie through `document.cookie`. If a feature appears to need the token in the browser, move the call to the BFF.

### Expecting provider configuration to update at runtime

`GlobalLoaderConfig` is captured on mount and is not reactive; `AuthConfig` is merged with `AUTH_DEFAULTS` on mount and exposed as the resolved `useAuth().config`. Re-rendering the provider with a new object does not apply the change. Treat both as static startup configuration. If a change is genuinely required, remount the provider with a new `key` — and accept that everything below it remounts as well.

### Running overlapping global-loader operations

The loader is one visibility flag and one message, not a per-operation tracker. Two widgets that call `showLoader(true)` and later `showLoader(false)` will hide the overlay for each other, and `setText` is last-writer-wins. Give each visible period one owner, or keep per-widget progress local to the widget.

### Hard-coding the CSRF header or treating the token as permanent

The token is exposed as `csrfToken` and the header name as `config.csrfHeader`; use both. Hard-coding `x-csrf-token` breaks when the server uses a different header. Caching the token in a module variable ignores rotation: the token can be regenerated when session-id rotation is enabled, and another browsing context can replace it without this tab observing the change until the next session check. On a `403` caused by an outdated token, `await refresh()` and retry once instead of dropping CSRF protection.

### Using absolute URLs in endpoint overrides

`endpoints` paths are relative to `basePath`; the provider concatenates them. An absolute URL or a path outside `basePath` produces a wrong navigation target and can leak the CSRF token to another origin if the resulting request is cross-origin. Keep `basePath` and all endpoint overrides same-origin and application-controlled.

### Mounting nested or duplicate providers

A second `AuthProvider` in a subtree creates a second session, a second `/me` request, and a second refresh schedule. Consumers inside see the nearest provider, while consumers outside see the outer one, so the application silently operates with two authentication states. Mount each provider once at the root; split layouts instead of re-wrapping subtrees.

### Using redirect guards for element visibility

`AuthGuard` and `RequireAccess` redirect; they are route-level gates. Wrapping a button or toolbar in a redirecting guard navigates the user away when the condition fails instead of hiding the control. Use `Can` or `useAuthorization()` for elements, and reserve the guards for routes.

### Overloading `isLoading` as a general loading flag

`isLoading` covers only the initial session check. It does not track `refresh()`, `logout()`, or any application request. Using it as a global spinner flag produces a loader that never reflects the actual operation. Keep separate state for other async work, or use the global loader deliberately.

---

## Performance Tips

1. **Hoist providers to avoid re-hydration.** Every `AuthProvider` mount performs the `/me` check and schedules renewal; every `I18nProvider` mount fetches translations. Mounting providers above the router means route changes cost neither network round-trips nor session-state resets. A keyed remount for loader theming should be a deliberate, rare operation because it remounts the entire subtree.

2. **Keep context consumers local.** A context value change re-renders every component that consumes that context. Reading `useAuth()` once in a top-level layout and passing `user` down re-renders the layout and its children on every session change; reading `useAuth()` in the leaf components that actually display the user narrows the render to those leaves. Apply the same rule to `useGlobalLoader()`: it should be called by the component that owns the operation, not by every row in a list, because every message change re-renders all consumers.

3. **Let `autoRefresh` do the scheduling.** With `autoRefresh` enabled (the default), the provider refreshes once per expiry window at `expiresAt - refreshLeadTime`. A manual interval adds duplicate requests, can race the scheduled refresh, and multiplies server load across open tabs. Use `refresh()` for explicit user action or recovery, not as a polling loop.

4. **Reuse the memoized authorization result.** `useAuthorization()` memoizes on `user`, so `roles`, `permissions`, `hasRole`, and `can` stay referentially stable between session updates. Deriving a filtered roles array or a permission `Set` inside render creates new objects every time and defeats memoized children. Pass the predicates or the booleans they produce.

5. **Group related fields in `useObjectState`, but keep the object small.** One state cell for a form avoids a `useState` call per field and updates the whole form with one render. Each patch still copies the top-level object, so do not store large server collections there; keep lists in their own state and derive expensive values with `useMemo` instead of storing them.

6. **Use the global loader for coarse work only.** Showing the overlay blocks the entire application and causes a full-screen paint; toggling it for every fetch produces flicker and blocks unrelated interactions. Per-widget progress belongs in the widget; a single overlay is for route transitions, session bootstrap, and save operations that must prevent interaction.

7. **Call `setLocale()` only when the locale actually changes.** Each call triggers a new loader invocation. Avoid binding it to inputs that fire per keystroke; a select or button is sufficient. If translations are served over HTTP, let the loader benefit from caching headers or an `ETag` rather than refetching unchanged catalogs.

8. **Skip the router dependency when you do not redirect.** `react-router` is an optional peer needed only by `AuthGuard` and `RequireAccess`. Applications that use `Can`, `useAuthorization()`, and the other hooks never import it, so the bundler omits it. Importing a guard just for convenience pulls the router into the bundle.

9. **Pass the stable `useObjectState` callbacks directly.** `setState` and `reset` keep the same identity across renders. Passing them to memoized children is safe without an extra `useCallback` wrapper, and the wrapper itself would create a new dependency object for no benefit.

---

## Security Considerations

1. **The server is the authorization boundary.** `Can`, `RequireAccess`, `hasRole()`, `can()`, and `authorized` decide rendering. Every endpoint must independently enforce the same grants; client code is readable, modifiable, and bypassable. Treat UI gating as a usability feature, never as the control that protects data.

2. **Tokens never enter JavaScript.** The BFF keeps access and refresh tokens server-side and gives the browser an HttpOnly session cookie. Do not store tokens in `localStorage` or `sessionStorage`, do not attempt to read the session cookie via `document.cookie`, and do not expose tokens through your own endpoints. If the client appears to need a token, move the call that needs it to the BFF.

3. **Send CSRF tokens on state-changing calls.** Read `csrfToken` and `config.csrfHeader` from `useAuth()` and send the header on `POST`, `PUT`, `PATCH`, and `DELETE` requests to the BFF. Send it only to same-origin endpoints. When a request is rejected with `403` because the token rotated, `await refresh()` to obtain the current token and retry once; do not disable CSRF or fall back to an unauthenticated call.

4. **Prevent open redirects through `returnTo`.** `login(returnTo?)` and `defaultReturnTo` become navigation targets. Never pass `window.location.href`, a query parameter, or any other user-controlled string without validating that it is an internal path. Reject protocol-relative and backslash-containing values, which browsers may normalize into external URLs.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function toInternalPath(candidate: string): string {
    if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) {
        return "/";
    }
    return candidate;
}

function SignInLink({ next }: { next: string }) {
    const { login } = useAuth();

    return (
        <button type="button" onClick={() => login(toInternalPath(next))}>
            Sign in
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth", defaultReturnTo: "/" }}>
            <SignInLink next="/invoices" />
        </AuthProvider>
    );
}
```

5. **Treat claims and translations as untrusted data.** `AuthUser` is typed with `[key: string]: unknown`; do not cast a claim to a trusted type without validating it. Render claims and `t()` results as text — React escapes string children — and never pass them to `dangerouslySetInnerHTML`. Interpolation is not sanitization; translation values are data, not HTML.

6. **Recognize that session snapshots go stale.** `authorized`, `expiresAt`, and `csrfToken` reflect the last `/me` or `refresh` response. Another tab can sign out, replace the session, or rotate the CSRF token without this tab observing it. Privileged operations must revalidate on the server, and the client should handle `401` and `403` by refreshing or re-checking the session instead of assuming the previous flag still holds.

7. **Trust the configuration source.** `basePath` and endpoint overrides determine where the browser is sent for login and where the CSRF token is transmitted. Keep them in static application configuration, same-origin, and out of user input. A manipulated `basePath` redirects the login flow and can expose the token to an attacker-controlled host.

8. **Do not log credentials or full claims.** Avoid logging `csrfToken`, raw `/me` responses, or complete `user` objects in production error reporting. Log the failure and a non-sensitive identifier such as `user.sub`, and redact the rest.

---

# react Testing Patterns

`blendsdk/react` is infrastructure, so most of what a test observes is *behavior through React*: a hook's returned values, what a component renders, which BFF endpoints were called, and in which order. Nothing here needs a browser, a server, or a container: the package's own suite runs in `jsdom` with the global `fetch` stubbed, and `react-router` supplied as an in-memory router. **There are no Docker or external service dependencies for testing this package.**

---

## Test Stack at a Glance

| Concern | Tool | Notes |
|---|---|---|
| Runner, assertions, mocking, fake timers | `vitest` | ESM, `globals: false` — import `describe`, `it`, `expect`, `vi` explicitly |
| DOM environment | `jsdom` | Set once in `vitest.config.ts`; no per-file docblock needed |
| Rendering components and hooks | `@testing-library/react` | `render`, `renderHook`, `screen`, `waitFor`, `act`, `fireEvent` |
| DOM event helpers | `@testing-library/dom` | Peer dependency of RTL; `fireEvent` comes from RTL |
| DOM matchers | `@testing-library/jest-dom` | Registered from the setup file via `@testing-library/jest-dom/vitest` |
| Router for guard tests | `react-router` | `MemoryRouter`, `Routes`, `Route` |
| Coverage | `@vitest/coverage-v8` | Used by `npm run test:coverage` |
| Type-level tests | `typescript` + `expectTypeOf` | Checked by `tsc --noEmit -p tsconfig.typecheck.json` |

---

## Test Setup

### Install the Test Stack

```bash
# Application dependencies (the umbrella package, never a subpath)
npm install blendsdk react react-dom

# Add only when rendering AuthGuard or RequireAccess
npm install blendsdk react react-dom react-router

# Test tooling
npm install --save-dev vitest jsdom @testing-library/react @testing-library/dom \
  @testing-library/jest-dom @vitest/coverage-v8
```

### Vitest Configuration

One config serves both the runtime suite (`*.test.ts(x)`) and the type-level suite (`*.test-d.ts`). Helpers live outside the `include` globs so they are never collected as test files.

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
        globals: false,
        setupFiles: ["./tests/setup.ts"],
        include: ["tests/**/*.test.{ts,tsx}"],
        restoreMocks: true,
        typecheck: {
            include: ["tests/**/*.test-d.ts"],
            tsconfig: "./tsconfig.typecheck.json",
        },
        coverage: {
            provider: "v8",
            include: ["src/**/*.{ts,tsx}"],
            reportsDirectory: "./coverage",
        },
    },
});
```

`restoreMocks: true` restores every spy and mock implementation before each test, so `vi.spyOn(console, "error")` in one test never leaks into the next.

### Global Setup File

The setup file does three jobs: register the DOM matchers, run Testing Library cleanup (RTL cannot auto-register cleanup when `globals` is `false`), and reset Vitest's global stubs and fake timers.

```typescript
// tests/setup.ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
    // Required because `globals: false` disables RTL's automatic cleanup.
    cleanup();
    // Undo `vi.stubGlobal(...)` calls such as the `fetch` stub.
    vi.unstubAllGlobals();
    // Never carry fake timers into the next test.
    vi.useRealTimers();
});
```

### Type-Checking Configuration

The `include` list must contain the setup file; that is how the jest-dom matcher augmentation reaches every test file in the program.

```json
{
    "extends": "./tsconfig.json",
    "compilerOptions": {
        "noEmit": true
    },
    "include": ["src", "tests"]
}
```

### Resolving `blendsdk/react` Inside the Monorepo

The package's `exports` field points at `dist/`, so a type-check that imports the package root needs either a build or a path mapping. The package's own tests avoid the question by importing the source barrel relatively (`tests/use-object-state.test-d.ts` uses `../src/index.js`). Mapping the specifier is the cleaner option when test files should read like consumer code:

```json
{
    "compilerOptions": {
        "paths": {
            "blendsdk/react": ["./src/index.ts"]
        }
    }
}
```

The examples in this document import from `blendsdk/react`, which is what application tests do.

### Test Layout

| Path | Contents |
|---|---|
| `tests/setup.ts` | Matcher registration, cleanup, stub reset |
| `tests/helpers/fetch.ts` | Typed `fetch` mock, JSON responses, URL extraction |
| `tests/helpers/session.ts` | Shared `/me` payload fixtures and the base auth config |
| `tests/helpers/providers.tsx` | `TestProviders`, `renderWithProviders`, `renderHookWithProviders` |
| `tests/helpers/error-boundary.tsx` | Captures the errors that provider hooks throw |
| `tests/helpers/auth-context.ts` | A complete `AuthContextValue` for `useAuth` stubs |
| `tests/*.test.tsx` | Runtime tests |
| `tests/*.test-d.ts` | Type-level tests (checked by `tsc`) |

### Helper: Typed `fetch` Mock

The BFF is the only external boundary in this package, so every auth test starts by stubbing `fetch`. The helpers below keep the mock fully typed (`Mock<typeof fetch>`) and make URL assertions readable without depending on the *number* of arguments the provider passes.

```typescript
// tests/helpers/fetch.ts
import { vi } from "vitest";

/** Creates a `fetch`-typed mock. */
export function createFetchMock() {
    return vi.fn<typeof fetch>();
}

/** The mock type produced by {@link createFetchMock}. */
export type FetchMock = ReturnType<typeof createFetchMock>;

/** Installs the mock as the global `fetch` and returns it. */
export function installFetchMock(): FetchMock {
    const mock = createFetchMock();
    vi.stubGlobal("fetch", mock);
    return mock;
}

/** Builds a JSON `Response` for a stubbed endpoint. */
export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** Builds a body-less `Response` for statuses that forbid a body (204, 205, 304). */
export function emptyResponse(status: number): Response {
    return new Response(null, { status });
}

/** Normalizes the first argument of `fetch` to a URL string. */
export function toUrl(input: Parameters<typeof fetch>[0]): string {
    if (typeof input === "string") {
        return input;
    }
    if (input instanceof URL) {
        return input.toString();
    }
    return input.url;
}

/** The URLs the mock was called with, in call order. */
export function requestedUrls(mock: FetchMock): string[] {
    return mock.mock.calls.map(([input]) => toUrl(input));
}
```

### Helper: Session Fixtures

`AuthUser` carries an index signature (`[key: string]: unknown`), so malformed-grant fixtures are still type-safe and never need a cast.

```typescript
// tests/helpers/session.ts
import type { AuthConfig, AuthUser } from "blendsdk/react";

/**
 * The payload shape the provider copies into context from `GET /me`:
 * the user, the server's authorization decision, the expiry and the CSRF token.
 * Match the field names your BFF actually returns.
 */
export interface SessionPayload {
    user: AuthUser | null;
    authorized: boolean;
    expiresAt: number | null;
    csrfToken: string | null;
}

export const financeUser: AuthUser = {
    sub: "user-42",
    roles: ["finance", "admin"],
    permissions: ["invoice:read", "invoice:write"],
};

/** Auth config for tests that do not exercise renewal. */
export const testAuthConfig: AuthConfig = {
    basePath: "/api/auth",
    autoRefresh: false,
};

export function sessionPayload(
    overrides: Partial<SessionPayload> = {},
): SessionPayload {
    return {
        user: financeUser,
        authorized: true,
        expiresAt: 1_900_000_000,
        csrfToken: "csrf-token-1",
        ...overrides,
    };
}

/** A session check that found no user. */
export function anonymousSession(): SessionPayload {
    return sessionPayload({
        user: null,
        authorized: false,
        expiresAt: null,
        csrfToken: null,
    });
}
```

### Helper: Provider Tree

The harness mounts `GlobalLoaderProvider` always, `I18nProvider` only when a loader is supplied, and `AuthProvider` only when a config is supplied. That opt-in shape matters: an always-mounted `I18nProvider` shows the global loader during its initial fetch and would race assertions about `visible`.

```tsx
// tests/helpers/providers.tsx
import type { ReactElement, ReactNode } from "react";
import { render, renderHook } from "@testing-library/react";
import {
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    type AuthConfig,
    type TranslationLoader,
} from "blendsdk/react";

export interface TestProvidersProps {
    children: ReactNode;
    /** Mounts an `<AuthProvider>` with this configuration. */
    auth?: AuthConfig;
    /** Mounts an `<I18nProvider>` with this loader. */
    loader?: TranslationLoader;
    /** Locale for the mounted `<I18nProvider>`. Default: `"en"`. */
    locale?: string;
    /** Forwarded to the mounted `<I18nProvider>`. */
    onMissingTranslation?: (key: string, locale: string) => void;
}

export function TestProviders({
    children,
    auth,
    loader,
    locale = "en",
    onMissingTranslation,
}: TestProvidersProps) {
    let tree: ReactNode = children;

    if (auth !== undefined) {
        tree = <AuthProvider config={auth}>{tree}</AuthProvider>;
    }

    if (loader !== undefined) {
        tree = (
            <I18nProvider
                loader={loader}
                defaultLocale={locale}
                onMissingTranslation={onMissingTranslation}
            >
                {tree}
            </I18nProvider>
        );
    }

    return <GlobalLoaderProvider>{tree}</GlobalLoaderProvider>;
}

export function renderWithProviders(
    ui: ReactElement,
    options: Omit<TestProvidersProps, "children"> = {},
) {
    return render(<TestProviders {...options}>{ui}</TestProviders>);
}

export function renderHookWithProviders<Result>(
    hook: () => Result,
    options: Omit<TestProvidersProps, "children"> = {},
) {
    return renderHook(hook, {
        wrapper: ({ children }: { children: ReactNode }) => (
            <TestProviders {...options}>{children}</TestProviders>
        ),
    });
}
```

### Helper: Error Boundary for Provider-Boundary Tests

Every provider hook throws a descriptive error when it is used outside its provider. React 19 reports render errors through the root's `onUncaughtError` rather than re-throwing them out of `render`, so assert the failure with a boundary instead of `expect(() => render(...)).toThrow()`. This pattern is stable across React versions.

```tsx
// tests/helpers/error-boundary.tsx
import { Component, type ReactNode } from "react";

export interface ErrorBoundaryProps {
    children: ReactNode;
    onError: (error: Error) => void;
}

interface ErrorBoundaryState {
    failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { failed: false };

    static getDerivedStateFromError(): ErrorBoundaryState {
        return { failed: true };
    }

    componentDidCatch(error: Error): void {
        this.props.onError(error);
    }

    render(): ReactNode {
        return this.state.failed ? <p>Caught by the error boundary</p> : this.props.children;
    }
}
```

---

## Unit Testing

### Rules That Apply to Every Test

1. **Never call a hook directly.** `useAuth()`, `useTranslations()`, `useGlobalLoader()`, and `useObjectState()` all read React state; call them through `renderHook` or a component.
2. **Prefer the real provider over a mocked hook.** The providers are pure client-side state machines; only `fetch` needs stubbing.
3. **Turn `autoRefresh` off** unless the test is about renewal. It removes the pending timer and makes the assertions deterministic.
4. **Assert URLs, not call counts.** `toContain("/api/auth/me")` survives a `StrictMode` render, an added pre-flight, or a retry; `toHaveBeenCalledTimes(1)` does not.
5. **`act` comes from React**, re-exported by RTL. `react-dom/test-utils` no longer exists in React 19.
6. **Flush the initial session check** with `waitFor` on `isLoading`; `renderHook` returns before effects and promises settle.

### Testing a Consumer Hook

`renderHook` mounts the hook inside the provider tree. The first render is synchronous, so `isLoading` is observable before the `/me` promise resolves.

```tsx
// tests/auth.test.tsx
import { describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";
import { installFetchMock, jsonResponse } from "./helpers/fetch.js";
import { sessionPayload, testAuthConfig } from "./helpers/session.js";

function createWrapper(config: AuthConfig = testAuthConfig) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <AuthProvider config={config}>{children}</AuthProvider>;
    };
}

describe("useAuth", () => {
    it("hydrates the session from the /me endpoint", async () => {
        const fetchMock = installFetchMock();
        fetchMock.mockResolvedValue(jsonResponse(sessionPayload()));

        const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });

        expect(result.current.isLoading).toBe(true);
        expect(result.current.authorized).toBe(false);
        expect(result.current.user).toBeNull();

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(result.current.user?.sub).toBe("user-42");
        expect(result.current.isAuthenticated).toBe(true);
        expect(result.current.authorized).toBe(true);
        expect(result.current.expiresAt).toBe(1_900_000_000);
        expect(result.current.csrfToken).toBe("csrf-token-1");
    });
});
```

### Testing Provider Boundaries

Use the error-boundary helper to assert the message a missing provider produces.

```tsx
// tests/provider-boundaries.test.tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useAuth, useGlobalLoader, useTranslations } from "blendsdk/react";
import { ErrorBoundary } from "./helpers/error-boundary.js";

function renderUnprovided(ui: React.ReactElement) {
    const errors: Error[] = [];
    render(
        <ErrorBoundary onError={(error) => errors.push(error)}>
            {ui}
        </ErrorBoundary>,
    );
    return errors;
}

function AuthConsumer() {
    const { isAuthenticated } = useAuth();
    return <p>{String(isAuthenticated)}</p>;
}

function LoaderConsumer() {
    const { visible } = useGlobalLoader();
    return <p>{String(visible)}</p>;
}

function TranslationsConsumer() {
    const { locale } = useTranslations();
    return <p>{locale}</p>;
}

describe("hooks outside their provider", () => {
    it("names the missing AuthProvider", () => {
        const errors = renderUnprovided(<AuthConsumer />);

        expect(errors).toHaveLength(1);
        expect(errors[0]?.message).toMatch(/AuthProvider/);
    });

    it("names the missing GlobalLoaderProvider", () => {
        const errors = renderUnprovided(<LoaderConsumer />);

        expect(errors[0]?.message).toMatch(/GlobalLoaderProvider/);
    });

    it("names the missing I18nProvider", () => {
        const errors = renderUnprovided(<TranslationsConsumer />);

        expect(errors[0]?.message).toMatch(/I18nProvider/);
    });
});
```

Suppress React's error log while these tests run by adding `vi.spyOn(console, "error").mockImplementation(() => {})` at the top of each test — `restoreMocks: true` restores it automatically.

### Testing Components That Read Context

Render the component inside its provider and drive it with `fireEvent`. Assertions go through `screen`, so they describe what a user sees rather than which state variable changed.

```tsx
// tests/global-loader.test.tsx
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";
import { renderWithProviders } from "./helpers/providers.js";

function LoaderControls() {
    const { showLoader, setText, visible } = useGlobalLoader();

    return (
        <div>
            <output data-testid="visible">{String(visible)}</output>
            <button
                type="button"
                onClick={() => {
                    setText("Loading data…");
                    showLoader(true);
                }}
            >
                Show with text
            </button>
            <button type="button" onClick={() => showLoader(true)}>
                Show without text
            </button>
            <button type="button" onClick={() => showLoader(false)}>
                Hide
            </button>
        </div>
    );
}

describe("useGlobalLoader", () => {
    it("starts hidden", () => {
        renderWithProviders(<LoaderControls />);

        expect(screen.getByTestId("visible")).toHaveTextContent("false");
    });

    it("shows the overlay together with its message", () => {
        renderWithProviders(<LoaderControls />);

        fireEvent.click(screen.getByRole("button", { name: "Show with text" }));

        expect(screen.getByTestId("visible")).toHaveTextContent("true");
        expect(screen.getByText("Loading data…")).toBeInTheDocument();
    });

    it("clears the message when the overlay is hidden", () => {
        renderWithProviders(<LoaderControls />);

        fireEvent.click(screen.getByRole("button", { name: "Show with text" }));
        fireEvent.click(screen.getByRole("button", { name: "Hide" }));
        fireEvent.click(screen.getByRole("button", { name: "Show without text" }));

        expect(screen.getByTestId("visible")).toHaveTextContent("true");
        expect(screen.queryByText("Loading data…")).not.toBeInTheDocument();
    });

    it("keeps the text renderer captured on mount", () => {
        function PlainText({ text }: { text: string; textColor: string }) {
            return <strong data-testid="plain-text">{text}</strong>;
        }

        function FancyText({ text }: { text: string; textColor: string }) {
            return <em data-testid="fancy-text">{text}</em>;
        }

        const { rerender } = render(
            <GlobalLoaderProvider config={{ textComponent: PlainText }}>
                <LoaderControls />
            </GlobalLoaderProvider>,
        );

        rerender(
            <GlobalLoaderProvider config={{ textComponent: FancyText }}>
                <LoaderControls />
            </GlobalLoaderProvider>,
        );

        fireEvent.click(screen.getByRole("button", { name: "Show with text" }));

        expect(screen.getByTestId("plain-text")).toHaveTextContent("Loading data…");
        expect(screen.queryByTestId("fancy-text")).not.toBeInTheDocument();
    });
});
```

The last test asserts the documented non-reactive config contract: a `rerender` with a different `config` does not replace the renderer captured on mount.

### Type-Level Tests

Types are part of the public contract, so they get their own files (`*.test-d.ts`). They contain no runtime behavior — `tsc --noEmit -p tsconfig.typecheck.json` is what fails when a signature regresses.

```typescript
// tests/use-object-state.test-d.ts
import { expectTypeOf } from "vitest";
import {
    useObjectState,
    type ObjectStateReset,
    type ObjectStateSetter,
    type UseObjectStateResult,
} from "blendsdk/react";

interface FormState {
    name: string;
    age: number;
    active: boolean;
}

declare const result: UseObjectStateResult<FormState>;

expectTypeOf(result[0]).toEqualTypeOf<FormState>();
expectTypeOf(result[1]).toEqualTypeOf<ObjectStateSetter<FormState>>();
expectTypeOf(result[2]).toEqualTypeOf<ObjectStateReset>();

declare const setState: ObjectStateSetter<FormState>;

setState({ name: "Bob" });
setState((previous) => ({ age: previous.age + 1 }));

// @ts-expect-error - `age` must be a number
setState({ age: "thirty" });

// @ts-expect-error - unknown keys are rejected for interface-shaped state
setState({ unknownKey: true });

/**
 * Compiles only when an interface state and `Partial<T>` patches are accepted.
 * Never executed; the type checker reads the declarations.
 */
function acceptsInterfaceState(): void {
    const [state, setState, reset] = useObjectState<FormState>(() => ({
        name: "Alice",
        age: 30,
        active: true,
    }));

    expectTypeOf(state).toEqualTypeOf<FormState>();
    setState({ name: "Bob" });
    setState((previous) => ({ age: previous.age + 1 }));
    reset();
}

void acceptsInterfaceState;
```

`@ts-expect-error` doubles as a negative test: if the restriction ever disappears, the directive itself becomes an error ("Unused '@ts-expect-error' directive") and the suite fails.

---

## Integration Testing

The integration layer for this package is *the composed provider tree plus a stubbed BFF*. There is no server to start: `react-router`'s `MemoryRouter` supplies routing, a `fetch` mock supplies the session, and a stub `TranslationLoader` supplies translations.

### End-to-End Authorization, Translation, and CSRF

The test below signs a user in through `/me`, renders a route behind `AuthGuard`, translates the page through `I18nProvider`, gates a control with `Can`, and verifies that the CSRF token from the session reaches the BFF on a state-changing call.

```tsx
// tests/app.integration.test.tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { AuthGuard, Can, useAuth, useTranslations } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";
import { installFetchMock, jsonResponse, requestedUrls, toUrl } from "./helpers/fetch.js";
import { renderWithProviders } from "./helpers/providers.js";
import { anonymousSession, sessionPayload, testAuthConfig } from "./helpers/session.js";

async function saveInvoice(csrfHeader: string, csrfToken: string | null): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (csrfToken !== null) {
        headers[csrfHeader] = csrfToken;
    }

    await fetch("/api/bff/invoices/42", {
        method: "PUT",
        headers,
        body: JSON.stringify({ status: "paid" }),
    });
}

function InvoicePage() {
    const { user, csrfToken, config, logout } = useAuth();
    const { t } = useTranslations();

    return (
        <section>
            <h1>{t("invoices.title")}</h1>
            <p>Signed in as {user?.sub}</p>
            <Can permission="invoice:write">
                <button
                    type="button"
                    onClick={() => void saveInvoice(config.csrfHeader, csrfToken)}
                >
                    {t("invoices.save")}
                </button>
            </Can>
            <button type="button" onClick={() => void logout()}>
                Sign out
            </button>
        </section>
    );
}

const translations: TranslationLoader = async () => ({
    "invoices.title": "Invoices",
    "invoices.save": "Save",
});

function renderApp() {
    return renderWithProviders(
        <MemoryRouter initialEntries={["/invoices"]}>
            <Routes>
                <Route path="/login" element={<p>Login page</p>} />
                <Route
                    path="/invoices"
                    element={
                        <AuthGuard>
                            <InvoicePage />
                        </AuthGuard>
                    }
                />
            </Routes>
        </MemoryRouter>,
        { auth: testAuthConfig, loader: translations },
    );
}

describe("invoice application", () => {
    it("renders a translated page and sends the session CSRF token", async () => {
        const fetchMock = installFetchMock();
        fetchMock.mockImplementation(async (input) => {
            const url = toUrl(input);
            if (url === "/api/auth/me") return jsonResponse(sessionPayload());
            if (url === "/api/bff/invoices/42") return jsonResponse({ ok: true });
            return jsonResponse({ message: "not found" }, 404);
        });

        renderApp();

        expect(await screen.findByText("Invoices")).toBeInTheDocument();
        expect(screen.getByText("Signed in as user-42")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
            expect(requestedUrls(fetchMock)).toContain("/api/bff/invoices/42");
        });

        const saveCall = fetchMock.mock.calls.find(
            ([input]) => toUrl(input) === "/api/bff/invoices/42",
        );
        const headers = new Headers(saveCall?.[1]?.headers);

        expect(headers.get("x-csrf-token")).toBe("csrf-token-1");
    });

    it("sends an anonymous visitor to the login route", async () => {
        const fetchMock = installFetchMock();
        fetchMock.mockResolvedValue(jsonResponse(anonymousSession()));

        renderApp();

        expect(await screen.findByText("Login page")).toBeInTheDocument();
        expect(screen.queryByText("Invoices")).not.toBeInTheDocument();
    });
});
```

`new Headers(saveCall?.[1]?.headers)` is the type-safe way to read the stubbed init: it accepts `HeadersInit | undefined` and normalizes the four shapes a caller may use.

### Loader Coordination Between I18n and GlobalLoader

`setLocale()` re-fetches through the loader and reports progress through the global loader. A deferred promise makes that window observable without timers: hold the second load open, assert the overlay, then resolve.

```tsx
// tests/locale-switch.integration.test.tsx
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useGlobalLoader, useTranslations } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";
import { renderWithProviders } from "./helpers/providers.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

function LocalePanel() {
    const { t, setLocale } = useTranslations();
    const { visible } = useGlobalLoader();

    return (
        <div>
            <output data-testid="loader-visible">{String(visible)}</output>
            <p>{t("greeting")}</p>
            <button type="button" onClick={() => setLocale("nl")}>
                Switch to Dutch
            </button>
        </div>
    );
}

describe("locale switching", () => {
    it("shows the global loader while the new catalog is in flight", async () => {
        const gate = deferred<Record<string, string>>();

        const loader = vi.fn<TranslationLoader>(async (locale) => {
            if (locale === "nl") {
                return gate.promise;
            }
            return { greeting: "Hello" };
        });

        renderWithProviders(<LocalePanel />, { loader });

        await screen.findByText("Hello");
        expect(screen.getByTestId("loader-visible")).toHaveTextContent("false");

        fireEvent.click(screen.getByRole("button", { name: "Switch to Dutch" }));

        await waitFor(() => {
            expect(screen.getByTestId("loader-visible")).toHaveTextContent("true");
        });

        await act(async () => {
            gate.resolve({ greeting: "Hallo" });
            await gate.promise;
        });

        await waitFor(() => {
            expect(screen.getByTestId("loader-visible")).toHaveTextContent("false");
        });
        expect(screen.getByText("Hallo")).toBeInTheDocument();
    });
});
```

### What jsdom Cannot Verify

| Behavior | Why it is out of reach | Where to test it |
|---|---|---|
| `login()` navigation to the BFF login endpoint | jsdom does not implement navigation; `window.location` is unforgeable | Playwright / Cypress against a real BFF |
| The HttpOnly session cookie itself | Not readable from JavaScript by design | Server-side tests of the BFF |
| OIDC callback handling | Owned by the BFF | BFF integration tests |
| Full redirect round-trip after `AuthGuard` | `MemoryRouter` simulates routing only | Browser test with a real router and server |

Assert the *computed* destination from `useAuth().config` in a unit test (`basePath` + `endpoints.login`), and cover the actual navigation in an end-to-end suite.

---

## Mocking & Stubbing

### Stubbing the BFF

`installFetchMock()` is the primary seam. Three arming styles cover every case:

```typescript
// One endpoint for the whole test
const fetchMock = installFetchMock();
fetchMock.mockResolvedValue(jsonResponse(sessionPayload()));

// Route by URL when a test touches several endpoints
fetchMock.mockImplementation(async (input) => {
    const url = toUrl(input);
    if (url === "/api/auth/me") return jsonResponse(sessionPayload());
    if (url === "/api/auth/refresh") return jsonResponse({ expiresAt: 1_900_000_900, csrfToken: "csrf-token-2" });
    return jsonResponse({ message: "not found" }, 404);
});

// Network failure: the provider falls back to the anonymous state
fetchMock.mockRejectedValue(new TypeError("fetch failed"));
```

Always pair `vi.stubGlobal` with `vi.unstubAllGlobals()` in `afterEach`; the shared setup file already does this. Do **not** assign `globalThis.fetch = mock` — it leaks across test files and cannot be restored centrally.

### Faking Timers for Session Renewal

With `autoRefresh` enabled the provider schedules a timeout `refreshLeadTime` seconds before `expiresAt`. Fake timers make that deterministic — with one important caveat: **Testing Library's `waitFor` does not detect Vitest's fake timers**, so it polls with a faked `setTimeout` and hangs. Advance the clock inside `act` instead, and never call `waitFor` while fake timers are installed.

```tsx
// tests/auth-refresh.test.tsx
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";
import { installFetchMock, jsonResponse, requestedUrls, toUrl } from "./helpers/fetch.js";
import { sessionPayload } from "./helpers/session.js";

const renewingConfig: AuthConfig = {
    basePath: "/api/auth",
    autoRefresh: true,
    refreshLeadTime: 60,
};

function wrapper({ children }: { children: ReactNode }) {
    return <AuthProvider config={renewingConfig}>{children}</AuthProvider>;
}

describe("automatic session renewal", () => {
    it("refreshes refreshLeadTime seconds before expiry", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

        const fetchMock = installFetchMock();
        const expiresAt = Math.floor(Date.now() / 1000) + 120;

        fetchMock.mockImplementation(async (input) => {
            const url = toUrl(input);
            if (url === "/api/auth/me") return jsonResponse(sessionPayload({ expiresAt }));
            if (url === "/api/auth/refresh") {
                return jsonResponse({
                    expiresAt: expiresAt + 3600,
                    csrfToken: "csrf-token-2",
                });
            }
            return jsonResponse({ message: "not found" }, 404);
        });

        renderHook(() => useAuth(), { wrapper });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(requestedUrls(fetchMock)).toEqual(["/api/auth/me"]);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });

        expect(requestedUrls(fetchMock)).toContain("/api/auth/refresh");

        vi.useRealTimers();
    });
});
```

`toFake: ["setTimeout", "clearTimeout", "Date"]` leaves `queueMicrotask` and `MessageChannel` real, which keeps React 19's scheduler working inside `act`. Faking `Date` is required because the provider derives the delay from the current time.

### Mocking `blendsdk/authz`

`useAuthorization()` delegates to `hasRole()` and `hasPermission()` from `blendsdk/authz`. In most tests the real implementation is better — it is pure and fast. Mock it when you need to simulate a server-side grant model the client library does not implement.

```tsx
// tests/authorization-mocked.test.tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { hasPermission, hasRole } from "blendsdk/authz";
import { Can } from "blendsdk/react";
import { installFetchMock, jsonResponse } from "./helpers/fetch.js";
import { renderWithProviders } from "./helpers/providers.js";
import { sessionPayload, testAuthConfig } from "./helpers/session.js";

vi.mock("blendsdk/authz", () => ({
    hasRole: vi.fn(() => false),
    hasPermission: vi.fn(() => false),
}));

function Toolbar() {
    return (
        <div>
            <Can permission="invoice:write">
                <button type="button">Edit invoice</button>
            </Can>
            <Can role="finance">
                <span>Finance badge</span>
            </Can>
        </div>
    );
}

describe("authorization with a forced deny", () => {
    beforeEach(() => {
        installFetchMock().mockResolvedValue(jsonResponse(sessionPayload()));
    });

    it("hides every guarded element when the evaluator denies", async () => {
        vi.mocked(hasPermission).mockReturnValue(false);
        vi.mocked(hasRole).mockReturnValue(false);

        renderWithProviders(<Toolbar />, { auth: testAuthConfig });

        expect(await screen.findByText("Finance badge")).toBeInTheDocument();
    });
});
```

Two details keep this honest. `vi.mock` is hoisted above the imports, so the factory must not close over module-scope variables — use `vi.hoisted()` when it must. And the factory replaces the module for *the test file's own imports*: the package's internal `import { hasPermission } from "blendsdk/authz"` resolves to the same module instance, so the mock does affect `useAuthorization()`.

### Stubbing the Translation Loader

The loader is plain dependency injection — a `vi.fn` typed as `TranslationLoader` gives you call assertions without any module mocking.

```typescript
import { vi } from "vitest";
import type { TranslationLoader } from "blendsdk/react";

const loader = vi.fn<TranslationLoader>(async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    return response.json();
});

// Assertions
expect(loader).toHaveBeenCalledWith("en");
expect(loader.mock.calls.filter(([locale]) => locale === "en")).toHaveLength(2);
```

### Stubbing `useAuth` in an Isolated Component Test

When only the consuming component is under test, replacing `useAuth` on the barrel is legitimate — as long as the rest of the module is returned unchanged, so providers and context singletons stay intact.

```typescript
// tests/helpers/auth-context.ts
import { AUTH_DEFAULTS } from "blendsdk/react";
import type { AuthContextValue, ResolvedAuthConfig } from "blendsdk/react";

export const resolvedAuthConfig: ResolvedAuthConfig = {
    basePath: "/api/auth",
    endpoints: { ...AUTH_DEFAULTS.endpoints },
    loginPath: AUTH_DEFAULTS.loginPath,
    notAuthorizedPath: AUTH_DEFAULTS.notAuthorizedPath,
    defaultReturnTo: AUTH_DEFAULTS.defaultReturnTo,
    autoRefresh: AUTH_DEFAULTS.autoRefresh,
    refreshLeadTime: AUTH_DEFAULTS.refreshLeadTime,
    csrfHeader: AUTH_DEFAULTS.csrfHeader,
};

export function authContextValue(
    overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
    return {
        user: null,
        isAuthenticated: false,
        isLoading: false,
        login: () => {},
        logout: async () => {},
        refresh: async () => false,
        expiresAt: null,
        authorized: false,
        csrfToken: null,
        config: resolvedAuthConfig,
        ...overrides,
    };
}
```

```tsx
// tests/profile-button.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAuth } from "blendsdk/react";
import { authContextValue } from "./helpers/auth-context.js";

vi.mock("blendsdk/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/react")>();
    return { ...actual, useAuth: vi.fn() };
});

function ProfileButton() {
    const { user, isAuthenticated, login, logout } = useAuth();

    if (!isAuthenticated) {
        return <button type="button" onClick={() => login()}>Sign in</button>;
    }

    return (
        <button type="button" onClick={() => void logout()}>
            Sign out ({user?.sub})
        </button>
    );
}

describe("ProfileButton", () => {
    it("renders the signed-in label from the auth context", () => {
        vi.mocked(useAuth).mockReturnValue(
            authContextValue({
                user: { sub: "user-42" },
                isAuthenticated: true,
            }),
        );

        render(<ProfileButton />);

        expect(
            screen.getByRole("button", { name: "Sign out (user-42)" }),
        ).toBeInTheDocument();
    });
});
```

### What Not to Mock

| Avoid | Why | Do instead |
|---|---|---|
| Replacing the whole `blendsdk/react` module with stubs | Destroys the shared context objects; providers no longer connect to their hooks | `importOriginal` and replace only the hook you need |
| Mocking `AuthContext` / `I18nContext` / `GlobalLoaderContext` | Internal modules, not part of the public surface | Render the real provider |
| `jest.mock("blendsdk/react", () => ({ useAuthorization: ... }))` to test `Can` | `Can` imports the internal hook module directly; a barrel mock never reaches it | Grant the role/permission through the `/me` fixture |
| `window.location` overrides for `login()` | `location` is unforgeable in jsdom | Assert `config` values; cover navigation end to end |
| `toHaveBeenCalledTimes(1)` on `fetch` | A `StrictMode` render or a retry doubles the call | `requestedUrls(mock)` + `toContain` |

---

## Test Patterns by Feature

### Global Loader

| Behavior | Assertion | Technique |
|---|---|---|
| Starts hidden | `visible` is `false` | Probe component with `data-testid` |
| `showLoader(true)` shows the overlay | `visible` true and the text is in the DOM | `fireEvent.click` + `screen.getByText` |
| `showLoader(false)` hides **and clears** text | text query returns `null` after re-show | `queryByText(...)` after a second `showLoader(true)` |
| `setText(null)` clears without hiding | no message, `visible` unchanged | Two clicks in one `act` |
| Config captured on mount | second `config` prop is ignored | `rerender` with a different `textComponent` |
| Outside the provider | error mentions `GlobalLoaderProvider` | `ErrorBoundary` helper |

The loader is a single boolean, not a counter: two overlapping workflows share one overlay. Test that by showing twice and hiding once, then asserting the overlay is gone.

### I18n

| Behavior | Assertion | Technique |
|---|---|---|
| Loads `defaultLocale` on mount | `loader` called with `"en"`; `ready` flips `false → true` | `vi.fn<TranslationLoader>()` + `findByText` |
| Renders translated copy | `screen.findByText("Dashboard")` | Component renders `t("dashboard.title")` |
| Interpolation | output contains the parameter value | `toHaveTextContent("Ada")` |
| `setLocale()` | new catalog rendered, `locale` updated, loader called with the new locale | `fireEvent.click` + `findByText` |
| `reloadTranslations()` | loader called twice for the same locale | `loader.mock.calls.filter(...)` |
| Missing key | `onMissingTranslation("missing.key", "en")` | Spy wired through `TestProviders` |

```tsx
// tests/i18n.test.tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useTranslations } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";
import { renderWithProviders } from "./helpers/providers.js";

// Placeholder syntax follows your `blendsdk/i18n` catalogs; the assertion
// only checks that the parameter value reaches the output.
const catalogs: Record<string, Record<string, string>> = {
    en: { "dashboard.title": "Dashboard", greeting: "Hello {{name}}" },
    nl: { "dashboard.title": "Overzicht", greeting: "Hallo {{name}}" },
};

function Dashboard() {
    const { t, locale, setLocale, reloadTranslations, ready } = useTranslations();

    return (
        <section>
            <output data-testid="ready">{String(ready)}</output>
            <output data-testid="locale">{locale}</output>
            <h1>{t("dashboard.title")}</h1>
            <p data-testid="greeting">{t("greeting", { name: "Ada" })}</p>
            <button type="button" onClick={() => setLocale("nl")}>
                Switch to Dutch
            </button>
            <button type="button" onClick={reloadTranslations}>
                Reload translations
            </button>
            <button type="button" onClick={() => t("missing.key")}>
                Translate a missing key
            </button>
        </section>
    );
}

function createLoader() {
    return vi.fn<TranslationLoader>(async (locale) => catalogs[locale] ?? {});
}

describe("useTranslations", () => {
    it("loads the default locale and reports readiness", async () => {
        const loader = createLoader();
        renderWithProviders(<Dashboard />, { loader });

        expect(loader).toHaveBeenCalledWith("en");
        expect(screen.getByTestId("ready")).toHaveTextContent("false");

        expect(await screen.findByText("Dashboard")).toBeInTheDocument();
        expect(screen.getByTestId("ready")).toHaveTextContent("true");
    });

    it("interpolates the supplied parameters", async () => {
        renderWithProviders(<Dashboard />, { loader: createLoader() });

        await screen.findByText("Dashboard");

        expect(screen.getByTestId("greeting")).toHaveTextContent("Ada");
    });

    it("reloads translations when the locale changes", async () => {
        const loader = createLoader();
        renderWithProviders(<Dashboard />, { loader });

        await screen.findByText("Dashboard");
        fireEvent.click(screen.getByRole("button", { name: "Switch to Dutch" }));

        expect(await screen.findByText("Overzicht")).toBeInTheDocument();
        expect(screen.getByTestId("locale")).toHaveTextContent("nl");
        expect(loader).toHaveBeenCalledWith("nl");
    });

    it("re-fetches the active locale on reload", async () => {
        const loader = createLoader();
        renderWithProviders(<Dashboard />, { loader });

        await screen.findByText("Dashboard");
        fireEvent.click(screen.getByRole("button", { name: "Reload translations" }));

        await waitFor(() => {
            expect(loader.mock.calls.filter(([locale]) => locale === "en")).toHaveLength(2);
        });
    });

    it("reports missing keys to onMissingTranslation", async () => {
        const onMissingTranslation = vi.fn<(key: string, locale: string) => void>();
        renderWithProviders(<Dashboard />, {
            loader: createLoader(),
            onMissingTranslation,
        });

        await screen.findByText("Dashboard");
        fireEvent.click(screen.getByRole("button", { name: "Translate a missing key" }));

        expect(onMissingTranslation).toHaveBeenCalledWith("missing.key", "en");
    });
});
```

`ready` is `false` while a fetch is in flight and the public context exposes no error field — assertion of loader failure belongs to your error boundary or logging layer, not to `useTranslations()`.

### Auth Session

| Behavior | Assertion | Technique |
|---|---|---|
| Initial check | `isLoading` `true`, `authorized` `false`, `user` `null`, then hydrated | `renderHook` + `waitFor` |
| Anonymous session | `isAuthenticated` `false` | `/me` payload with `user: null` |
| Signed-in but unauthorized | `isAuthenticated` `true`, `authorized` `false` | `/me` payload with `authorized: false` |
| Endpoint overrides | `/api/auth/session` requested | `endpoints: { me: "/session" }` |
| Defaults merged | `config.loginPath === AUTH_DEFAULTS.loginPath` | Compare against `AUTH_DEFAULTS` |
| `refresh()` result | `true` on 2xx, `false` on 401 | `let result; await act(async () => { result = await refresh(); })` |
| CSRF rotation | `csrfToken` updates after refresh | `/refresh` payload with a new token |
| `logout()` | `/logout` requested, `user` back to `null` | `act` + `requestedUrls` |
| Failed check | anonymous state, no crash | 500 response or rejected `fetch` |

```tsx
it("separates authentication from authorization", async () => {
    const fetchMock = installFetchMock();
    fetchMock.mockResolvedValue(
        jsonResponse(sessionPayload({ authorized: false })),
    );

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.authorized).toBe(false);
});

it("clears the session on logout", async () => {
    const fetchMock = installFetchMock();
    fetchMock.mockImplementation(async (input) => {
        const url = toUrl(input);
        if (url === "/api/auth/me") return jsonResponse(sessionPayload());
        if (url === "/api/auth/logout") return jsonResponse({ ok: true });
        return jsonResponse({ message: "not found" }, 404);
    });

    const { result } = renderHook(() => useAuth(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
        await result.current.logout();
    });

    expect(requestedUrls(fetchMock)).toContain("/api/auth/logout");
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.authorized).toBe(false);
});
```

Never assert on the session cookie: the browser cannot read it, and the test cannot either.

### Authorization: `useAuthorization`, `Can`, `RequireAccess`, `AuthGuard`

| Behavior | Assertion | Technique |
|---|---|---|
| Grants derived from the session user | `roles` / `permissions` arrays | `renderHookWithProviders` with an auth config |
| Duplicates removed | `["finance", "finance", "admin"]` → `["finance", "admin"]` | Fixture with repeated roles |
| Non-string entries dropped | `[42, "invoice:read"]` → `["invoice:read"]` | Fixture exploiting `AuthUser`'s index signature |
| Non-array grants fail closed | `roles: "finance"` → `roles: []`, `hasRole("finance")` false | Same fixture style |
| `Can` renders on grant | element present | `getByRole("button", ...)` |
| `Can` hides without grant | element absent, siblings still rendered | `queryBy...` returns `null` |
| `RequireAccess` redirect | unsigned grant lands on `notAuthorizedPath` | `MemoryRouter` + `findByText` |
| `AuthGuard` redirect | anonymous lands on `loginPath` | `MemoryRouter` + `findByText` |

```tsx
// tests/authorization.test.tsx
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { AuthGuard, Can, RequireAccess, useAuthorization } from "blendsdk/react";
import type { AuthUser } from "blendsdk/react";
import { installFetchMock, jsonResponse } from "./helpers/fetch.js";
import { renderHookWithProviders, renderWithProviders } from "./helpers/providers.js";
import { anonymousSession, sessionPayload, testAuthConfig } from "./helpers/session.js";

const messyUser: AuthUser = {
    sub: "user-7",
    roles: ["finance", "finance", 42],
    permissions: "invoice:write",
};

function guards() {
    return (
        <MemoryRouter initialEntries={["/invoices"]}>
            <Routes>
                <Route path="/login" element={<p>Login page</p>} />
                <Route
                    path="/invoices"
                    element={
                        <AuthGuard>
                            <RequireAccess permission="invoice:write">
                                <p>Invoice list</p>
                            </RequireAccess>
                        </AuthGuard>
                    }
                />
                <Route path="/not-authorized" element={<p>Not authorized</p>} />
            </Routes>
        </MemoryRouter>
    );
}

describe("useAuthorization", () => {
    it("drops non-string grants and de-duplicates roles", async () => {
        installFetchMock().mockResolvedValue(
            jsonResponse(sessionPayload({ user: messyUser })),
        );

        const { result } = renderHookWithProviders(() => useAuthorization(), {
            auth: testAuthConfig,
        });

        await screen.findByText("");

        expect(result.current.roles).toEqual(["finance"]);
        expect(result.current.permissions).toEqual([]);
        expect(result.current.hasRole("finance")).toBe(true);
        expect(result.current.can("invoice:write")).toBe(false);
    });
});

describe("guards", () => {
    it("redirects an anonymous visitor to the login route", async () => {
        installFetchMock().mockResolvedValue(jsonResponse(anonymousSession()));

        renderWithProviders(guards(), { auth: testAuthConfig });

        expect(await screen.findByText("Login page")).toBeInTheDocument();
    });

    it("redirects to the not-authorized route when the grant is missing", async () => {
        installFetchMock().mockResolvedValue(
            jsonResponse(
                sessionPayload({
                    user: { sub: "user-9", roles: [], permissions: ["invoice:read"] },
                }),
            ),
        );

        renderWithProviders(guards(), { auth: testAuthConfig });

        expect(await screen.findByText("Not authorized")).toBeInTheDocument();
        expect(screen.queryByText("Invoice list")).not.toBeInTheDocument();
    });

    it("renders the guarded page for a granted user", async () => {
        installFetchMock().mockResolvedValue(jsonResponse(sessionPayload()));

        renderWithProviders(guards(), { auth: testAuthConfig });

        expect(await screen.findByText("Invoice list")).toBeInTheDocument();
        expect(screen.queryByText("Not authorized")).not.toBeInTheDocument();
    });
});
```

`RequireAccess` and `AuthGuard` redirect *after* the session resolves, so always await them with `findBy*`. A synchronous `getByText` races the `/me` request.

### `useObjectState`

| Behavior | Assertion | Technique |
|---|---|---|
| Initial object from the factory | `result.current[0]` equals the factory output | `renderHook` |
| Patch merge | untouched keys survive | `act(() => setState({ name: "Bob" }))` |
| Functional updater | two updaters in one `act` compose (`30 → 32`) | Both calls inside one `act` |
| Reset | returns to the factory output as a **new** object | `toEqual` + `not.toBe` |
| Stable callbacks | `setState` and `reset` keep identity across renders | Capture references, compare after an update |
| Reset baseline | factory from the first render wins | `rerender` with a different `create` |
| Shallow merge | nested objects are replaced, not merged | Nested-state test |

```tsx
// tests/use-object-state.test.tsx
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useObjectState } from "blendsdk/react";

interface FormState {
    name: string;
    age: number;
    active: boolean;
}

function createInitial(): FormState {
    return { name: "Alice", age: 30, active: true };
}

describe("useObjectState", () => {
    it("merges a partial patch into the latest state", () => {
        const { result } = renderHook(() => useObjectState<FormState>(createInitial));

        act(() => result.current[1]({ name: "Bob" }));

        expect(result.current[0]).toEqual({ name: "Bob", age: 30, active: true });
    });

    it("composes consecutive functional updates in one event", () => {
        const { result } = renderHook(() => useObjectState<FormState>(createInitial));

        act(() => {
            result.current[1]((previous) => ({ age: previous.age + 1 }));
            result.current[1]((previous) => ({ age: previous.age + 1 }));
        });

        expect(result.current[0].age).toBe(32);
    });

    it("resets to a fresh object from the original factory", () => {
        const { result } = renderHook(() => useObjectState<FormState>(createInitial));
        const initial = result.current[0];

        act(() => result.current[1]({ name: "Bob" }));
        act(() => result.current[2]());

        expect(result.current[0]).toEqual(initial);
        expect(result.current[0]).not.toBe(initial);
    });

    it("keeps the setter and reset stable across renders", () => {
        const { result } = renderHook(() => useObjectState<FormState>(createInitial));
        const setState = result.current[1];
        const reset = result.current[2];

        act(() => setState({ name: "Bob" }));

        expect(result.current[1]).toBe(setState);
        expect(result.current[2]).toBe(reset);
    });

    it("resets with the factory captured on the first render", () => {
        const replacement = (): FormState => ({ name: "Bob", age: 1, active: false });

        const { result, rerender } = renderHook(
            ({ create }: { create: () => FormState }) => useObjectState<FormState>(create),
            { initialProps: { create: createInitial } },
        );

        rerender({ create: replacement });
        act(() => result.current[2]());

        expect(result.current[0]).toEqual({ name: "Alice", age: 30, active: true });
    });

    it("replaces nested objects instead of deep-merging them", () => {
        interface FilterState {
            filter: { status: string; page: number };
        }

        const { result } = renderHook(() =>
            useObjectState<FilterState>(() => ({
                filter: { status: "all", page: 1 },
            })),
        );

        act(() => result.current[1]({ filter: { status: "open", page: 1 } }));

        expect(result.current[0].filter).toEqual({ status: "open", page: 1 });
    });
});
```

Two habits keep these tests meaningful: always pass a **factory** (`() => ({ ... })`), never a shared object literal — `reset` re-invokes the factory and a shared literal would make the reset assertion vacuous — and always drive `setState` inside `act`, since it updates React state.

---

## Running the Suite

| Command | What it runs |
|---|---|
| `npm test` | `vitest run --reporter=verbose` **and** `tsc --noEmit -p tsconfig.typecheck.json` |
| `npm run test:fast` | Runtime tests only, skipping the type check |
| `npm run test:types` | Type-level tests only (`*.test-d.ts` and the source surface) |
| `npm run test:watch` | Watch mode for runtime tests |
| `npm run test:coverage` | Runtime tests with V8 coverage into `./coverage` |

The `--passWithNoTests` flag in the package scripts means a missing test file is not an error; keep at least one assertion per file so a silent collection failure cannot slip through.

---

## Checklist

- ✅ Import `describe`, `it`, `expect`, and `vi` from `vitest` — the project runs with `globals: false`.
- ✅ Register `@testing-library/jest-dom/vitest` and call `cleanup()` in `tests/setup.ts`.
- ✅ Stub `fetch` with `vi.stubGlobal` and reset it with `vi.unstubAllGlobals()`.
- ✅ Set `autoRefresh: false` in auth fixtures unless the test is about renewal.
- ✅ Assert request URLs with `requestedUrls(mock)` and `toContain`, not exact call counts.
- ✅ Await `isLoading === false` before asserting session values.
- ✅ Use `findBy*` for anything that appears after the `/me` request or a locale switch.
- ✅ Wrap state changes triggered outside React events in `act`; import it from `@testing-library/react`.
- ✅ Assert provider-boundary errors through an error boundary, not `expect(render).toThrow()`.
- ✅ Never use `waitFor` with fake timers installed — advance the clock with `vi.advanceTimersByTimeAsync` inside `act`.
- ✅ Keep the type-level tests in `*.test-d.ts` and include them in `tsconfig.typecheck.json`.
- ✅ Cover navigation, cookies, and OIDC callback handling in an end-to-end suite — jsdom cannot observe them.

---

# react Troubleshooting

Most failures in `blendsdk/react` fall into four groups: a hook called outside its provider, a BFF session contract that does not match what `AuthProvider` expects, authorization data that never reaches the principal, and state-model misuse in `useObjectState`. Each entry below gives the symptom, the cause, and a fix with a working example. Messages the package throws itself are quoted verbatim; messages from React, React Router, TypeScript, npm, and Node are labelled with their origin.

---

## Provider Context Errors

All three consumer hooks — `useAuth()`, `useGlobalLoader()`, and `useTranslations()` — read a context that defaults to `null` and throw a fixed error string when they find it. These strings are stable; search the console output for them verbatim.

### `useAuth() must be used within an <AuthProvider>`

**Error / Symptom**

```text
useAuth() must be used within an <AuthProvider>. Wrap your component tree with <AuthProvider> to use this hook.
```

**Cause**

`useAuth()` throws whenever `AuthContext` is `null`, which happens when the calling component is not a descendant of `<AuthProvider>`. Common triggers:

- The component is rendered outside the provider subtree — a sibling branch, a second `createRoot` root, or a header mounted above the provider.
- `<AuthProvider>` lives inside a route element, modal, or layout that unmounted while consumers stayed mounted.
- `useAuthorization()`, `AuthGuard`, `RequireAccess`, or `Can` is rendered outside the provider. `useAuthorization()` calls `useAuth()` internally, so the stack trace shows `useAuthorization` but the message is the `useAuth()` one.

**Fix**

1. Move `<AuthProvider>` above every consumer, normally directly under `<GlobalLoaderProvider>`.
2. Keep the provider outside routers, route elements, and branches that can unmount.
3. Confirm the failed component is not rendered through a separate React root.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionBadge() {
    const { isAuthenticated, user, login } = useAuth();

    if (!isAuthenticated || user === null) {
        return (
            <button type="button" onClick={() => login()}>
                Sign in
            </button>
        );
    }

    return <span>Signed in as {user.sub}</span>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionBadge />
        </AuthProvider>
    );
}
```

### `useGlobalLoader() must be used within a <GlobalLoaderProvider>`

**Error / Symptom**

```text
useGlobalLoader() must be used within a <GlobalLoaderProvider>. Wrap your component tree with <GlobalLoaderProvider> to use this hook.
```

**Cause**

The hook reads `GlobalLoaderContext`, which is `null` outside the provider. A frequent surprise: the failing component never calls the hook itself. `I18nProvider` reports translation fetches through the global loader, so mounting it without a `GlobalLoaderProvider` above it surfaces this message during the initial translation load.

**Fix**

1. Place `<GlobalLoaderProvider>` at the root, above `<I18nProvider>` and `<AuthProvider>`.
2. If the message appears while translations load, the missing provider is the cause — not the i18n configuration.

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

function Title() {
    const { t } = useTranslations();
    return <h1>{t("app.title")}</h1>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <Title />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

### `useTranslations() must be used within an <I18nProvider>`

**Error / Symptom**

```text
useTranslations() must be used within an <I18nProvider>. Wrap your component tree with <I18nProvider> to use this hook.
```

**Cause**

The component is outside the `I18nProvider` subtree. Typical cases: a global header or footer rendered above the provider, an error-boundary fallback that replaces the provider, or a component portalled into a tree whose React context chain does not include the provider.

**Fix**

Move the provider above every consumer. If a layout shell must be translated, wrap the shell itself, not only the routed content.

```tsx
import { I18nProvider, useTranslations } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request failed with ${response.status}`);
    }
    return response.json();
};

function Header() {
    const { t } = useTranslations();
    return <header>{t("app.title")}</header>;
}

export function App() {
    return (
        <I18nProvider loader={loadTranslations} defaultLocale="en">
            <Header />
        </I18nProvider>
    );
}
```

---

## Authentication Errors

### `authorized` is `false` for a signed-in user

**Error / Symptom**

No exception is thrown. `isAuthenticated === true` and `user !== null`, but `authorized === false`. `RequireAccess` redirects to `notAuthorizedPath`, and conditional UI renders the denied branch immediately after mount.

**Cause**

`isAuthenticated` and `authorized` answer different questions. `isAuthenticated` is derived from `user !== null`. `authorized` is the server's decision: it is `false` before the first `/me` check, when `/me` fails (wrong `basePath`, network error, 5xx), for a session the server marked `authorized: false`, and after logout. Rendering a decision before `isLoading` settles makes an unauthorized-looking flash.

**Fix**

1. Branch on `isLoading` first, then `isAuthenticated`, then `authorized`.
2. Inspect `GET {basePath}{endpoints.me}` in the Network panel — it must return 200 with the session payload.
3. Treat a post-check `authorized === false` as a server decision. Calling `refresh()` in a loop will not change it.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function ProtectedPanel() {
    const { isLoading, isAuthenticated, authorized, user, login } = useAuth();

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

    if (!authorized) {
        return <p>Signed in as {user.sub}, but the server has not authorized this session.</p>;
    }

    return <p>Welcome, {user.sub}.</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <ProtectedPanel />
        </AuthProvider>
    );
}
```

### `refresh()` resolves to `false` and the session still expires

**Error / Symptom**

`const ok = await refresh()` returns `false`. Later BFF calls return 401, and automatic renewal appears not to work.

**Cause**

The BFF rejected `POST {basePath}{endpoints.refresh}`: the session expired or was revoked, the cookie was not sent (cross-site cookie restrictions), or the resolved path is wrong (`endpoints.refresh` is relative to `basePath`). `refresh()` reports an HTTP failure as `false` rather than throwing, so nothing surfaces unless the caller checks the return value. Auto-refresh uses the same endpoint, so a wrong path also disables renewal silently.

**Fix**

1. Check the boolean result and fall back to `login(returnTo)`.
2. Verify the effective path via `useAuth().config.endpoints.refresh` and the Network panel.
3. For cross-origin BFFs, verify the session cookie is `Secure`/`SameSite`-compatible and that your own BFF fetches send `credentials: "include"`.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function KeepAliveButton() {
    const { refresh, login, config } = useAuth();

    const extendSession = async (): Promise<void> => {
        try {
            const refreshed = await refresh();
            if (!refreshed) {
                console.warn(
                    `Refresh at ${config.basePath}${config.endpoints.refresh} was rejected`,
                );
                login(window.location.pathname);
            }
        } catch (error) {
            console.error("Refresh request failed", error);
        }
    };

    return (
        <button type="button" onClick={() => void extendSession()}>
            Extend session
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <KeepAliveButton />
        </AuthProvider>
    );
}
```

### `403` on `POST`, `PUT`, or `DELETE` requests to the BFF

**Error / Symptom**

State-changing requests return `403 Forbidden` while `GET` requests succeed. Server logs mention a CSRF token mismatch.

**Cause**

- The `csrfToken` was not sent, or the header name does not match the server's (`config.csrfHeader`, default `x-csrf-token`).
- The request fired before the first `/me` completed, when `csrfToken` is still `null`.
- The token is a snapshot. When session-id rotation is enabled, the server can regenerate it; a token replaced by another browsing context is not observed until the next session check, so a request sent with the outdated token is rejected.

**Fix**

1. Send `config.csrfHeader: csrfToken` whenever the token is non-null, and include `credentials: "include"` on cross-origin calls.
2. On `403`, call `refresh()` and let the user repeat the action. Do not retry inside the same async closure — it would resend the captured, stale token.

```tsx
import { useState } from "react";
import { AuthProvider, useAuth } from "blendsdk/react";

function DeleteInvoiceButton() {
    const { csrfToken, config, isLoading, refresh } = useAuth();
    const [status, setStatus] = useState("");

    const remove = async (): Promise<void> => {
        const headers: Record<string, string> = {};
        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        try {
            const response = await fetch("/api/bff/invoices/42", {
                method: "DELETE",
                headers,
                credentials: "include",
            });

            if (response.status === 403) {
                const refreshed = await refresh();
                setStatus(
                    refreshed
                        ? "Session token rotated. Please retry the delete."
                        : "Session expired. Sign in again.",
                );
                return;
            }

            if (!response.ok) {
                throw new Error(`Delete failed with ${response.status}`);
            }
            setStatus("Deleted.");
        } catch (error) {
            console.error("Could not delete invoice", error);
            setStatus("Delete failed.");
        }
    };

    return (
        <div>
            <button type="button" onClick={() => void remove()} disabled={isLoading}>
                Delete invoice
            </button>
            {status !== "" && <p role="status">{status}</p>}
        </div>
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

### `login()` returns immediately and nothing navigates

**Error / Symptom**

`await login()` continues on the next line instantly. No state changes. In jsdom-based tests, the console shows `Error: Not implemented: navigation (except hash changes)`.

**Cause**

`login` has the signature `(returnTo?: string) => void`. It performs a full browser navigation to `${basePath}${endpoints.login}` and returns nothing. The provider does not set `user` — the BFF performs the OIDC flow, redirects back, and the next mount hydrates from `/me`. In jsdom, navigation is not implemented, so tests cannot observe it as a state change.

**Fix**

1. Call `login` from an event handler; never `await` it or write code that must run after the redirect.
2. Do not set local state after calling it — the page unloads.
3. In tests, assert that the hook function was invoked (or mock the navigation), and test session rendering separately against a mocked `/me`.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SignInButton() {
    const { login, isLoading } = useAuth();

    return (
        <button type="button" onClick={() => login("/dashboard")} disabled={isLoading}>
            Sign in
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth", defaultReturnTo: "/dashboard" }}>
            <SignInButton />
        </AuthProvider>
    );
}
```

### The screen goes blank after logout

**Error / Symptom**

After `await logout()`, the protected screen renders nothing; no error is shown.

**Cause**

`logout()` calls the BFF logout endpoint and clears local state (`user` becomes `null`). It does not provide a redirect target. A component that only renders content when `isAuthenticated` is true and has no fallback branch renders an empty screen; only `AuthGuard` redirects on its own.

**Fix**

Render an explicit signed-out state, or wrap the protected tree in `AuthGuard` so the redirect to `loginPath` happens automatically.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SignOutButton() {
    const { isAuthenticated, isLoading, logout } = useAuth();

    const handleLogout = async (): Promise<void> => {
        try {
            await logout();
        } catch (error) {
            console.error("Could not sign out", error);
        }
    };

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return <p>You are signed out.</p>;
    }

    return (
        <button type="button" onClick={() => void handleLogout()}>
            Sign out
        </button>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SignOutButton />
        </AuthProvider>
    );
}
```

---

## Authorization Errors

### `roles` and `permissions` are empty and `can()` always returns `false`

**Error / Symptom**

`useAuthorization()` returns empty arrays; `hasRole()` and `can()` return `false` for every input; `<Can>` renders nothing. No error is thrown anywhere.

**Cause**

The canonical grants must be `roles: string[]` and `permissions: string[]` on the session user returned by `/me`. `useAuthorization()` treats that data as untrusted: a non-array value becomes an empty list, non-string entries are dropped, duplicates are removed (first occurrence wins), and an anonymous user yields an empty principal. Identity-provider claim shapes — nested claims such as `realm_access.roles`, comma- or space-separated `scope` strings, or missing properties — therefore evaluate to no grants. This is deliberate fail-closed behavior, and it is silent.

**Fix**

1. Log the session user next to the evaluated grants to see which properties actually exist.
2. Translate provider claims into flat `roles` and `permissions` arrays on the BFF before the session user is returned from `/me`. This is a server-side mapping; the client cannot opt into other claim names.
3. Re-check after signing in again.

```tsx
import { AuthProvider, useAuth, useAuthorization } from "blendsdk/react";

function GrantsInspector() {
    const { user, isLoading } = useAuth();
    const { roles, permissions, hasRole, can } = useAuthorization();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    return (
        <section>
            <h2>Session user</h2>
            <pre>{JSON.stringify(user, null, 2)}</pre>
            <h2>Evaluated grants</h2>
            <p>roles: {roles.join(", ") || "(none)"}</p>
            <p>permissions: {permissions.join(", ") || "(none)"}</p>
            <p>hasRole("admin"): {String(hasRole("admin"))}</p>
            <p>can("invoice:write"): {String(can("invoice:write"))}</p>
        </section>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <GrantsInspector />
        </AuthProvider>
    );
}
```

### `useNavigate() may be used only in the context of a <Router> component.`

**Error / Symptom**

Origin: React Router. Rendering `AuthGuard` or `RequireAccess` throws the message above, or the app crashes as soon as a redirect is attempted.

**Cause**

Both guards redirect through React Router and therefore must render inside a router. They also redirect to `loginPath` / `notAuthorizedPath`, which must be real frontend routes; otherwise the redirect lands on a blank page.

**Fix**

1. Render the guarded tree inside `BrowserRouter` (or `RouterProvider`; tests can use `MemoryRouter`).
2. Define the login and not-authorized routes outside the guards, so the guards never guard their own redirect targets.

```tsx
import { BrowserRouter, Route, Routes } from "react-router";
import { AuthGuard, AuthProvider } from "blendsdk/react";

function Dashboard() {
    return <h1>Dashboard</h1>;
}

function LoginPage() {
    return <h1>Signing in…</h1>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth", loginPath: "/login" }}>
            <BrowserRouter>
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
            </BrowserRouter>
        </AuthProvider>
    );
}
```

---

## Internationalization Errors

### A raw key or blank text appears instead of a translation

**Error / Symptom**

The UI renders `dashboard.title` literally, empty text, or `onMissingTranslation` warnings appear in the console.

**Cause**

The catalog returned by the `TranslationLoader` does not contain the key for the active locale: a typo, a case mismatch (`Dashboard.Title` is not `dashboard.title`), nested objects where a flat key was expected, or stale server-side data. `onMissingTranslation` only reports the miss — it does not supply a fallback value.

**Fix**

1. Wire `onMissingTranslation` so misses are visible in development.
2. Compare the exact key passed to `t()` with the keys in the loader payload.
3. After updating translations on the server, call `reloadTranslations()` instead of reloading the page.

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

function DashboardTitle() {
    const { t, locale, reloadTranslations } = useTranslations();

    return (
        <section lang={locale}>
            <h1>{t("dashboard.title")}</h1>
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
                onMissingTranslation={(key, locale) => {
                    console.warn(`Missing translation "${key}" for "${locale}"`);
                }}
            >
                <DashboardTitle />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

### Translation loading fails and the application never becomes ready

**Error / Symptom**

`ready` stays `false`; the console shows an unhandled rejection originating from the loader; the UI stays on placeholders.

**Cause**

The `TranslationLoader` rejected — a non-2xx response, a network failure, or a parse error. `I18nContextValue` has no error field, so the failure cannot be read from context and the provider has no way to render it for you.

**Fix**

Catch inside the loader and return a resolved catalog (an empty map, or the last good catalog); surface the failure with your own application-level state or error boundary.

```tsx
import { GlobalLoaderProvider, I18nProvider, useTranslations } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    try {
        const response = await fetch(`/api/translations/${locale}`);
        if (!response.ok) {
            throw new Error(`Translation request failed with ${response.status}`);
        }
        return await response.json();
    } catch (error) {
        console.error(`Could not load translations for "${locale}"`, error);
        return {};
    }
};

function Title() {
    const { t, ready } = useTranslations();
    return <h1>{ready ? t("app.title") : "Loading…"}</h1>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <Title />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

### Changing `defaultLocale` does not change the active locale

**Error / Symptom**

A parent renders `<I18nProvider defaultLocale="en">`, later changes the prop to `"nl"`, and the content stays in English.

**Cause**

`defaultLocale` is the mount-time default only. The active locale is provider state and changes exclusively through `setLocale()`, which triggers a new loader call.

**Fix**

Keep `defaultLocale` static and switch languages through `setLocale()`:

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

function LocaleSwitcher() {
    const { locale, setLocale, t } = useTranslations();
    const next = locale === "en" ? "nl" : "en";

    return (
        <button type="button" onClick={() => setLocale(next)}>
            {t("language.switch")} ({next})
        </button>
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

---

## Global Loader Errors

### The overlay never disappears

**Error / Symptom**

The full-screen spinner stays visible; `visible` remains `true`; the application appears hung.

**Cause**

`showLoader(false)` was not reached on every path — an exception skipped it, an early return bypassed it, or the component that owns the hide logic unmounted. Remember that the loader is a single boolean, not a reference-counted stack: whoever calls `showLoader(false)` hides it for everyone, and a caller that shows it without ever hiding keeps it up indefinitely.

**Fix**

1. Own one workflow in one component with `try`/`finally`.
2. Always hide on the failure path.
3. Do not split show and hide across components that can unmount independently.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function ImportPanel() {
    const { showLoader, setText, visible } = useGlobalLoader();

    const runImport = async (): Promise<void> => {
        setText("Importing invoices…");
        showLoader(true);
        try {
            const response = await fetch("/api/bff/invoices/import", { method: "POST" });
            if (!response.ok) {
                throw new Error(`Import failed with ${response.status}`);
            }
        } catch (error) {
            console.error("Import failed", error);
        } finally {
            showLoader(false);
        }
    };

    return (
        <button type="button" onClick={() => void runImport()} disabled={visible}>
            Import
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <ImportPanel />
        </GlobalLoaderProvider>
    );
}
```

### `setText` has no visible effect

**Error / Symptom**

`setText("Saving…")` is called, but no message appears; or a message from a previous operation reappears.

**Cause**

The message only renders while the overlay is visible; `setText` does not show it. `showLoader(false)` hides the overlay and clears the text. Separately, `GlobalLoaderConfig` (including `textColor` and `textComponent`) is captured on mount and is not reactive, so changing the `config` prop does nothing.

**Fix**

1. Call `setText` and `showLoader(true)` together, in that order.
2. Rely on `showLoader(false)` to clear the text — no manual cleanup is needed.
3. To apply a different appearance, remount the provider with a `key`.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function RefreshButton() {
    const { showLoader, setText } = useGlobalLoader();

    const refreshData = async (): Promise<void> => {
        setText("Refreshing data…");
        showLoader(true);
        try {
            const response = await fetch("/api/bff/dashboard", { credentials: "include" });
            if (!response.ok) {
                throw new Error(`Refresh failed with ${response.status}`);
            }
        } catch (error) {
            console.error("Could not refresh dashboard", error);
        } finally {
            showLoader(false);
        }
    };

    return (
        <button type="button" onClick={() => void refreshData()}>
            Refresh
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider config={{ spinnerColor: "#25b09b", textColor: "#1f2933" }}>
            <RefreshButton />
        </GlobalLoaderProvider>
    );
}
```

### Calling `showLoader` during render causes an update loop

**Error / Symptom**

React logs `Warning: Cannot update a component (X) while rendering a different component (Y).`, followed by `Warning: Too many re-renders. React limits the number of renders to prevent an infinite loop.`

**Cause**

`showLoader` and `setText` update provider state. Calling them directly in the component body updates state during render, which schedules another render that calls them again.

**Fix**

Call the functions from an event handler or, for "show while this screen is mounted" behavior, inside an effect.

```tsx
import { useEffect } from "react";
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function Bootstrapper() {
    const { showLoader, setText } = useGlobalLoader();

    useEffect(() => {
        setText("Loading application…");
        showLoader(true);
    }, [showLoader, setText]);

    return null;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <Bootstrapper />
        </GlobalLoaderProvider>
    );
}
```

---

## Object State Errors

### Two updates in one handler collapse into one

**Error / Symptom**

`setState({ count: state.count + 1 })` called twice increments once; a second field update overwrites the first.

**Cause**

`state` is the value from the current render. Both patches are computed from the same snapshot before either is applied. The merge itself is functional (`{ ...previous, ...patch }`), but the patch computation is not.

**Fix**

Use the functional updater form so each patch is computed from the latest state:

```tsx
import { useObjectState } from "blendsdk/react";

interface CounterState {
    count: number;
    lastAction: string;
}

export function Counter() {
    const [state, setState, reset] = useObjectState<CounterState>(() => ({
        count: 0,
        lastAction: "none",
    }));

    const incrementTwice = (): void => {
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
                Count: {state.count} ({state.lastAction})
            </p>
            <button type="button" onClick={incrementTwice}>
                Increment twice
            </button>
            <button type="button" onClick={reset}>
                Reset
            </button>
        </div>
    );
}
```

### Array or class-instance state breaks at runtime

**Error / Symptom**

`TypeError: state.map is not a function`; an array turns into an object with numeric keys; methods on a class instance disappear.

**Cause**

The merge is `{ ...previous, ...patch }`. Spreading an array into an object literal produces an object with index keys, and spreading a class instance drops its prototype. `T extends object` accepts both, so the code compiles and only fails at runtime.

**Fix**

Keep arrays and class instances in `useState`, or store them inside an object property, which is the shape `useObjectState` is designed for.

```tsx
import { useState } from "react";
import { useObjectState } from "blendsdk/react";

interface TagState {
    tags: string[];
}

export function TagEditor() {
    const [tags, setTags] = useState<string[]>([]);
    const [state, setState] = useObjectState<TagState>(() => ({ tags: [] }));

    const addTag = (tag: string): void => {
        setTags((previous) => [...previous, tag]);
        setState((previous) => ({ tags: [...previous.tags, tag] }));
    };

    return (
        <div>
            <p>useState: {tags.join(", ") || "(empty)"}</p>
            <p>useObjectState: {state.tags.join(", ") || "(empty)"}</p>
            <button type="button" onClick={() => addTag("urgent")}>
                Add tag
            </button>
        </div>
    );
}
```

### Updating one nested field wipes its siblings

**Error / Symptom**

`setState({ paging: { page: 2 } })` erases `pageSize`; nested options reset on every partial update.

**Cause**

The merge is shallow. The top-level `paging` key is replaced wholesale, not deep-merged.

**Fix**

Spread each affected nesting level inside the patch, or flatten the state so every field is top-level.

```tsx
import { useObjectState } from "blendsdk/react";

interface FilterState {
    query: string;
    paging: {
        page: number;
        pageSize: number;
    };
}

export function InvoiceFilters() {
    const [filters, setFilters, reset] = useObjectState<FilterState>(() => ({
        query: "",
        paging: { page: 1, pageSize: 25 },
    }));

    const nextPage = (): void => {
        setFilters((previous) => ({
            paging: {
                ...previous.paging,
                page: previous.paging.page + 1,
            },
        }));
    };

    return (
        <div>
            <p>
                Page {filters.paging.page}, size {filters.paging.pageSize}
            </p>
            <button type="button" onClick={nextPage}>
                Next page
            </button>
            <button type="button" onClick={reset}>
                Reset
            </button>
        </div>
    );
}
```

### `reset()` restores values from the first render

**Error / Symptom**

After a prop changes, `reset()` restores defaults from the original render instead of the current ones.

**Cause**

`reset` calls the factory captured on the first render. Later `create` arguments are ignored by design. Related: in development StrictMode, React may invoke the factory twice, so a factory with side effects (a fetch, a counter increment, logging) runs more than once.

**Fix**

1. Keep the factory pure and free of changing props.
2. When the reset baseline must follow a prop, remount the component with a `key`.

```tsx
import { useObjectState } from "blendsdk/react";

interface SettingsState {
    pageSize: number;
    showArchived: boolean;
}

interface SettingsPanelProps {
    defaultPageSize: number;
}

function SettingsForm({ defaultPageSize }: SettingsPanelProps) {
    const [settings, setSettings, reset] = useObjectState<SettingsState>(() => ({
        pageSize: defaultPageSize,
        showArchived: false,
    }));

    return (
        <div>
            <p>
                Page size: {settings.pageSize}, archived:{" "}
                {settings.showArchived ? "shown" : "hidden"}
            </p>
            <button
                type="button"
                onClick={() => setSettings({ showArchived: !settings.showArchived })}
            >
                Toggle archived
            </button>
            <button type="button" onClick={reset}>
                Reset
            </button>
        </div>
    );
}

export function SettingsPanelHost({ defaultPageSize }: SettingsPanelProps) {
    return <SettingsForm key={defaultPageSize} defaultPageSize={defaultPageSize} />;
}
```

---

## TypeScript Compiler Errors

These are the recurring strict-mode errors from consuming the package. Error numbers are TypeScript's.

### TS1484: a type must be imported with `import type`

**Error / Symptom**

```text
'AuthConfig' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.
```

**Cause**

The project enables `verbatimModuleSyntax` (or `importsNotUsedAsValues`), and an interface was imported with a value import. Note that `AUTH_DEFAULTS` is a value and must stay a value import.

**Fix**

Split the imports:

```typescript
import type { AuthConfig } from "blendsdk/react";

export const authConfig: AuthConfig = {
    basePath: "/api/auth",
    refreshLeadTime: 30,
};
```

### TS2741: `basePath` is missing in `AuthConfig`

**Error / Symptom**

```text
Property 'basePath' is missing in type '{ loginPath: string; }' but required in type 'AuthConfig'.
```

**Cause**

`AuthConfig.basePath` is the only required property; every other value has a default in `AUTH_DEFAULTS`. Configuring only paths without the BFF base cannot be resolved.

**Fix**

Add `basePath`; keep the rest optional:

```typescript
import type { AuthConfig } from "blendsdk/react";

export const authConfig: AuthConfig = {
    basePath: "/api/auth",
    loginPath: "/sign-in",
    refreshLeadTime: 30,
};
```

### TS2344: `useObjectState` requires an object type

**Error / Symptom**

```text
Type 'number' does not satisfy the constraint 'object'.
```

**Cause**

The hook's type parameter is constrained to `T extends object` because the merge relies on object spreading. Primitives cannot be managed by it.

**Fix**

Wrap primitives in an object, or use `useState` for single values:

```tsx
import { useObjectState } from "blendsdk/react";

interface CounterState {
    count: number;
}

export function Counter() {
    const [state, setState] = useObjectState<CounterState>(() => ({ count: 0 }));

    return (
        <button
            type="button"
            onClick={() => setState((previous) => ({ count: previous.count + 1 }))}
        >
            Count: {state.count}
        </button>
    );
}
```

### TS2353: unknown property in a state patch

**Error / Symptom**

```text
Argument of type '{ ages: number; }' is not assignable to parameter of type 'Partial<FormState>'.
  Object literal may only specify known properties, and 'ages' does not exist in type 'Partial<FormState>'.
```

**Cause**

The setter accepts `Partial<T>`; an object literal with a misspelled or renamed key is rejected. This is a compile-time safeguard, not a runtime bug.

**Fix**

Use a declared key:

```tsx
import { useObjectState } from "blendsdk/react";

interface FormState {
    name: string;
    age: number;
}

export function AgeField() {
    const [state, setState] = useObjectState<FormState>(() => ({
        name: "Ada",
        age: 30,
    }));

    return (
        <button type="button" onClick={() => setState({ age: state.age + 1 })}>
            {state.name}: {state.age}
        </button>
    );
}
```

### TS18046: a claim on `AuthUser` is `unknown`

**Error / Symptom**

```text
'user.name' is of type 'unknown'.
```

**Cause**

`AuthUser` has a required `sub: string` and an index signature `[key: string]: unknown` for identity-provider claims. Every claim other than `sub` must be narrowed before use.

**Fix**

Narrow with `typeof` or a small type guard:

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function displayName(claims: Record<string, unknown>): string {
    const value = claims["name"];
    return typeof value === "string" ? value : "(unnamed)";
}

function ProfileName() {
    const { user } = useAuth();

    if (user === null) {
        return <p>Not signed in.</p>;
    }

    return <p>{displayName(user)}</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <ProfileName />
        </AuthProvider>
    );
}
```

### TS2345: `t()` parameters must be an object

**Error / Symptom**

```text
Argument of type 'string' is not assignable to parameter of type 'Record<string, unknown> | undefined'.
```

**Cause**

`TranslateFunction` has the signature `(key: string, params?: Record<string, unknown>) => string`. Interpolation values are passed as a named-parameter object, not positionally.

**Fix**

Pass an object; use `count` for plurals:

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

function Greeting() {
    const { t } = useTranslations();
    return (
        <div>
            <p>{t("dashboard.welcome", { name: "Ada" })}</p>
            <p>{t("cart.items", { count: 3 })}</p>
        </div>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <Greeting />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

## Module and Toolchain Errors

### `Cannot find package 'react-router'` or `Failed to resolve import "react-router"`

**Error / Symptom**

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'react-router' imported from .../dist/auth/auth-guard.js
```

Bundlers report a variation such as `Failed to resolve import "react-router" from ".../dist/auth/auth-guard.js"`.

**Cause**

`react-router` is an optional peer (`^7.0.0`) and is only needed by the redirecting guards, `AuthGuard` and `RequireAccess`. When those modules are loaded or rendered — or when your tooling statically resolves their imports — the missing package fails resolution. Hooks and `Can` do not need a router.

**Fix**

Install the peer alongside the umbrella package:

```bash
npm install blendsdk react react-dom react-router
```

### `Invalid hook call` or `Cannot read properties of null (reading 'useContext')`

**Error / Symptom**

```text
Warning: Invalid hook call. Hooks can only be called inside of the body of a function component.
TypeError: Cannot read properties of null (reading 'useContext')
```

**Cause**

More than one copy of React is loaded: the application resolves one `react`, the package resolves another. Other causes are mismatched `react` / `react-dom` versions or React 18 in the application while the package targets React 19.

**Fix**

1. List the resolved copies and look for duplicates.
2. Align `react` and `react-dom` on the same React 19 minor and dedupe the install (hoisting in a monorepo, or an override in the root `package.json`).

```bash
npm ls react react-dom
npm install blendsdk react@^19 react-dom@^19
```

### `ERESOLVE unable to resolve dependency tree` during install

**Error / Symptom**

npm aborts with `npm error ERESOLVE unable to resolve dependency tree`, referencing a peer `react@"^19.0.0"`.

**Cause**

The application is on React 18 (or a mixed 18/19 pair). `--legacy-peer-deps` silences the resolver but defers the failure to runtime: React 19 APIs used by hooks and context are unavailable in React 18.

**Fix**

Upgrade the application to React 19 rather than bypassing the peer check:

```bash
npm install blendsdk react@^19 react-dom@^19
```

### `ERR_PACKAGE_PATH_NOT_EXPORTED` for a `dist/` or `src/` import

**Error / Symptom**

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/index.js' is not defined by "exports" in .../node_modules/blendsdk/react/package.json
```

**Cause**

The package exports exactly one subpath, `"."`. Internal modules under `dist/` and `src/` are not reachable; importing them violates the published contract.

**Fix**

Import only public symbols from the package root:

```typescript
import { AUTH_DEFAULTS } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";

export const authConfig: AuthConfig = {
    basePath: "/api/auth",
    endpoints: {
        login: AUTH_DEFAULTS.endpoints.login,
        me: "/session",
    },
};
```

### `404 Not Found` when installing `blendsdk/react`

**Error / Symptom**

```text
npm error 404 Not Found - GET https://registry.npmjs.org/@blendsdk%2freact - Not found
```

**Cause**

`blendsdk/react` is a private workspace package. It is not published standalone; consumers receive it through the `blendsdk` umbrella package. A scope path like `blendsdk/react` is an import path, not an installable package.

**Fix**

Install the umbrella plus the peer packages:

```bash
npm install blendsdk react react-dom
```

---

## Debugging Strategies

### 1. Confirm the provider hierarchy first

1. Open React DevTools → Components and select the failing component.
2. Walk up the tree and confirm it contains `<GlobalLoaderProvider>`, `<I18nProvider>` (if translations are used), and `<AuthProvider>` (if auth or authorization is used).
3. Look for early returns or conditional rendering that could unmount a provider while consumers stay mounted.
4. Check for a second `createRoot` call — each root has its own context tree.
5. Re-run with React StrictMode enabled; StrictMode surfaces double-invocation problems (for example, a non-pure `useObjectState` factory) that are otherwise easy to miss.

### 2. Log the resolved auth state and configuration

Mount a debug component inside `AuthProvider` that prints the session flags and the resolved endpoints. Nearly every auth issue becomes obvious from this trace.

```tsx
import { useEffect } from "react";
import { AuthProvider, useAuth } from "blendsdk/react";

function AuthDebug() {
    const auth = useAuth();

    useEffect(() => {
        console.debug("[auth]", {
            isLoading: auth.isLoading,
            isAuthenticated: auth.isAuthenticated,
            authorized: auth.authorized,
            expiresAt: auth.expiresAt,
            hasCsrfToken: auth.csrfToken !== null,
            endpoints: auth.config.endpoints,
        });
    }, [
        auth.isLoading,
        auth.isAuthenticated,
        auth.authorized,
        auth.expiresAt,
        auth.csrfToken,
        auth.config.endpoints,
    ]);

    return null;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AuthDebug />
        </AuthProvider>
    );
}
```

### 3. Inspect the BFF traffic

1. Open the browser's Network panel and filter by `basePath` (for example `api/auth`).
2. Confirm `GET {basePath}{endpoints.me}` returns `200` on mount and contains the user, the authorization decision, the expiry timestamp, and the CSRF token.
3. Confirm the session cookie is present, `HttpOnly`, and sent with the request.
4. For a cross-origin BFF, check `credentials: "include"` on your own calls and `Access-Control-Allow-Credentials` on the server.
5. Replay the request outside the app using the Network panel's "Copy as cURL" to separate a server problem from a client problem.
6. Compare the request URL with `useAuth().config.endpoints` — a doubled prefix or a full URL inside an endpoint value shows up immediately.

### 4. Compare session claims with evaluated grants

1. Render the `GrantsInspector` from [Authorization Errors](#authorization-errors) or log the two values side by side.
2. Confirm `user.roles` and `user.permissions` exist, are arrays, and hold strings only.
3. Compare the required names with the evaluated result:

```typescript fragment
console.table({
    roles,
    permissions,
    isAdmin: hasRole("admin"),
    canWrite: can("invoice:write"),
});
```

4. If the session user holds the grants but the checks fail, the claim names or value types are wrong — fix the server mapping, not the component.

### 5. Trace translation loading

1. Wrap the loader with logging that shows the requested locale and the number of keys returned.
2. Watch the Network panel for the translation request URL; a 200 response containing an error envelope still counts as a successful load and produces an empty or wrong catalog.
3. Turn on `onMissingTranslation` and compare the reported keys with the payload.
4. Fix key casing and nesting on the server, then call `reloadTranslations()`.

```typescript
import type { TranslationLoader } from "blendsdk/react";

export const loggedLoader: TranslationLoader = async (locale) => {
    console.debug(`[i18n] loading "${locale}"`);
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translation request for "${locale}" failed with ${response.status}`);
    }
    const catalog = await response.json();
    console.debug(`[i18n] "${locale}" keys:`, Object.keys(catalog).length);
    return catalog;
};
```

### 6. Find the owner of the global loader

The loader is one boolean with no ownership stack, so debugging means finding every caller.

1. Search the codebase for `showLoader(` and list every call site.
2. Route calls through a logging helper in development:

```typescript fragment
const { showLoader } = useGlobalLoader();

const trace = (visible: boolean, owner: string): void => {
    console.debug(`[loader] ${owner} → ${visible}`);
    showLoader(visible);
};
```

3. Check whether any component that shows the loader can unmount before it hides it.
4. Check for a missing `finally` on the operation that shows it.

### 7. Reproduce in an isolated test harness

1. Render the component under test with the same provider stack the application uses.
2. Mock `fetch` with a payload captured from the real BFF (copy one `/me` response), rather than a guessed shape.
3. Wrap guards in `MemoryRouter`; add `BrowserRouter` only in integration tests.
4. Assert on rendered text, not on internal state.

```tsx
import type { ReactNode } from "react";
import { GlobalLoaderProvider, I18nProvider } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async () => ({});

export function TestProviders({ children }: { children: ReactNode }) {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                {children}
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

### 8. Narrow build and module-resolution failures

1. Inside the package workspace, run the package's own checks: `npm run test:types` (Vitest typecheck plus `tsc --noEmit`).
2. In the application, run a clean typecheck and read only the first error; later errors are often cascades.
3. Confirm a single React copy and a single router copy.
4. Confirm the application's bundler resolves ESM (`"type": "module"` packages, no CommonJS-only pipeline).

```bash
npx tsc --noEmit
npm ls react react-dom react-router
```

---

## Known Pitfalls

| Pitfall | Observable effect | Correct approach |
|---|---|---|
| Reading `authorized` as "signed in" | Denial flash during `isLoading`; wrong redirects | Check `isLoading`, then `isAuthenticated`, then `authorized` |
| Confusing `loginPath` with `endpoints.login` | Guard redirects to an API URL (404) or the login button hits an SPA route | `loginPath` is a frontend route; `endpoints.login` is a BFF path appended to `basePath` |
| Absolute endpoint overrides | Doubled prefix such as `/api/auth/api/auth/me` | Supply endpoint values relative to `basePath` |
| Treating `expiresAt` as milliseconds | Dates in 1970; timers fire immediately | Multiply the seconds value by 1000 |
| Reusing a captured `csrfToken` after refresh | Intermittent 403 after token rotation | Send the token from the current render; retry only after a fresh render |
| Assuming the loader is reference counted | One operation hides another's overlay; a missed hide leaves it up | One owner per workflow; `try`/`finally`; hide on every path |
| Expecting the loader `config` to be reactive | Appearance props change nothing | Remount the provider with a `key` |
| Expecting IdP claim shapes in `roles` and `permissions` | `can()` always false, silently | Map grants to flat string arrays on the BFF |
| Changing `defaultLocale` to switch language | Prop change ignored | Call `setLocale()` |
| Guarding the login or not-authorized route | Redirect loop | Keep both routes outside `AuthGuard` / `RequireAccess` |
| Assuming guards work without `react-router` | Module resolution or router-context errors | Install the peer and wrap the tree in a router; hooks and `Can` do not need it |
| Relying on a changing setter identity from v3 | Effects keyed on `setState` stop firing | Depend on the state values the effect reads; use functional updates |

### `expiresAt` is a Unix timestamp in seconds

`expiresAt` is seconds since the epoch, not milliseconds. Passing it straight to `new Date()` yields a date in January 1970, and timers computed with it fire immediately.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function ExpiryLabel() {
    const { expiresAt } = useAuth();
    const label =
        expiresAt === null ? "unknown" : new Date(expiresAt * 1000).toLocaleString();

    return <p>Session expires: {label}</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <ExpiryLabel />
        </AuthProvider>
    );
}
```

### Frontend routes and BFF endpoints are different namespaces

`loginPath` and `notAuthorizedPath` are frontend routes used by the guards. `endpoints.*` are BFF paths appended to `basePath`. Swapping them produces either a guard that redirects to an API URL (404) or a login button that navigates to a route that does not exist. Endpoint values are relative: `"/api/auth/me"` with `basePath: "/api/auth"` resolves to `/api/auth/api/auth/me`.

```typescript
import type { AuthConfig } from "blendsdk/react";

export const authConfig: AuthConfig = {
    basePath: "/api/auth",
    endpoints: {
        login: "/login",   // BFF: /api/auth/login
        me: "/session",    // BFF: /api/auth/session
    },
    loginPath: "/sign-in", // frontend route rendered by AuthGuard
    notAuthorizedPath: "/no-access",
};
```

### Guarding the redirect targets creates a loop

If `loginPath` resolves to a route that is itself wrapped in `AuthGuard`, an unauthenticated user is redirected to `/login`, which redirects to `/login`, and so on. The same applies to `notAuthorizedPath` under `RequireAccess`.

```tsx fragment
<Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/not-authorized" element={<NotAuthorizedPage />} />
    <Route path="/*" element={<AuthGuard><AppRoutes /></AuthGuard>} />
</Routes>
```

### `useObjectState` merge semantics

| Behavior | Consequence | Safe pattern |
|---|---|---|
| Shallow merge (`{ ...previous, ...patch }`) | Nested objects are replaced, not deep-merged | Spread each nesting level in the patch |
| Object spread only | Arrays and class instances break at runtime despite compiling | Keep them in `useState` or inside an object property |
| `undefined` patches | Keys stay present with the value `undefined`; `Object.keys` still lists them | Model absence with a union and an explicit `undefined`, or a sentinel value |
| Lazy factory | Runs on mount (twice under StrictMode in development) and again on `reset` | Keep the factory pure and free of side effects |
| Factory captured on first render | `reset()` ignores later `create` arguments | Remount with a `key` when the baseline must change |
| Stable `setState` and `reset` | Effects that depended on a changing setter identity no longer re-run | Depend on the state values the effect reads |

Under `exactOptionalPropertyTypes`, clearing an optional property with `setState({ note: undefined })` fails to compile with `Type 'undefined' is not assignable to type 'string'.` Declare the property as `note: string | undefined` in `T` when clearing it is intended.

### Stable callbacks change dependency arrays

`setState` and `reset` keep the same identity across renders. Code migrated from the v3 hook that listed `setState` in a dependency array to trigger work, while reading `state` without listing it, silently stops running.

```typescript fragment
// Before: relied on a new setter identity on every render
useEffect(() => {
    saveDraft(state);
}, [setState]);

// After: list the state the effect reads
useEffect(() => {
    saveDraft(state);
}, [state]);
```

### `onMissingTranslation` reports; it does not fall back

The callback receives `(key, locale)` and returns nothing. It cannot supply a default value, so a missing key still renders whatever `t()` produces for an unknown key. Treat the callback as diagnostics and fix the catalog.

### Guards need a router; `Can` and the hooks do not

`AuthGuard` and `RequireAccess` redirect and therefore require the optional `react-router` peer. `Can`, `useAuthorization()`, `useAuth()`, `useTranslations()`, `useGlobalLoader()`, and `useObjectState()` do not. If an application never renders the guards, the router dependency can be omitted.

### Install the umbrella, not the scope name

`blendsdk/react` is private and distributed through `blendsdk`. Installing `blendsdk/react` fails with a registry 404, and a subpath like `blendsdk/react` is an import path, not a package.

```bash
npm install blendsdk react react-dom
npm install blendsdk react react-dom react-router   # when guards are used
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
