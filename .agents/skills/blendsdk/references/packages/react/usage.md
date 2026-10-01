> **Package**: `blendsdk/react`

# react Core Concepts

This document is the deep dive into the concepts that make up `blendsdk/react`. Every feature in the package — GlobalLoader, I18n, Auth, and Authorization — is delivered through one shared contract (a provider component plus consumer hooks), and each has its own state model, configuration, and failure behavior. Each section below covers what the concept is, how it works mechanically, a complete working example, and reference tables for the public API. For package-level context, see the Overview.

| Concept | Purpose |
|---------|---------|
| Provider and Hook Contract | The uniform provider / context / hook shape every feature follows |
| GlobalLoader | Application-wide full-screen loading overlay |
| I18n | Asynchronous translation loading, lookup, and live locale switching |
| Auth | BFF-backed OIDC session management for the SPA |
| Authorization | UI-level role and permission checks that fail closed |

---

## Provider and Hook Contract

### What It Is

Every feature in `blendsdk/react` exposes the same shape: a **Provider component** that owns the feature's state and configuration for a subtree, and one or more **consumer hooks** that read that state from React Context. There is no global store and no prop drilling — the provider is the boundary, the hook is the access point. This contract is what makes the package composable: you learn it once and apply it to loading, translations, and authentication alike.

### How It Works

- Each provider creates a typed React Context with a `null` default, computes a context value (state plus action functions) on render, and supplies it to its subtree.
- Consumer hooks call `useContext` and throw a descriptive `Error` when the context is `null`. A hook used outside its provider fails fast at render time instead of silently returning broken state — e.g., `useAuth()` throws when no `AuthProvider` is above it.
- Configuration is passed to providers as props and is **captured on mount**, not reactive. `AuthProvider` merges its `AuthConfig` with `AUTH_DEFAULTS` and publishes the fully resolved `ResolvedAuthConfig`; `GlobalLoaderProvider` applies built-in defaults to omitted properties and must be remounted to pick up different config.
- Providers nest. Order matters where one feature depends on another: `I18nProvider` drives the GlobalLoader overlay while translations load, so `GlobalLoaderProvider` must wrap it.

### Complete Example

Composite setup: the loading overlay outermost, i18n inside it, and auth around the protected subtree. `AuthGuard` wraps `children` so everything rendered inside the guard sees a session.

```tsx
import {
    AuthGuard,
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

export function AppProviders({ children }: { children: ReactNode }) {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <AuthProvider config={{ basePath: "/api/auth" }}>
                    <AuthGuard>{children}</AuthGuard>
                </AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

`GlobalLoaderProvider` is outermost because `I18nProvider` shows the overlay during translation reloads. `AuthProvider` is independent of the other two — mount it wherever the protected subtree begins.

### Key Methods and Properties

The provider/hook pairing for every feature:

| Feature | Provider | Consumer hook(s) | Context value type |
|---------|----------|------------------|--------------------|
| Global loading | `GlobalLoaderProvider` | `useGlobalLoader` | `GlobalLoaderContextValue` |
| Internationalization | `I18nProvider` | `useTranslations` | `I18nContextValue` |
| Authentication | `AuthProvider` | `useAuth` | `AuthContextValue` |
| Authorization | — (reads from `AuthProvider`'s context) | `useAuthorization` | `UseAuthorizationResult` |

Fail-closed behavior of the hooks:

| Hook | Behavior when used outside its provider |
|------|------------------------------------------|
| `useGlobalLoader` | Throws — `"useGlobalLoader() must be used within a <GlobalLoaderProvider>."` |
| `useTranslations` | Throws — `"useTranslations() must be used within an <I18nProvider>."` |
| `useAuth` | Throws — `"useAuth() must be used within an <AuthProvider>."` |
| `useAuthorization` | Throws through `useAuth()` when no `AuthProvider` is present |

---

## GlobalLoader

### What It Is

`GlobalLoader` is a single, application-wide loading overlay: a full-screen layer with a pure-CSS spinner and an optional message beneath it. Instead of every screen inventing its own spinner or blocking dialog, any component inside the provider can turn the same overlay on, annotate it, and turn it off — the common need for route transitions, saves, and any async work that should visually block the UI.

### How It Works

- Visibility and text live in the provider's context: `showLoader(visible)` toggles the overlay, `setText(text)` writes the caption below the spinner, and `visible` reflects the current state for consumers that need to observe it.
- The overlay is rendered on top of the subtree whenever it is visible, using a full-screen CSS layer (default background `#fafafa`, default z-index `999999`). The spinner is pure CSS — no images or animation libraries.
- Appearance comes from `GlobalLoaderConfig`, merged with built-in defaults when the provider **mounts**: `spinnerColor` `#888888`, `spinnerWidth` `3`, `spinnerSize` `50`, `textColor` `#888888`, `backgroundColor` `#fafafa`, `zIndex` `999999`. Config is not reactive — remount the provider to change it.
- Hiding the overlay (`showLoader(false)`) **clears the text automatically**, so callers never have to reset the message manually.
- `textComponent` is a render prop — `({ text, textColor }) => ReactElement` — that replaces the default `<p>` caption with custom markup.
- Because the overlay is global, all consumers share one instance: showing or hiding it from one component affects the entire subtree.

### Complete Example

A save button that drives the overlay, mounted under a provider with custom spinner colors and a custom text renderer:

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";
import { useState } from "react";

function SaveButton() {
    const { showLoader, setText } = useGlobalLoader();
    const [saved, setSaved] = useState(false);

    const handleSave = async () => {
        setText("Saving changes…");
        showLoader(true);
        try {
            const response = await fetch("/api/documents/42", { method: "PUT" });
            if (!response.ok) {
                throw new Error(`Save failed with status ${response.status}`);
            }
            setSaved(true);
        } catch (error) {
            console.error("Could not save the document:", error);
        } finally {
            showLoader(false); // hides the overlay and clears "Saving changes…"
        }
    };

    return <button onClick={handleSave}>{saved ? "Saved" : "Save"}</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider
            config={{
                spinnerColor: "#25b09b",
                textColor: "#25b09b",
                textComponent: ({ text, textColor }) => (
                    <strong style={{ color: textColor, fontSize: 16 }}>{text}</strong>
                ),
            }}
        >
            <SaveButton />
        </GlobalLoaderProvider>
    );
}
```

### Key Methods and Properties

The provider takes `GlobalLoaderProviderProps` — `{ config?: GlobalLoaderConfig; children: ReactNode }`. The context value (`GlobalLoaderContextValue`):

| Name | Signature | Description |
|------|-----------|-------------|
| `showLoader` | `(visible: boolean) => void` | Shows or hides the overlay. Hiding clears the caption text automatically. |
| `setText` | `(text: string \| null) => void` | Sets the message below the spinner; `null` or `""` clears it. |
| `visible` | `boolean` | Current overlay visibility (read-only). |

Configuration options (`GlobalLoaderConfig`) — merged with defaults on mount:

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `spinnerColor` | `string` | `"#888888"` | CSS color of the spinner arc. |
| `spinnerWidth` | `number` | `3` | Spinner arc width (padding) in pixels. |
| `backgroundColor` | `string` | `"#fafafa"` | Background color of the full-screen overlay. |
| `spinnerSize` | `number` | `50` | Spinner diameter in pixels. |
| `textColor` | `string` | `"#888888"` | CSS color for the text below the spinner. |
| `zIndex` | `number` | `999999` | CSS z-index of the overlay. |
| `textComponent` | `(props: { text: string; textColor: string }) => ReactElement` | `<p>` caption (14px, margin-top 16px) | Custom renderer for the caption below the spinner. |

---

## I18n

### What It Is

I18n provides runtime internationalization: translations are fetched asynchronously from wherever the application keeps them (an API, a JSON endpoint), and components translate keys through a `t()` function that supports interpolation and plural forms. Locale switching happens live — `setLocale()` triggers a re-fetch and the UI re-renders with the new catalog — all backed by the `blendsdk/i18n` translation engine.

### How It Works

- `I18nProvider` requires a `loader: TranslationLoader` — the strategy the application supplies: `(locale: string) => Promise<Record<string, TranslationValue>>`. The provider never knows where translations come from; it wraps the returned flat key/value map into a translation catalog internally.
- On mount, the provider invokes the loader for `defaultLocale` (default `'en'`). `ready` flips to `true` once translations have loaded successfully.
- `t(key, params?)` resolves a key against the active catalog. Entries in `params` are available as interpolation values; a `count` parameter selects the plural form.
- `setLocale(locale)` triggers a fresh loader call and shows the [GlobalLoader](#globalloader) overlay while the fetch is in flight — which is why the recommended nesting mounts `I18nProvider` inside `GlobalLoaderProvider` (see [Provider and Hook Contract](#provider-and-hook-contract)).
- `reloadTranslations()` forces a re-fetch for the current locale, e.g. after server-side content changed.
- `onMissingTranslation(key, locale)` is an optional reporting hook invoked when a key cannot be resolved — useful for logging or metrics.

### Complete Example

A locale switcher with an interpolated greeting and a pluralized unread count:

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

function InboxSummary({ unreadCount }: { unreadCount: number }) {
    const { t, locale, setLocale, ready } = useTranslations();

    if (!ready) {
        return <p aria-busy="true">Loading translations…</p>;
    }

    return (
        <section>
            <h1>{t("inbox.title")}</h1>
            <p>{t("inbox.greeting", { name: "Ada" })}</p>
            <p>{t("inbox.unread", { count: unreadCount })}</p>
            <button onClick={() => setLocale(locale === "en" ? "nl" : "en")}>
                {t("common.switchLanguage")}
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
                    console.warn(`Missing translation "${key}" for locale "${locale}"`);
                }}
            >
                <InboxSummary unreadCount={3} />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

### Key Methods and Properties

The provider takes `I18nProviderProps`:

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `loader` | `TranslationLoader` — `(locale: string) => Promise<Record<string, TranslationValue>>` | Yes | Loads the flat translation map for a locale. |
| `defaultLocale` | `string` | No — default `'en'` | Locale loaded on mount. |
| `onMissingTranslation` | `(key: string, locale: string) => void` | No | Called when a translation key is not found. |
| `children` | `ReactNode` | Yes | Application subtree. |

The context value (`I18nContextValue`):

| Name | Signature | Description |
|------|-----------|-------------|
| `t` | `(key: string, params?: Record<string, unknown>) => string` | Translates `key`; `params` provide interpolation values and `count` selects the plural form. |
| `locale` | `string` | Currently active locale. |
| `setLocale` | `(locale: string) => void` | Switches locale; re-fetches through the loader and shows the GlobalLoader overlay while loading. |
| `reloadTranslations` | `() => void` | Re-fetches translations for the current locale. |
| `ready` | `boolean` | `true` once translations have loaded successfully. |

---

## Auth

### What It Is

The Auth feature implements the **BFF (backend-for-frontend) pattern for OIDC**: the browser never sees OIDC tokens. A backend-for-frontend handles the OIDC dance and keeps an httpOnly cookie session; this module drives the front end of that arrangement — login redirect, session discovery via `GET /me`, automatic refresh ahead of expiry, logout, and CSRF handling — and exposes the state through `useAuth()`. `AuthGuard` turns that state into route protection.

### How It Works

- **One base path, resolved endpoints.** `basePath` (e.g. `/api/auth`) is the only required value. `login`, `callback`, `logout`, `me`, and `refresh` default to `/login`, `/callback`, `/logout`, `/me`, and `/refresh` relative to it (see `AUTH_DEFAULTS`) and can be overridden per endpoint. User config is merged **on mount** and exposed fully resolved as `ResolvedAuthConfig` via the context `config` property.
- **Initial session check.** On mount, the provider performs the session check against `GET {basePath}/me` and keeps `isLoading: true` until the result settles. A session populates `user` — the OIDC `sub` claim plus any additional claims the server attached; otherwise `user` is `null`.
- **Authenticated vs. authorized.** `isAuthenticated` is `user !== null`. `authorized` is a separate, server-driven verdict: `true` only when the session check returned a session that is not marked `authorized: false` — it is `false` before the first check, for anonymous or failed checks, for a session the application denied, and after logout. An unauthorized session is still authenticated.
- **Actions.** `login(returnTo?)` redirects the browser to the BFF login endpoint — the OIDC round-trip happens server-side; `returnTo` (default `defaultReturnTo`, `/`) is where the user lands afterwards. `logout()` calls the BFF logout endpoint and clears local state; `refresh()` performs a manual refresh and reports success as a `boolean`.
- **Automatic refresh.** With `autoRefresh` enabled (default), the provider refreshes the session `refreshLeadTime` seconds (default `60`) before `expiresAt` — the Unix-seconds session expiry exposed in the context.
- **CSRF.** The session check and refresh responses may carry a per-session CSRF token, exposed as `csrfToken`. Send it in the header named by `csrfHeader` (default `x-csrf-token`) on state-changing BFF calls. It is `null` when CSRF is not enforced; if another browsing context rotated the token, a request made with the outdated value can be rejected with `403` until the next session check.
- **Route protection.** `AuthGuard` renders its children for authenticated sessions and redirects visitors to the frontend `loginPath` (default `/login`) otherwise. The redirect-based components rely on `react-router`, which is an optional peer dependency of the package.

### Complete Example

A sign-in/sign-out bar outside the guard and a protected dashboard inside it:

```tsx
import { AuthGuard, AuthProvider, useAuth } from "blendsdk/react";

function formatExpiry(expiresAt: number | null): string {
    if (expiresAt === null) {
        return "unknown";
    }
    return new Date(expiresAt * 1000).toLocaleTimeString();
}

function SessionBar() {
    const { user, isAuthenticated, isLoading, login, logout } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return <button onClick={() => login()}>Sign In</button>;
    }

    return (
        <div>
            <span>Signed in as {user?.sub}</span>
            <button onClick={() => logout()}>Sign Out</button>
        </div>
    );
}

function Dashboard() {
    const { user, authorized, expiresAt } = useAuth();

    return (
        <main>
            <h1>Dashboard</h1>
            <p>Subject: {user?.sub}</p>
            <p>Session expires at: {formatExpiry(expiresAt)}</p>
            {!authorized && <p>Your session is authenticated but not authorized.</p>}
        </main>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionBar />
            <AuthGuard>
                <Dashboard />
            </AuthGuard>
        </AuthProvider>
    );
}
```

Note that `login()` is a browser redirect to the BFF endpoint, not a client-side navigation — the backend starts the OIDC flow and redirects back after the callback.

### Key Methods and Properties

Configuration (`AuthConfig`) with the `AUTH_DEFAULTS` fallbacks. User config is merged over these on mount, producing the `ResolvedAuthConfig` exposed on the context (same keys, all required, endpoints fully resolved):

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `basePath` | `string` | — (required) | Base path for all BFF auth endpoints (e.g. `/api/auth`). |
| `endpoints.login` | `string` | `"/login"` | Login endpoint, relative to `basePath`. |
| `endpoints.callback` | `string` | `"/callback"` | OIDC callback endpoint, relative to `basePath`. |
| `endpoints.logout` | `string` | `"/logout"` | Logout endpoint, relative to `basePath`. |
| `endpoints.me` | `string` | `"/me"` | Session check endpoint, relative to `basePath`. |
| `endpoints.refresh` | `string` | `"/refresh"` | Session refresh endpoint, relative to `basePath`. |
| `loginPath` | `string` | `"/login"` | Frontend route for the login page; `AuthGuard` redirects here. |
| `notAuthorizedPath` | `string` | `"/not-authorized"` | Frontend route for missing grants; `RequireAccess` redirects here. |
| `defaultReturnTo` | `string` | `"/"` | Frontend path to redirect to after login. |
| `autoRefresh` | `boolean` | `true` | Refresh tokens before expiry. |
| `refreshLeadTime` | `number` | `60` | Seconds before expiry to trigger a refresh. |
| `csrfHeader` | `string` | `"x-csrf-token"` | Header carrying the per-session CSRF token. |

The context value (`AuthContextValue`):

| Name | Type | Description |
|------|------|-------------|
| `user` | `AuthUser \| null` | Current user — the OIDC `sub` claim plus additional claims — or `null` when anonymous. |
| `isAuthenticated` | `boolean` | `true` when `user !== null`. |
| `isLoading` | `boolean` | `true` while the initial session check is in progress. |
| `login` | `(returnTo?: string) => void` | Redirects the browser to the BFF login endpoint; `returnTo` sets the post-login destination. |
| `logout` | `() => Promise<void>` | Signs out through the BFF logout endpoint and clears local state. |
| `refresh` | `() => Promise<boolean>` | Manually refreshes the session; returns `true` on success, `false` on failure. |
| `expiresAt` | `number \| null` | Unix timestamp (seconds) when the session expires, or `null` if unknown. |
| `authorized` | `boolean` | The server's verdict for the session — `false` before the first check, for anonymous or failed checks, for denied sessions, and after logout. |
| `csrfToken` | `string \| null` | Per-session CSRF token for state-changing BFF calls; `null` when CSRF is not enforced. |
| `config` | `ResolvedAuthConfig` | The fully resolved configuration with all defaults applied. |

Supporting components:

| Component | Props | Description |
|-----------|-------|-------------|
| `AuthProvider` | `AuthProviderProps` — `config: AuthConfig`, `children: ReactNode` | Merges config with defaults, performs the initial session check, and schedules auto-refresh. |
| `AuthGuard` | children | Renders its children only for authenticated sessions; otherwise redirects to `config.loginPath`. |

---

## Authorization

### What It Is

Authorization is the presentation side of access control: it turns the authenticated session user into a small principal — roles and permissions — and evaluates grant checks in the UI. `useAuthorization()` returns the grant lists plus `hasRole()` and `can()` predicates, while `RequireAccess` and `Can` apply the same checks declaratively in JSX. These checks are convenience, not security: the client shapes the interface, but the server remains the authority that actually enforces access.

### How It Works

- The hook reads `user` from the [Auth](#auth) context, so it must be called inside a subtree wrapped by `AuthProvider` — otherwise the underlying `useAuth()` throws.
- Grants come from the session user: the server stores the user's canonical `roles` and `permissions` on the session payload after translating the provider identity. An anonymous user holds nothing.
- The user object is treated as untrusted runtime data. A missing value or non-array becomes an empty list, non-string entries are discarded, and duplicates are removed (first occurrence wins). Malformed grants therefore degrade to an empty principal and every check returns `false` — requirements fail closed instead of throwing.
- `hasRole(role)` and `can(permission)` delegate to `blendsdk/authz` (`hasRole` / `hasPermission`), keeping UI checks consistent with the rest of the BlendSDK authorization stack. The entire result is memoized on the session user, so the returned functions stay stable between renders.
- `RequireAccess` and `Can` are the declarative forms of the same predicates: `RequireAccess` redirects a signed-in user who lacks the required grant to `config.notAuthorizedPath` (default `/not-authorized`); `Can` renders its children only when the required grant is held. Their prop types are exported as `RequireAccessProps` and `CanProps`.
- None of this is a security boundary — the server rejects what the user may not do; the UI merely avoids offering it.

### Complete Example

An invoice toolbar that shows actions based on the current user's grants:

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";

function InvoiceToolbar() {
    const { roles, hasRole, can } = useAuthorization();

    const canWrite = can("invoice:write");

    return (
        <div role="toolbar" aria-label="Invoice actions">
            <p>Signed-in roles: {roles.length > 0 ? roles.join(", ") : "none"}</p>
            {hasRole("finance") && <span className="badge">Finance</span>}
            {canWrite && <button>Edit invoice</button>}
            {can("invoice:approve") && <button>Approve invoice</button>}
            {!canWrite && <p>You have read-only access to invoices.</p>}
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

If no session exists or the session's grants are malformed, every predicate returns `false` — the toolbar renders in read-only mode rather than throwing.

### Key Methods and Properties

The result of `useAuthorization()` (`UseAuthorizationResult`):

| Name | Signature | Description |
|------|-----------|-------------|
| `roles` | `readonly string[]` | Roles the current user holds; empty for anonymous or malformed grants. |
| `permissions` | `readonly string[]` | Permissions the current user holds; empty for anonymous or malformed grants. |
| `hasRole` | `(role: string) => boolean` | Reports whether the current user holds a role. |
| `can` | `(permission: string) => boolean` | Reports whether the current user holds a permission. |

The declarative guard components:

| Component | Props | Description |
|-----------|-------|-------------|
| `RequireAccess` | `RequireAccessProps` | Grant requirement for a route or area; a signed-in user who lacks the required grant is redirected to `config.notAuthorizedPath`. |
| `Can` | `CanProps` | Grant check for JSX; renders its children only when the required grant is held. |

---

# react Basic Usage

This guide goes from installation to a fully composed provider tree, adding one concept at a time: the global loading overlay, runtime translations, the BFF session, and UI authorization. Every feature follows the same contract — wrap a subtree with a provider component, consume it with hooks — so the pattern learned in the first step carries through all the rest. For module internals and design rationale, see Core Concepts.

---

## Installation

`blendsdk/react` is a private, workspace-internal package (`"private": true`). It is consumed from inside the BlendSDK monorepo and is not published to the npm registry on its own. Declare it in the consuming application's `dependencies`, then install from the repository root:

```bash
# npm — from the monorepo root; installs and links all workspace packages
npm install
```

```bash
# yarn — equivalent workspace install
yarn install
```

Additional notes:

- The workspace resolves `blendsdk/react` to the local package — there is no registry fetch, and deep imports into `src/` or `dist/` are not supported. Everything is imported from the package root.
- The package is ESM-only and ships TypeScript declarations for its single `"."` export entry.
- Node.js >= 22 is required for the repository build toolchain.

Peer dependencies:

| Peer dependency | Version | Required | Needed for |
|-----------------|---------|----------|------------|
| `react` | `^19.0.0` | Yes | Component and hook runtime. |
| `react-dom` | `^19.0.0` | Yes | Rendering provider trees into the DOM. |
| `react-router` | `^7.0.0` | No (optional) | Redirects performed by `AuthGuard` and `RequireAccess`. |

---

## Quick Start

Wrap a subtree with a provider and drive it from a child component:

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function LoadButton() {
    const { showLoader } = useGlobalLoader();
    return <button onClick={() => showLoader(true)}>Load</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <LoadButton />
        </GlobalLoaderProvider>
    );
}
```

Clicking the button shows the full-screen overlay; calling `showLoader(false)` hides it and clears any message text. Every feature in the package follows this same shape — a provider component that owns the state for a subtree, plus hooks that read and act on it.

---

## Fundamentals

Each step below introduces exactly one new concept. The first block in each step is the simple case; the block after it shows the next level of complexity on the same concept.

### Step 1: Wrap the Tree with a Provider

Rendering a provider changes nothing on screen by itself — it creates the feature's boundary, applies configuration, and supplies context to everything below it. `GlobalLoaderProvider` takes an optional `config`; omitted properties fall back to built-in defaults (`spinnerColor` `#888888`, `spinnerSize` `50`, and so on — the full list is in [Configuration](#configuration)).

```tsx
import { GlobalLoaderProvider } from "blendsdk/react";

function Dashboard() {
    return <h1>Dashboard</h1>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <Dashboard />
        </GlobalLoaderProvider>
    );
}
```

**Next level:** pass explicit configuration. The values are captured when the provider mounts and are not reactive — to apply different values, remount the provider (for example by changing its `key`).

```tsx fragment
<GlobalLoaderProvider
    config={{
        spinnerColor: "#25b09b",
        textColor: "#25b09b",
        spinnerSize: 64,
        zIndex: 1000,
    }}
>
    <Dashboard />
</GlobalLoaderProvider>
```

### Step 2: Read State and Actions with a Hook

Hooks read the nearest provider's context. `useGlobalLoader()` returns `showLoader`, `setText`, and `visible`; calling it when no `GlobalLoaderProvider` is above the component throws a descriptive `Error` (see [Error Handling](#error-handling)).

Simple case — show the overlay for the duration of an async operation:

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function SaveButton() {
    const { showLoader } = useGlobalLoader();

    const handleSave = async (): Promise<void> => {
        showLoader(true);
        try {
            await fetch("/api/save", { method: "POST" });
        } finally {
            showLoader(false);
        }
    };

    return <button onClick={handleSave}>Save</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <SaveButton />
        </GlobalLoaderProvider>
    );
}
```

**Next level:** annotate the overlay with `setText`. Hiding the overlay clears the text automatically, so the `finally` block resets both pieces of state at once — no manual cleanup needed.

```tsx fragment
const { showLoader, setText } = useGlobalLoader();

const handleSave = async (): Promise<void> => {
    setText("Saving changes…");
    showLoader(true);
    try {
        await fetch("/api/save", { method: "POST" });
    } finally {
        showLoader(false); // hides the overlay and clears "Saving changes…"
    }
};
```

### Step 3: Compose Providers — Adding I18n

Providers nest, and each feature keeps its own boundary. `I18nProvider` requires a `loader` — an async function the application supplies that returns a flat map of translation keys to values for a locale — and loads its `defaultLocale` (default `'en'`) on mount. Mount it inside `GlobalLoaderProvider`: switching locales fetches a new catalog and drives the global overlay while the fetch is in flight.

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

function Greeting() {
    const { t, ready } = useTranslations();

    if (!ready) {
        return <p aria-busy="true">Loading translations…</p>;
    }

    return <h1>{t("inbox.title")}</h1>;
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

**Next level:** `t(key, params)` interpolates values and selects plural forms through a `count` parameter, while `setLocale()` switches the active locale. `onMissingTranslation` reports keys that cannot be resolved — useful for logging or metrics.

```tsx fragment
function InboxSummary({ unreadCount }: { unreadCount: number }) {
    const { t, locale, setLocale } = useTranslations();

    return (
        <section>
            <p>{t("inbox.greeting", { name: "Ada" })}</p>
            <p>{t("inbox.unread", { count: unreadCount })}</p>
            <button onClick={() => setLocale(locale === "en" ? "nl" : "en")}>
                {t("common.switchLanguage")}
            </button>
        </section>
    );
}
```

```tsx fragment
<I18nProvider
    loader={loadTranslations}
    defaultLocale="en"
    onMissingTranslation={(key, locale) => {
        console.warn(`Missing translation "${key}" for locale "${locale}"`);
    }}
>
    <Greeting />
</I18nProvider>
```

### Step 4: Add a BFF Session with AuthProvider and AuthGuard

The auth module implements the BFF pattern: the browser never holds OIDC tokens. `AuthProvider` takes a config whose only required value is `basePath`; every other property is merged over `AUTH_DEFAULTS` on mount. On mount it checks the session at `GET {basePath}/me` and keeps `isLoading` true until the result settles, so `useAuth()` can distinguish "not signed in" from "session check still running". `AuthGuard` renders its children only for authenticated sessions and redirects visitors to `config.loginPath` otherwise.

```tsx
import { AuthGuard, AuthProvider, useAuth } from "blendsdk/react";

function SignInBar() {
    const { user, isAuthenticated, isLoading, login, logout } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return <button onClick={() => login()}>Sign In</button>;
    }

    return (
        <div>
            <span>Signed in as {user?.sub}</span>
            <button onClick={() => logout()}>Sign Out</button>
        </div>
    );
}

function Dashboard() {
    return <h1>Dashboard</h1>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SignInBar />
            <AuthGuard>
                <Dashboard />
            </AuthGuard>
        </AuthProvider>
    );
}
```

`login()` is a browser redirect to the BFF login endpoint, not client-side navigation — the backend runs the OIDC round-trip and redirects back. `AuthGuard` and `RequireAccess` navigate with `react-router`, so the subtree that uses them must render inside a router.

**Next level:** work with session lifetime. `expiresAt` is the Unix-seconds expiry, and `refresh()` renews the session on demand, resolving `true` on success and `false` on failure. With `autoRefresh` enabled (the default), the provider already refreshes `refreshLeadTime` seconds (default `60`) before expiry — call `refresh()` when you want to renew at a specific moment. The context also carries `authorized` (the server's verdict for the session — an authenticated session can still be unauthorized) and `csrfToken` for state-changing BFF calls.

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionStatus() {
    const { expiresAt, refresh } = useAuth();

    const handleRefresh = async (): Promise<void> => {
        const refreshed = await refresh();
        if (!refreshed) {
            console.warn("Session refresh failed — sign in again to continue.");
        }
    };

    return (
        <p>
            {expiresAt !== null
                ? `Session expires at ${new Date(expiresAt * 1000).toLocaleTimeString()}`
                : "Session expiry unknown"}{" "}
            <button onClick={handleRefresh}>Refresh now</button>
        </p>
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

### Step 5: Gate the UI on Grants

`useAuthorization()` turns the session user into a principal of roles and permissions and returns `hasRole()` and `can()` predicates backed by `blendsdk/authz`. The grants are server-supplied: the server stores the canonical `roles` and `permissions` on the session after translating the provider identity. An anonymous user holds nothing, and malformed grant data fails closed to an empty principal — every check returns `false` instead of throwing.

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";

function InvoiceToolbar() {
    const { hasRole, can } = useAuthorization();

    return (
        <div role="toolbar" aria-label="Invoice actions">
            {hasRole("finance") && <span>Finance</span>}
            {can("invoice:write") && <button>Edit invoice</button>}
            {can("invoice:approve") && <button>Approve invoice</button>}
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

**Next level:** render explicit read-only states for viewers without a grant, and use the declarative forms of the same checks — `Can` gates an element, while `RequireAccess` protects a route and redirects signed-in users who lack the required grant to `config.notAuthorizedPath` (default `/not-authorized`). Their prop types are exported as `CanProps` and `RequireAccessProps`.

```tsx fragment
function InvoiceActions() {
    const { can } = useAuthorization();

    return can("invoice:write")
        ? <button>Edit invoice</button>
        : <p>You have read-only access to invoices.</p>;
}
```

Remember that all of these checks are presentation only — they shape the interface, but the server remains the authority that enforces access.

---

## Configuration

There is no single global configuration object; each provider takes its own options, and every omitted value is filled from built-in defaults. `GlobalLoaderProvider` captures its config on mount, while `AuthProvider` merges the user config over `AUTH_DEFAULTS` on mount and exposes the fully resolved result as `useAuth().config` (`ResolvedAuthConfig` — same keys, all required, endpoints fully resolved).

### GlobalLoader Config

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `spinnerColor` | `string` | `"#888888"` | CSS color of the spinner arc. |
| `spinnerWidth` | `number` | `3` | Spinner arc width (padding) in pixels. |
| `backgroundColor` | `string` | `"#fafafa"` | Background color of the full-screen overlay. |
| `spinnerSize` | `number` | `50` | Spinner diameter in pixels. |
| `textColor` | `string` | `"#888888"` | CSS color of the text below the spinner. |
| `zIndex` | `number` | `999999` | CSS z-index of the overlay. |
| `textComponent` | `(props: { text: string; textColor: string }) => ReactElement` | `<p>` caption (14px, margin-top 16px) | Custom renderer for the caption below the spinner. |

### I18n Provider

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `loader` | `TranslationLoader` — `(locale: string) => Promise<Record<string, TranslationValue>>` | — (required) | Fetches the flat translation map for a locale; called for `defaultLocale` on mount and again on every `setLocale()`. |
| `defaultLocale` | `string` | `'en'` | Locale loaded on mount. |
| `onMissingTranslation` | `(key: string, locale: string) => void` | — | Called when a translation key cannot be resolved. |

### Auth Config

User config is merged over `AUTH_DEFAULTS` on mount. The defaults are also exported as the `AUTH_DEFAULTS` constant if you need to introspect them.

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `basePath` | `string` | — (required) | Base path for all BFF auth endpoints, e.g. `/api/auth`. |
| `endpoints.login` | `string` | `"/login"` | Login endpoint, relative to `basePath`. |
| `endpoints.callback` | `string` | `"/callback"` | OIDC callback endpoint, relative to `basePath`. |
| `endpoints.logout` | `string` | `"/logout"` | Logout endpoint, relative to `basePath`. |
| `endpoints.me` | `string` | `"/me"` | Session check endpoint, relative to `basePath`. |
| `endpoints.refresh` | `string` | `"/refresh"` | Session refresh endpoint, relative to `basePath`. |
| `loginPath` | `string` | `"/login"` | Frontend route `AuthGuard` redirects to. |
| `notAuthorizedPath` | `string` | `"/not-authorized"` | Frontend route `RequireAccess` redirects to when a grant is missing. |
| `defaultReturnTo` | `string` | `"/"` | Frontend path to redirect to after login. |
| `autoRefresh` | `boolean` | `true` | Refresh the session before expiry. |
| `refreshLeadTime` | `number` | `60` | Seconds before expiry to trigger a refresh. |
| `csrfHeader` | `string` | `"x-csrf-token"` | Header carrying the per-session CSRF token. |

```tsx fragment
<AuthProvider
    config={{
        basePath: "/api/auth",
        endpoints: { me: "/session" },
        loginPath: "/sign-in",
        refreshLeadTime: 30,
    }}
>
    <App />
</AuthProvider>
```

---

## Error Handling

Failures fall into two groups: usage errors, raised synchronously by hooks during render, and I/O failures — translation loading, session lifecycle, and CSRF-protected calls — which surface through `ready`, return values, rejected promises, or HTTP status codes. The package exports no custom error classes; every thrown value is a standard `Error`.

| Failure | Where it comes from | Surfaced as | Meaning |
|---------|---------------------|-------------|---------|
| Hook used outside its provider | `useGlobalLoader`, `useTranslations`, `useAuth` (and `useAuthorization` through it) | `Error` thrown during render | The component tree is missing the required provider above the hook's component. |
| Translation catalog load fails | Your `TranslationLoader` | Rejected promise from the loader; `ready` stays `false` | The locale's translations could not be fetched — render your not-ready fallback. |
| Initial session check fails | `GET {basePath}/me` | App stays signed out (`authorized` is `false`) | Render the signed-in view; the user can sign in. |
| Session refresh fails | `refresh()` | Resolves `false` | The session could not be renewed; the user likely needs to sign in again. |
| Logout request fails | `logout()` | Rejected promise | The BFF logout call failed; report it and let the user retry. |
| CSRF token stale | State-changing BFF calls | HTTP `403` response | The token was rotated (e.g., by another tab); refresh and retry. |

### Hook Usage Errors

Each consumer hook throws a plain `Error` with a message that names the missing provider:

| Hook | Error message |
|------|---------------|
| `useGlobalLoader` | `useGlobalLoader() must be used within a <GlobalLoaderProvider>. Wrap your component tree with <GlobalLoaderProvider> to use this hook.` |
| `useTranslations` | `useTranslations() must be used within an <I18nProvider>. Wrap your component tree with <I18nProvider> to use this hook.` |
| `useAuth` | `useAuth() must be used within an <AuthProvider>. Wrap your component tree with <AuthProvider> to use this hook.` |
| `useAuthorization` | Throws through `useAuth()` when no `<AuthProvider>` is present. |

Because these are render-time errors, `try`/`catch` inside the component cannot intercept them. Move the component inside the required provider — or catch the failure with a React error boundary so a misplaced hook renders a readable message instead of blanking the app:

```tsx
import { Component, type ErrorInfo, type ReactNode } from "react";
import { GlobalLoaderProvider } from "blendsdk/react";

interface ErrorBoundaryProps {
    children: ReactNode;
}

interface ErrorBoundaryState {
    message: string | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { message: null };

    static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
        return { message: error instanceof Error ? error.message : "Unexpected render error" };
    }

    componentDidCatch(error: unknown, info: ErrorInfo): void {
        console.error("Render failed:", error, info.componentStack);
    }

    render(): ReactNode {
        if (this.state.message !== null) {
            return <p role="alert">{this.state.message}</p>;
        }
        return this.props.children;
    }
}

function Dashboard() {
    return <h1>Dashboard</h1>;
}

export function App() {
    return (
        <ErrorBoundary>
            <GlobalLoaderProvider>
                <Dashboard />
            </GlobalLoaderProvider>
        </ErrorBoundary>
    );
}
```

### Translation Loader Failures

Design the loader to throw a descriptive `Error` when a fetch fails (as in the Step 3 example) — a rejected loader never flips `ready` to `true`, so the `ready` guard doubles as your fallback UI. Use `reloadTranslations()` to force a re-fetch of the current locale once the underlying problem is resolved, and `onMissingTranslation(key, locale)` to report individual keys that cannot be resolved.

### Session and Action Failures

The session-check lifecycle is fail-closed: a failed initial `GET /me` leaves the app in the signed-out state (`authorized` is `false`), so your UI simply renders the sign-in view. For the action functions, `refresh()` never throws for a failed renewal — it resolves to `false` — while `logout()` returns a promise that can reject when the BFF call fails:

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SignOutButton() {
    const { logout } = useAuth();

    const handleLogout = async (): Promise<void> => {
        try {
            await logout();
        } catch (error) {
            console.error("Sign-out failed:", error);
            // Surface the failure to the user so they can retry.
        }
    };

    return <button onClick={handleLogout}>Sign out</button>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SignOutButton />
        </AuthProvider>
    );
}
```

### CSRF Rejections

Send `csrfToken` in the header named by `config.csrfHeader` on state-changing BFF calls. A `403` on such a call means the per-session token was missing or has been rotated — for example by another browsing context — so obtain a fresh token with `refresh()` and retry:

```tsx fragment
const { csrfToken, config, refresh } = useAuth();

const headers: Record<string, string> = { "content-type": "application/json" };
if (csrfToken !== null) {
    headers[config.csrfHeader] = csrfToken;
}

const response = await fetch("/api/documents/42", {
    method: "PUT",
    headers,
    body: JSON.stringify({ title: "Updated title" }),
});

if (response.status === 403) {
    await refresh(); // pulls a fresh token, then retry the request
}
```

### States That Are Not Errors

`authorized: false`, an empty principal, and `ready: false` are valid application states, not exceptions — render them deliberately (the sign-in view, read-only variants, the `not-authorized` route, loading fallbacks). Only thrown `Error`s and rejected promises from the loader, `logout()`, and your own fetch calls require exception handling.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
