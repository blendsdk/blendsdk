> **Package**: `blendsdk/react`

# react Core Concepts

`blendsdk/react` supplies application infrastructure, not visual components. Its public surface is organized around five concepts: a global loading overlay, asynchronous internationalization, a BFF-backed authentication session, declarative and imperative authorization, and object-shaped local state. Each concept follows the same shape: a provider owns state, a React context carries it, and a hook consumes it. With the exception of `useObjectState`, hooks throw a descriptive error when called outside their provider.

Two cross-cutting rules apply throughout. First, configuration is resolved with defaults: `AuthProvider` merges `AuthConfig` with `AUTH_DEFAULTS`, and `GlobalLoaderProvider` applies defaults to every omitted `GlobalLoaderConfig` property. Second, authorization is presentation only; the server remains the enforcement point.

| Concept | Public surface | Provider required | Notes |
|---|---|---|---|
| Global loader | `GlobalLoaderProvider`, `useGlobalLoader`, `GlobalLoaderConfig` | `GlobalLoaderProvider` | Configuration captured on mount |
| Internationalization | `I18nProvider`, `useTranslations`, `TranslationLoader`, `TranslateFunction` | `I18nProvider` | Uses the global loader; mount inside it |
| Authentication | `AuthProvider`, `useAuth`, `AUTH_DEFAULTS`, `AuthConfig`, `AuthUser`, `AuthContextValue`, `ResolvedAuthConfig` | `AuthProvider` | BFF/OIDC cookie session |
| Authorization | `useAuthorization`, `AuthGuard`, `RequireAccess`, `Can`, `UseAuthorizationResult` | `AuthProvider` | Redirecting gates need React Router |
| Object state | `useObjectState`, `ObjectStateSetter`, `ObjectStateReset`, `UseObjectStateResult` | None | Plain objects only |

See the Overview for the package map and provider composition order.

---

## Global Loader

### What It Is

The global loader is one application-wide overlay with a CSS-drawn spinner and an optional message. `GlobalLoaderProvider` owns its visibility and text; `useGlobalLoader()` lets any descendant show or hide it and set the message. It is deliberately not a data-fetching or progress-tracking system: it renders a blocking visual state and nothing else. Typical uses are route transitions, session bootstrap, and save operations that should prevent interaction.

### How It Works

- The provider holds a single `visible` boolean and an optional text string. When visible, it renders a full-screen overlay above the application subtree. The spinner is rendered with CSS; there is no CSS file to import.
- `showLoader(true)` displays the overlay. `showLoader(false)` hides it and clears the text. `setText("...")` changes the message but does not change visibility; pair it with `showLoader(true)`. Passing `null` or `""` clears the message.
- By default the message renders in a paragraph element with the configured `textColor`, `fontSize: 14px`, and `marginTop: 16px`. `textComponent` replaces that renderer.
- Configuration is captured on mount and is not reactive. Omitted properties use the defaults in the table below. To apply a different configuration, remount the provider.
- The loader is a single visibility flag, not a reference-counted stack. Overlapping operations share the same overlay; a `showLoader(false)` from one operation hides it for all. Coordinate ownership or wrap a workflow in one component that sets and clears the loader.
- `useGlobalLoader()` must be called inside `GlobalLoaderProvider`; outside, it throws an error that names the missing provider.

### Complete Example

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function SaveButton() {
    const { showLoader, setText, visible } = useGlobalLoader();

    const save = async (): Promise<void> => {
        setText("Saving changes…");
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
        <button type="button" onClick={() => void save()} disabled={visible}>
            {visible ? "Saving…" : "Save"}
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider
            config={{
                spinnerColor: "#25b09b",
                spinnerSize: 64,
                textColor: "#1f2933",
            }}
        >
            <SaveButton />
        </GlobalLoaderProvider>
    );
}
```

### Key Methods and Properties

**Hook return value**

| Name | Type/Signature | Description |
|---|---|---|
| `showLoader` | `(visible: boolean) => void` | Shows or hides the overlay. Passing `false` also clears the current text. |
| `setText` | `(text: string \| null) => void` | Sets the message below the spinner. `null` or `""` clears it. |
| `visible` | `boolean` | Current visibility of the overlay. Read-only. |

**Provider props and configuration**

| Name | Type/Signature | Description |
|---|---|---|
| `config` | `GlobalLoaderConfig \| undefined` | Optional appearance configuration. |
| `children` | `ReactNode` | Application subtree. |
| `spinnerColor` | `string` (default `"#888888"`) | CSS color of the spinner arc. |
| `spinnerWidth` | `number` (default `3`) | Spinner arc width (padding), in pixels. |
| `backgroundColor` | `string` (default `"#fafafa"`) | Overlay background color. |
| `spinnerSize` | `number` (default `50`) | Spinner diameter, in pixels. |
| `textColor` | `string` (default `"#888888"`) | CSS color of the message. |
| `zIndex` | `number` (default `999999`) | Overlay stacking order. |
| `textComponent` | `(props: { text: string; textColor: string }) => ReactElement` | Custom renderer for the message. |

> `GlobalLoaderConfig` is captured on mount and is not reactive. Remount the provider to apply a different configuration.

> The [Internationalization](#internationalization) provider uses this overlay while fetching translations. Mount `I18nProvider` inside `GlobalLoaderProvider` when translations are loaded at runtime.

---

## Internationalization

### What It Is

`I18nProvider` loads translations asynchronously and exposes them through `t()`. The application supplies a `TranslationLoader`; the provider calls it for the initial locale, wraps the returned flat key/value map into a `TranslationCatalog` from `blendsdk/i18n`, and makes the catalog available to descendants. This keeps translation storage pluggable: an API, a CDN, or a bundler can all back the loader.

### How It Works

- On mount, the provider loads `defaultLocale` (default `"en"`) by calling `loader(locale)`. The loader returns `Promise<Record<string, TranslationValue>>`; the provider converts it into the catalog used by `t()`.
- `t(key, params?)` translates a key. `params` supplies interpolation values; a `count` parameter selects plural forms. Missing keys are reported through `onMissingTranslation(key, locale)` when that callback is provided.
- `setLocale(locale)` switches the active locale and triggers a new loader call. `reloadTranslations()` re-fetches the current locale, for example after a server-side translation change. Translation fetches report progress through the global loader, so mount `I18nProvider` inside `GlobalLoaderProvider`.
- `ready` is `true` after a successful load. The public context does not expose an error field; surface loader failures through your own logging or an error boundary.
- `defaultLocale` is the mount-time default. Use `setLocale()` to change the active locale at runtime.
- `useTranslations()` must be called inside `I18nProvider`; outside, it throws a descriptive error.

### Complete Example

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

function Dashboard() {
    const { t, locale, setLocale, reloadTranslations, ready } = useTranslations();

    if (!ready) {
        return <p>Loading translations…</p>;
    }

    return (
        <section lang={locale}>
            <h1>{t("dashboard.title")}</h1>
            <p>{t("dashboard.welcome", { name: "Ada" })}</p>
            <p>{t("cart.items", { count: 3 })}</p>
            <button
                type="button"
                onClick={() => setLocale(locale === "en" ? "nl" : "en")}
            >
                {t("language.switch")}
            </button>
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
                <Dashboard />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

### Key Methods and Properties

**Hook return value**

| Name | Type/Signature | Description |
|---|---|---|
| `t` | `(key: string, params?: Record<string, unknown>) => string` | Translates a key with optional interpolation. A `count` parameter selects plural forms. |
| `locale` | `string` | Active locale. |
| `setLocale` | `(locale: string) => void` | Switches locale and re-fetches through the loader. |
| `reloadTranslations` | `() => void` | Re-fetches translations for the current locale. |
| `ready` | `boolean` | `true` when translations have loaded successfully. |

**Provider props and types**

| Name | Type/Signature | Description |
|---|---|---|
| `loader` | `TranslationLoader` | Required async source for translations. |
| `defaultLocale` | `string \| undefined` | Locale loaded on mount; default `"en"`. |
| `onMissingTranslation` | `(key: string, locale: string) => void \| undefined` | Called when a translation key is not found. |
| `children` | `ReactNode` | Application subtree. |
| `TranslationLoader` | `(locale: string) => Promise<Record<string, TranslationValue>>` | Loads a flat translation map for a locale. |
| `TranslateFunction` | `(key: string, params?: Record<string, unknown>) => string` | Signature of the `t` function. |

> `I18nProvider` depends on the global loader for fetch feedback. Compose it inside `GlobalLoaderProvider` as shown in [Global Loader](#global-loader). The `TranslationLoader` type is exported so application code can annotate its loader without importing the catalog internals.

---

## Authentication Session

### What It Is

`AuthProvider` manages an OIDC session established by a backend-for-frontend (BFF). The browser holds only an HttpOnly session cookie set by the BFF; it never stores access or refresh tokens. The provider hydrates the session from the BFF's `me` endpoint, exposes login/logout/refresh actions, schedules automatic renewal, and carries the per-session CSRF token. `useAuth()` is the consumer hook.

### How It Works

1. **Configuration resolution.** On mount, the provider merges the required `basePath` and optional `AuthConfig` values with `AUTH_DEFAULTS`. Endpoint paths are relative to `basePath`; the resolved object is available as `useAuth().config` with the `ResolvedAuthConfig` type.

2. **Session hydration.** The provider checks the session with `GET ${basePath}${endpoints.me}`. `isLoading` is `true` during the initial check. A successful response supplies the user, the authorization decision, the expiry timestamp, and the CSRF token.

3. **Authentication versus authorization.** `isAuthenticated` is derived from `user !== null`. `authorized` is the server's decision and is separate: it is `true` only when `me` returned a session that is not marked `authorized: false`. It is `false` before the first check, for anonymous or failed checks, for a session the application denied, and after logout. A signed-in but unauthorized session therefore has `isAuthenticated === true` and `authorized === false`.

4. **Actions.** `login(returnTo?)` navigates the browser to the BFF login endpoint; the BFF performs the OIDC authorization-code flow and sets the session cookie. It is a navigation, not an async API. `logout()` calls the BFF logout endpoint and clears local state. `refresh()` calls the BFF refresh endpoint and resolves to `true` on success and `false` on failure.

5. **Automatic renewal.** With `autoRefresh` enabled (the default), the provider schedules a refresh `refreshLeadTime` seconds before `expiresAt` (default 60). Manual `refresh()` remains available.

6. **CSRF.** The token returned by `me` or `refresh` is exposed as `csrfToken`; send it in the header named by `config.csrfHeader` (default `x-csrf-token`) on state-changing BFF calls. `csrfToken` is a snapshot: depending on server configuration, the token can be regenerated when session-id rotation is enabled. A token replaced by another browsing context is not observed here until the next session check, so a request made with the outdated token can be rejected with `403`.

7. **Hook contract.** `useAuth()` must be called inside `AuthProvider`; outside, it throws a descriptive error.

### Complete Example

```tsx
import { AUTH_DEFAULTS, AuthProvider, useAuth } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";

const authConfig: AuthConfig = {
    basePath: "/api/auth",
    endpoints: {
        ...AUTH_DEFAULTS.endpoints,
        me: "/session",
    },
    loginPath: "/sign-in",
    defaultReturnTo: "/dashboard",
    autoRefresh: true,
    refreshLeadTime: 30,
};

function SessionPanel() {
    const {
        user,
        isAuthenticated,
        isLoading,
        authorized,
        expiresAt,
        csrfToken,
        config,
        login,
        logout,
        refresh,
    } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated || user === null) {
        return (
            <button type="button" onClick={() => login("/invoices")}>
                Sign in
            </button>
        );
    }

    const handleRefresh = async (): Promise<void> => {
        try {
            const refreshed = await refresh();
            if (!refreshed) {
                console.warn("Session refresh failed");
            }
        } catch (error) {
            console.error("Could not refresh session", error);
        }
    };

    const handleDelete = async (): Promise<void> => {
        const headers: Record<string, string> = {};
        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        try {
            const response = await fetch("/api/bff/invoices/42", {
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
            <p>Authorized: {authorized ? "yes" : "no"}</p>
            <p>
                Expires:{" "}
                {expiresAt === null
                    ? "unknown"
                    : new Date(expiresAt * 1000).toLocaleString()}
            </p>
            <button type="button" onClick={() => void handleRefresh()}>
                Refresh session
            </button>
            {authorized ? (
                <button type="button" onClick={() => void handleDelete()}>
                    Delete invoice
                </button>
            ) : (
                <p>The server has not authorized this session for invoice changes.</p>
            )}
            <button type="button" onClick={() => void handleLogout()}>
                Sign out
            </button>
        </section>
    );
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <SessionPanel />
        </AuthProvider>
    );
}
```

### Key Methods and Properties

**`useAuth()` return value**

| Name | Type/Signature | Description |
|---|---|---|
| `user` | `AuthUser \| null` | Current user; `null` when anonymous. |
| `isAuthenticated` | `boolean` | `true` when `user !== null`. |
| `isLoading` | `boolean` | `true` during the initial session check. |
| `login` | `(returnTo?: string) => void` | Navigates to the BFF login endpoint, optionally with a return path. |
| `logout` | `() => Promise<void>` | Calls the BFF logout endpoint and clears local state. |
| `refresh` | `() => Promise<boolean>` | Refreshes the session; resolves to `true` on success. |
| `expiresAt` | `number \| null` | Unix timestamp in seconds when the session expires. |
| `authorized` | `boolean` | Server authorization decision for the session. See the note below. |
| `csrfToken` | `string \| null` | Per-session CSRF token; `null` when CSRF is not enforced. |
| `config` | `ResolvedAuthConfig` | Fully resolved configuration. |

**`AuthConfig` properties and defaults**

| Name | Type/Signature | Description |
|---|---|---|
| `basePath` | `string` | Required base path for all BFF auth endpoints. |
| `endpoints` | `{ login?: string; callback?: string; logout?: string; me?: string; refresh?: string }` | Overrides endpoint paths relative to `basePath`. |
| `loginPath` | `string` | Frontend login route used by `AuthGuard`; default `"/login"`. |
| `notAuthorizedPath` | `string` | Frontend route used by `RequireAccess` when a grant is missing; default `"/not-authorized"`. |
| `defaultReturnTo` | `string` | Frontend path to redirect after login; default `"/"`. |
| `autoRefresh` | `boolean` | Refresh before expiry; default `true`. |
| `refreshLeadTime` | `number` | Seconds before expiry to trigger refresh; default `60`. |
| `csrfHeader` | `string` | Header carrying the CSRF token; default `"x-csrf-token"`. |

**`AuthUser` shape**

| Name | Type/Signature | Description |
|---|---|---|
| `sub` | `string` | Required OIDC subject identifier. |
| `[key: string]` | `unknown` | Additional identity-provider claims, including `roles` and `permissions`. |

> `isAuthenticated` and `authorized` answer different questions. A session can be authenticated but not authorized. `authorized` is `false` before the first `me` check, for anonymous or failed checks, for a session the application denied, and after logout.

> `endpoints.login` is the BFF endpoint used by `login()`; `loginPath` is the frontend route used by `AuthGuard`. They are different paths and can have different values.

> Route-level authentication is provided by `AuthGuard`; see [Authorization Predicates and Gates](#authorization-predicates-and-gates).

---

## Authorization Predicates and Gates

### What It Is

Authorization answers two questions about the current session: does the user hold a role, and does the user hold a permission? `useAuthorization()` exposes the roles, permissions, and the `hasRole()` / `can()` predicates. `AuthGuard`, `RequireAccess`, and `Can` apply the same checks declaratively. The layer is intentionally presentation-only: the server is the authority, and client-side checks only decide what to render.

### How It Works

- `useAuthorization()` reads the user from `useAuth()`, so it must be used inside `AuthProvider`.
- Grants come from the session user's `roles` and `permissions` properties. These are the canonical grants the server stored on the session user after translating the provider identity. The hook treats the claims as untrusted runtime data: a non-array value becomes an empty list, non-string entries are ignored, and duplicates are removed with the first occurrence winning. An anonymous user or a malformed grants object produces an empty principal, so requirements fail closed instead of throwing.
- The result is memoized on the user. `roles` and `permissions` are readonly arrays, and `hasRole`/`can` are stable while the user object is unchanged. Evaluation delegates to `hasRole()` and `hasPermission()` from `blendsdk/authz`.
- Declarative gates: `AuthGuard` gates authentication and redirects unauthenticated users to `config.loginPath`; `RequireAccess` gates a required grant and redirects signed-in users without it to `config.notAuthorizedPath`; `Can` conditionally renders a UI fragment without redirecting. `AuthGuard` and `RequireAccess` perform redirects and therefore need the optional `react-router` peer. `Can` and the hook do not.
- Server authority: a hidden button is a convenience, never a security boundary. The BFF must enforce the same grants on every state-changing and data-reading endpoint.

### Complete Example

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

### Key Methods and Properties

**`useAuthorization()` return value**

| Name | Type/Signature | Description |
|---|---|---|
| `roles` | `readonly string[]` | Roles held by the current user. |
| `permissions` | `readonly string[]` | Permissions held by the current user. |
| `hasRole` | `(role: string) => boolean` | Reports whether the user holds a role. |
| `can` | `(permission: string) => boolean` | Reports whether the user holds a permission. |

**Principal derivation**

| Source | Rule |
|---|---|
| `user.roles` | Must be an array. Non-array values become an empty list; non-string entries are ignored; duplicates are removed with the first occurrence winning. |
| `user.permissions` | Same rules as `user.roles`. |
| Anonymous user | Empty principal; every check returns `false`. |
| Malformed grants | Empty principal; checks fail closed instead of throwing. |

**Declarative gates**

| Component | Behavior | Router required |
|---|---|---|
| `AuthGuard` | Gates authentication; redirects unauthenticated users to `config.loginPath`. | Yes |
| `RequireAccess` | Gates a required grant; redirects signed-in users without it to `config.notAuthorizedPath`. | Yes |
| `Can` | Conditionally renders children when the required grant is held. | No |

> A user can be authenticated and still unauthorized: `isAuthenticated` is about having a session, while `authorized` is the server's decision. `useAuthorization()` reads the grants on that session; it does not change the server's decision.

---

## Object-Shaped Local State

### What It Is

`useObjectState` manages one plain object as local component state. It is aimed at clusters of related fields — forms, filter panels, editors — where separate `useState` calls would be noisy. The hook returns the object, a patch-oriented setter, and a reset function. It is provider-independent and does not participate in authentication, internationalization, or the global loader.

### How It Works

- `const [state, setState, reset] = useObjectState<T>(() => initial)`. The factory runs lazily on mount. `reset` calls the original factory again and stores a fresh object, so the reset baseline is not the initial object reference.
- `setState` accepts either a partial patch or `(previous) => patch`. It applies the patch with a shallow spread inside React's functional updater: `{ ...previous, ...patch }`. Consecutive updates in the same event therefore build on the latest state, not on a stale render value.
- The setter and reset callbacks have stable identities across renders. Code that previously listed `setState` in a dependency array and read `state` without listing it should add the state values it reads, or use the functional updater form.
- The contract is plain objects. Arrays, class instances, and function values are outside the contract because object spreading drops prototypes and array behavior. Nested objects are replaced, not deep-merged. Setting a property to `undefined` leaves the key present.
- `T` can be an interface; the hook does not require an index signature, and `Partial<T>` patches are checked against the declared shape.
- The factory must be pure and return a new plain object on every call. React StrictMode may invoke it twice in development, and `reset` invokes it again. `reset` uses the factory from the first render; changing the `create` argument later does not change the reset baseline.

### Complete Example

```tsx
import { useObjectState } from "blendsdk/react";

interface FilterState {
    query: string;
    status: "all" | "open" | "closed";
    page: number;
}

function isStatus(value: string): value is FilterState["status"] {
    return value === "all" || value === "open" || value === "closed";
}

export function InvoiceFilters() {
    const [filters, setFilters, resetFilters] = useObjectState<FilterState>(() => ({
        query: "",
        status: "all",
        page: 1,
    }));

    const nextPage = (): void => {
        setFilters((previous) => ({ page: previous.page + 1 }));
    };

    return (
        <form>
            <label>
                Query
                <input
                    value={filters.query}
                    onChange={(event) =>
                        setFilters({ query: event.target.value, page: 1 })
                    }
                />
            </label>
            <label>
                Status
                <select
                    value={filters.status}
                    onChange={(event) => {
                        const value = event.target.value;
                        if (isStatus(value)) {
                            setFilters({ status: value, page: 1 });
                        }
                    }}
                >
                    <option value="all">All</option>
                    <option value="open">Open</option>
                    <option value="closed">Closed</option>
                </select>
            </label>
            <button type="button" onClick={nextPage}>
                Next page ({filters.page})
            </button>
            <button type="button" onClick={resetFilters}>
                Reset
            </button>
        </form>
    );
}
```

### Key Methods and Properties

**Parameters and return value**

| Name | Type/Signature | Description |
|---|---|---|
| `create` | `() => T` | Lazy factory for the initial object. Must return a new plain object on every call. |
| `state` | `T` | Current object. |
| `setState` | `(update: Partial<T> \| ((previous: T) => Partial<T>)) => void` | Shallow-merges a patch into the latest state. |
| `reset` | `() => void` | Re-runs the original factory and stores a fresh object. |
| `UseObjectStateResult<T>` | `[T, ObjectStateSetter<T>, ObjectStateReset]` | Tuple returned by the hook. |

**Contract**

| Contract | Behavior |
|---|---|
| State shape | Plain objects only. Arrays, class instances, and function values are unsupported. |
| Merge depth | Shallow. Nested objects are replaced, not deep-merged. |
| `undefined` values | Setting a property to `undefined` leaves the key present. |
| Factory | Must be pure and return a new plain object each call. React StrictMode may invoke it twice in development. |
| Callback identity | `setState` and `reset` are stable across renders. |
| Reset baseline | The factory captured on the first render; a later `create` argument does not replace it. |

> `useObjectState` does not delete keys. To represent an absent value, make the property optional in `T` and set it to `undefined`; the key remains present with the value `undefined`.

> Compatibility note: the setter and reset are stable across renders. If existing code listed `setState` in a dependency array and read `state` without listing it, add the state values it reads or use the functional updater form. Relying on a changing setter identity is not supported.

---

# react Basic Usage

`blendsdk/react` provides the React application layer for BlendSDK: BFF-backed authentication, authorization predicates, asynchronous internationalization, a global loading overlay, and object-shaped local state. This guide starts with installation, then introduces each module through progressively larger examples.

---

## Installation

`blendsdk/react` is a private workspace package consumed through the `blendsdk` umbrella. Install the umbrella plus the required React 19 peers; keep importing from `blendsdk/react` in source files.

| Package manager | Command |
|---|---|
| npm | `npm install blendsdk react react-dom` |
| yarn | `yarn add blendsdk react react-dom` |
| pnpm | `pnpm add blendsdk react react-dom` |

`react` and `react-dom` are required peers. The redirecting guards (`AuthGuard` and `RequireAccess`) also need the optional `react-router` peer:

```bash
npm install blendsdk react react-dom react-router
```

For yarn or pnpm, use the same package list with `yarn add` or `pnpm add`.

---

## Quick Start

The smallest self-contained setup uses the global loader. Wrap a subtree with `GlobalLoaderProvider`, then consume the loader from a descendant with `useGlobalLoader()`.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function LoaderButton() {
    const { showLoader, setText } = useGlobalLoader();
    const run = (): void => {
        setText("Loading…");
        showLoader(true);
        window.setTimeout(() => showLoader(false), 1200);
    };

    return <button type="button" onClick={run}>Load for 1.2 seconds</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <LoaderButton />
        </GlobalLoaderProvider>
    );
}
```

Clicking the button displays the full-screen overlay for 1.2 seconds. `showLoader(false)` hides it and clears the message.

---

## Fundamentals

Provider-backed features follow the same pattern: a provider owns state, a React context carries it, and a hook exposes it. The usual composition order is `GlobalLoaderProvider` outermost, `I18nProvider` inside it, and `AuthProvider` wherever session state is needed. Each subsection below introduces one module.

### Global Loader

The global loader is one application-wide overlay with a CSS spinner and optional text. Start with `showLoader(true)` and `showLoader(false)`; `setText` adds context while visible.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function SaveButton() {
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
            Save invoice
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider
            config={{
                spinnerColor: "#25b09b",
                spinnerSize: 64,
                textColor: "#1f2933",
            }}
        >
            <SaveButton />
        </GlobalLoaderProvider>
    );
}
```

- `showLoader(false)` hides the overlay and clears the current text. `setText(null)` or `setText("")` clears only the text.
- The loader is a single visibility flag, not a reference-counted stack. Overlapping operations share the same overlay; one `showLoader(false)` hides it for all.
- Configuration is captured on mount. Remount the provider to apply a different `GlobalLoaderConfig`.
- `useGlobalLoader()` must be called inside `GlobalLoaderProvider`; outside, it throws a descriptive error.

### Internationalization

`I18nProvider` loads translations asynchronously through an application-supplied `TranslationLoader`. The provider calls the loader for the default locale on mount, then exposes `t()`, `locale`, `setLocale()`, `reloadTranslations()`, and `ready`.

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

function Greeting() {
    const { t, locale, setLocale, ready } = useTranslations();

    if (!ready) {
        return <p>Loading translations…</p>;
    }

    return (
        <section lang={locale}>
            <h1>{t("greeting.title")}</h1>
            <p>{t("greeting.body", { name: "Ada" })}</p>
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
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <Greeting />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

- `t(key, params?)` supports interpolation; a `count` parameter selects plural forms.
- `setLocale()` switches the active locale and triggers a new loader call. `reloadTranslations()` re-fetches the current locale.
- `ready` is `false` until translations load successfully.
- Mount `I18nProvider` inside `GlobalLoaderProvider`: translation fetches report progress through the global loader.
- `onMissingTranslation(key, locale)` reports unknown keys when provided.
- `useTranslations()` must be called inside `I18nProvider`; outside, it throws a descriptive error.

### Authentication

`AuthProvider` manages an OIDC session established by a backend-for-frontend. The browser holds only the BFF's HttpOnly session cookie; access and refresh tokens never reach browser code. The provider hydrates the session from the `me` endpoint and exposes actions through `useAuth()`.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionPanel() {
    const { user, isAuthenticated, isLoading, login, logout } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return (
            <button type="button" onClick={() => login("/invoices")}>
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
            <p>Signed in as {user?.sub}</p>
            <button type="button" onClick={() => void handleLogout()}>
                Sign out
            </button>
        </section>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionPanel />
        </AuthProvider>
    );
}
```

- `isLoading` is `true` during the initial `me` check. `isAuthenticated` is derived from `user !== null`.
- `login(returnTo?)` navigates the browser to the BFF login endpoint. It is a navigation, not an async function.
- `logout()` calls the BFF logout endpoint and clears local state.
- `isAuthenticated` and `authorized` answer different questions: a signed-in session can still be unauthorized by the server.
- `refresh()` renews the session and resolves to `true` on success. With `autoRefresh` enabled, renewal is scheduled before `expiresAt`.
- `csrfToken` and `config.csrfHeader` support state-changing BFF calls; send the token in the configured header.
- `useAuth()` must be called inside `AuthProvider`; outside, it throws a descriptive error.

### Authorization

Authorization reads the canonical grants stored on the session user. `useAuthorization()` exposes `roles`, `permissions`, `hasRole()`, and `can()`; it must be used inside `AuthProvider`.

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

- Grants are read from the session user's `roles` and `permissions` properties. Malformed values, non-string entries, and anonymous users produce an empty principal, so checks fail closed instead of throwing.
- The result is memoized on the user; `hasRole` and `can` stay stable while the user object is unchanged.
- Authorization is presentation only. A hidden button is a convenience, never a security boundary; the server must enforce the same grants.
- The package also exports `Can` for conditional rendering and `AuthGuard` / `RequireAccess` for route-level redirects. The redirecting guards require the optional `react-router` peer.

### Object State

`useObjectState` manages one plain object as local component state. It returns the current object, a patch-oriented setter, and a reset function. No provider is required.

```tsx
import { useObjectState } from "blendsdk/react";

interface ProfileState {
    name: string;
    age: number;
}

export function ProfileForm() {
    const [profile, setProfile, resetProfile] = useObjectState<ProfileState>(() => ({
        name: "",
        age: 0,
    }));

    return (
        <div>
            <label>
                Name{" "}
                <input
                    value={profile.name}
                    onChange={(event) => setProfile({ name: event.target.value })}
                />
            </label>
            <button
                type="button"
                onClick={() => setProfile((previous) => ({ age: previous.age + 1 }))}
            >
                Age: {profile.age}
            </button>
            <button type="button" onClick={resetProfile}>
                Reset
            </button>
        </div>
    );
}
```

- The factory runs lazily on mount. `reset` calls the original factory again and stores a fresh object.
- `setProfile({ name: "..." })` shallow-merges a partial patch into the latest state.
- The functional form, `setProfile((previous) => ({ age: previous.age + 1 }))`, builds on the latest state even when several updates happen in one event.
- The contract is plain objects. Arrays, class instances, and function values are unsupported; nested objects are replaced, not deep-merged.
- `setProfile` and `resetProfile` keep the same identity across renders.

---

## Configuration

Providers merge omitted values with defaults. `AUTH_DEFAULTS` is exported for reading the auth defaults; the global loader captures its configuration on mount, and the i18n provider uses `defaultLocale` as its mount-time locale.

A common auth override uses `AUTH_DEFAULTS` to keep the default endpoints while replacing one path:

```tsx
import { AUTH_DEFAULTS, AuthProvider } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";
import type { ReactNode } from "react";

const authConfig: AuthConfig = {
    basePath: "/api/auth",
    endpoints: {
        ...AUTH_DEFAULTS.endpoints,
        me: "/session",
    },
    loginPath: "/sign-in",
    defaultReturnTo: "/dashboard",
    refreshLeadTime: 30,
};

export function AuthRoot({ children }: { children: ReactNode }) {
    return <AuthProvider config={authConfig}>{children}</AuthProvider>;
}
```

### Auth Configuration

| Name | Type | Default | Description |
|---|---|---|---|
| `basePath` | `string` | Required | Base path for all BFF auth endpoints, such as `/api/auth`. |
| `endpoints` | `{ login?: string; callback?: string; logout?: string; me?: string; refresh?: string }` | `{ login: "/login", callback: "/callback", logout: "/logout", me: "/me", refresh: "/refresh" }` | Endpoint paths relative to `basePath`. |
| `loginPath` | `string` | `"/login"` | Frontend route used by `AuthGuard` for sign-in. |
| `notAuthorizedPath` | `string` | `"/not-authorized"` | Frontend route used by `RequireAccess` when a grant is missing. |
| `defaultReturnTo` | `string` | `"/"` | Frontend path to redirect to after login. |
| `autoRefresh` | `boolean` | `true` | Refresh the session before expiry. |
| `refreshLeadTime` | `number` | `60` | Seconds before expiry to trigger the refresh. |
| `csrfHeader` | `string` | `"x-csrf-token"` | Header carrying the per-session CSRF token. |

`endpoints.login` is the BFF endpoint used by `login()`; `loginPath` is the frontend route used by `AuthGuard`. They are different paths. Resolved auth configuration is available as `useAuth().config` with the `ResolvedAuthConfig` type.

### Global Loader Configuration

| Name | Type | Default | Description |
|---|---|---|---|
| `spinnerColor` | `string` | `"#888888"` | CSS color of the spinner arc. |
| `spinnerWidth` | `number` | `3` | Spinner arc width (padding), in pixels. |
| `backgroundColor` | `string` | `"#fafafa"` | Full-screen overlay background color. |
| `spinnerSize` | `number` | `50` | Spinner diameter, in pixels. |
| `textColor` | `string` | `"#888888"` | CSS color of the text below the spinner. |
| `zIndex` | `number` | `999999` | Stacking order of the overlay. |
| `textComponent` | `(props: { text: string; textColor: string }) => ReactElement` | Paragraph renderer | Custom renderer for the message below the spinner. |

Global loader configuration is captured on mount and is not reactive. Remount `GlobalLoaderProvider` to apply different values.

### I18n Configuration

| Name | Type | Default | Description |
|---|---|---|---|
| `loader` | `TranslationLoader` | Required | Async source for translations; receives the locale and returns a flat key/value map. |
| `defaultLocale` | `string` | `"en"` | Locale loaded on mount. Use `setLocale()` to change it at runtime. |
| `onMissingTranslation` | `(key: string, locale: string) => void` | `undefined` | Called when a translation key is not found. |

### Object State Input

There is no provider-level configuration for `useObjectState`; its only input is the factory.

| Name | Type | Default | Description |
|---|---|---|---|
| `create` | `() => T` | Required | Lazy factory for the initial plain object. Must return a new object on every call. |

---

## Error Handling

`blendsdk/react` does not export custom error classes. Failures fall into three categories.

| Category | Error form | Meaning | Handling |
|---|---|---|---|
| Provider misuse | `Error` thrown during render | A hook was called outside its required provider. | Fix the provider composition; treat this as a configuration error. |
| Auth action failure | Rejected promise from `logout()`; `refresh()` can also fail | A BFF request did not complete as expected. | Use `try/catch`; check the boolean result from `refresh()`. |
| Translation load failure | Rejected `TranslationLoader` promise | The translation source was unreachable or returned an invalid response. | Handle inside the loader and return a fallback, or report through application-level error handling. |

### Provider Misuse

These errors are thrown by hooks during render when the required provider is missing:

| Hook | Required provider | Error message |
|---|---|---|
| `useGlobalLoader` | `GlobalLoaderProvider` | `useGlobalLoader() must be used within a <GlobalLoaderProvider>. Wrap your component tree with <GlobalLoaderProvider> to use this hook.` |
| `useTranslations` | `I18nProvider` | `useTranslations() must be used within an <I18nProvider>. Wrap your component tree with <I18nProvider> to use this hook.` |
| `useAuth` | `AuthProvider` | `useAuth() must be used within an <AuthProvider>. Wrap your component tree with <AuthProvider> to use this hook.` |
| `useAuthorization` | `AuthProvider` (through `useAuth`) | Throws the `useAuth()` message when no `AuthProvider` is present. |

These are developer errors, not recoverable runtime states. Correct the provider tree rather than catching them in component logic.

### Async Auth Actions

`logout()` returns a promise; `refresh()` resolves to `true` on success and reports an unsuccessful renewal as `false`. Keep the UI deterministic by handling both outcomes.

```tsx
import { useState } from "react";
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionActions() {
    const { logout, refresh } = useAuth();
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const handleRefresh = async (): Promise<void> => {
        setErrorMessage(null);
        try {
            const refreshed = await refresh();
            if (!refreshed) {
                setErrorMessage("The session could not be refreshed.");
            }
        } catch (error) {
            setErrorMessage(
                error instanceof Error ? error.message : "Unexpected refresh failure.",
            );
        }
    };

    const handleLogout = async (): Promise<void> => {
        setErrorMessage(null);
        try {
            await logout();
        } catch (error) {
            setErrorMessage(
                error instanceof Error ? error.message : "Unexpected logout failure.",
            );
        }
    };

    return (
        <section>
            {errorMessage !== null && <p role="alert">{errorMessage}</p>}
            <button type="button" onClick={() => void handleRefresh()}>
                Refresh session
            </button>
            <button type="button" onClick={() => void handleLogout()}>
                Sign out
            </button>
        </section>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionActions />
        </AuthProvider>
    );
}
```

### Translation Loader Failures

`I18nContextValue` exposes `ready` but no error field. Decide in the loader whether a failure should propagate to an application error boundary or fall back to an empty catalog.

```typescript
import type { TranslationLoader } from "blendsdk/react";

const loadTranslations: TranslationLoader = async (locale) => {
    try {
        const response = await fetch(`/api/translations/${locale}`);
        if (!response.ok) {
            throw new Error(`Translation request failed with ${response.status}`);
        }
        return response.json();
    } catch (error) {
        console.error(`Could not load translations for ${locale}`, error);
        return {};
    }
};
```

The example logs the failure and returns an empty catalog. With `onMissingTranslation`, unresolved keys can still be reported while the application remains renderable.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
