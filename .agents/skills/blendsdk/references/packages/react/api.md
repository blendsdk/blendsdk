> **Package**: `blendsdk/react`

# react API Reference

`blendsdk/react` is the React integration layer of the BlendSDK monorepo. This document is the complete reference for its public API — the GlobalLoader, I18n, and Auth features, plus the Authorization helpers built on the auth session. Every symbol documented here is exported from the package root; the package defines no subpath exports and no deep-import paths.

`react` and `react-dom` (`^19.0.0`) are required peer dependencies. `react-router` (`^7.0.0`) is an optional peer dependency, needed only by the redirect-based auth components (`AuthGuard` and `RequireAccess`).

---

## Export Index

| Export | Kind | Section | Description |
|--------|------|---------|-------------|
| `GlobalLoaderProvider` | Component | GlobalLoader | Renders the application-wide loading overlay and provides loader controls to its subtree. |
| `useGlobalLoader` | Hook | GlobalLoader | Accesses the loader overlay controls. |
| `GlobalLoaderConfig` | Interface | GlobalLoader | Appearance configuration for the loading overlay. |
| `GlobalLoaderContextValue` | Interface | GlobalLoader | Loader state and controls exposed by `GlobalLoaderProvider`. |
| `GlobalLoaderProviderProps` | Interface | GlobalLoader | Props of `GlobalLoaderProvider`. |
| `I18nProvider` | Component | I18n | Loads translations through an application-supplied loader and provides them to its subtree. |
| `useTranslations` | Hook | I18n | Accesses the translation function, locale, and reload controls. |
| `I18nProviderProps` | Interface | I18n | Props of `I18nProvider`. |
| `I18nContextValue` | Interface | I18n | Translation state and controls exposed by `I18nProvider`. |
| `TranslateFunction` | Type alias | I18n | Signature of the `t()` translation function. |
| `TranslationLoader` | Type alias | I18n | Signature of the async loader that fetches a locale's translations. |
| `AuthProvider` | Component | Auth | BFF auth provider: resolves configuration and supplies session state and actions. |
| `AuthGuard` | Component | Auth | Renders its children only for authenticated sessions; redirects otherwise. |
| `useAuth` | Hook | Auth | Accesses auth state and actions. |
| `AUTH_DEFAULTS` | Constant | Auth | Default auth configuration values, merged with user config on mount. |
| `AuthConfig` | Interface | Auth | Auth configuration input — `basePath` plus optional overrides. |
| `AuthUser` | Interface | Auth | Authenticated user: the OIDC `sub` claim plus additional claims. |
| `AuthContextValue` | Interface | Auth | Session state and actions exposed by `AuthProvider`. |
| `AuthProviderProps` | Interface | Auth | Props of `AuthProvider`. |
| `ResolvedAuthConfig` | Interface | Auth | Fully resolved auth config with all defaults applied. |
| `useAuthorization` | Hook | Authorization | Reads the session user's roles and permissions as predicates. |
| `RequireAccess` | Component | Authorization | Guards a route or area; redirects signed-in users who lack the required grant. |
| `Can` | Component | Authorization | Renders its children only when the required grant is held. |
| `UseAuthorizationResult` | Interface | Authorization | Grants and predicates returned by `useAuthorization`. |
| `RequireAccessProps` | Interface | Authorization | Props of `RequireAccess`. |
| `CanProps` | Interface | Authorization | Props of `Can`. |

---

## GlobalLoader

The GlobalLoader module provides a single, application-wide loading overlay: a full-screen CSS spinner with an optional caption below it. `GlobalLoaderProvider` renders the overlay and owns its state; any descendant turns it on and off through `useGlobalLoader()`. Hiding the overlay clears the caption automatically.

### GlobalLoaderProvider

Renders the loading overlay for its subtree and supplies loader state and controls to all descendants via React context (consumed with [`useGlobalLoader`](#usegloballoader)). While visible, the overlay covers the viewport with the configured background color and shows a pure-CSS spinner — no images or animation libraries — with an optional caption.

Configuration is captured when the provider mounts and is not reactive: changing the `config` prop later has no effect, and the provider must be remounted to apply different values. Omitted properties fall back to the defaults listed under [`GlobalLoaderConfig`](#globalloaderconfig).

```typescript fragment
function GlobalLoaderProvider(props: GlobalLoaderProviderProps): ReactElement
```

**Props** — [`GlobalLoaderProviderProps`](#globalloaderproviderprops).

**Example**

```typescript
import { GlobalLoaderProvider } from "blendsdk/react";
import type { ReactElement, ReactNode } from "react";

function LoadingText({ text, textColor }: { text: string; textColor: string }): ReactElement {
    return <strong style={{ color: textColor, fontSize: 16 }}>{text}</strong>;
}

export function App({ children }: { children: ReactNode }) {
    return (
        <GlobalLoaderProvider
            config={{
                spinnerColor: "#25b09b",
                backgroundColor: "#ffffff",
                textComponent: LoadingText,
            }}
        >
            {children}
        </GlobalLoaderProvider>
    );
}
```

### useGlobalLoader

Consumer hook for the GlobalLoader context. Returns the current visibility state and the two controls: `showLoader` toggles the overlay, and `setText` writes the caption shown below the spinner. Hiding the overlay clears the caption automatically.

```typescript fragment
function useGlobalLoader(): GlobalLoaderContextValue
```

**Parameters** — None.

**Returns** — [`GlobalLoaderContextValue`](#globalloadercontextvalue): `showLoader`, `setText`, and `visible`.

**Throws** — `Error` when called outside a `<GlobalLoaderProvider>`: `useGlobalLoader() must be used within a <GlobalLoaderProvider>.`

**Example**

```typescript
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function RefreshButton() {
    const { showLoader, setText, visible } = useGlobalLoader();

    const handleRefresh = async () => {
        setText("Refreshing data…");
        showLoader(true);
        try {
            const response = await fetch("/api/refresh", { method: "POST" });
            if (!response.ok) {
                throw new Error(`Refresh failed with status ${response.status}`);
            }
        } catch (error) {
            console.error("Could not refresh the data:", error);
        } finally {
            showLoader(false); // hides the overlay and clears the caption
        }
    };

    return (
        <button onClick={handleRefresh} disabled={visible}>
            Refresh
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <RefreshButton />
        </GlobalLoaderProvider>
    );
}
```

### GlobalLoaderConfig

Appearance configuration for the loading overlay. All properties are optional; values are captured when `GlobalLoaderProvider` mounts.

```typescript fragment
const config: GlobalLoaderConfig = {
    spinnerColor: "#25b09b",
    textColor: "#333333",
    zIndex: 10000,
};
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `spinnerColor` | `string` | No | `"#888888"` | CSS color for the spinner arc. |
| `spinnerWidth` | `number` | No | `3` | Spinner arc width (padding) in pixels. |
| `backgroundColor` | `string` | No | `"#fafafa"` | Background color of the full-screen overlay. |
| `spinnerSize` | `number` | No | `50` | Spinner diameter in pixels. |
| `textColor` | `string` | No | `"#888888"` | CSS color for the text below the spinner (same default as `spinnerColor`). |
| `zIndex` | `number` | No | `999999` | CSS z-index for the overlay. |
| `textComponent` | `(props: { text: string; textColor: string }) => ReactElement` | No | `<p>` caption | Custom render function for the text below the spinner. Receives `{ text, textColor }` and must return a `ReactElement`. The default renders a `<p>` with `color: textColor`, `fontSize: 14px`, and `marginTop: 16px`. |

### GlobalLoaderContextValue

The context value exposed by `GlobalLoaderProvider` and returned by [`useGlobalLoader`](#usegloballoader).

| Property | Type | Description |
|----------|------|-------------|
| `showLoader` | `(visible: boolean) => void` | Shows or hides the loader overlay. Hiding automatically clears the text. |
| `setText` | `(text: string \| null) => void` | Sets the message displayed below the spinner. Pass `null` or `""` to clear. |
| `visible` | `boolean` | Current visibility state of the loader (read-only). |

### GlobalLoaderProviderProps

Props of [`GlobalLoaderProvider`](#globalloaderprovider).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `config` | `GlobalLoaderConfig` | No | Optional configuration. Defaults are applied for all omitted properties. |
| `children` | `ReactNode` | Yes | Application subtree. |

---

## I18n

The I18n module adds runtime internationalization, backed by `blendsdk/i18n`. Translations are fetched asynchronously through an application-supplied [`TranslationLoader`](#translationloader) rather than bundled at compile time; components translate keys through `t()` with interpolation and plural support, and `setLocale()` switches locales live without a page reload. A locale switch triggers a re-fetch and shows the [GlobalLoader](#globalloader) overlay while the new catalog loads.

### I18nProvider

Provider component for the I18n feature. On mount it invokes the `loader` for `defaultLocale` (default `'en'`) and makes the resulting catalog available to the subtree as the translation function `t()`. `ready` is `true` once translations have loaded successfully. Because `setLocale()` shows the GlobalLoader overlay while translations load, `GlobalLoaderProvider` should wrap `I18nProvider`. The optional `onMissingTranslation` callback reports keys that cannot be resolved.

```typescript fragment
function I18nProvider(props: I18nProviderProps): ReactElement
```

**Props** — [`I18nProviderProps`](#i18nproviderprops).

**Example**

```typescript
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
        return <p>Loading translations…</p>;
    }

    return <h1>{t("app.greeting", { name: "Ada" })}</h1>;
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

### useTranslations

Consumer hook for the I18n context. Returns the translation function `t()`, the current `locale`, a `setLocale()` function for switching locales, a `reloadTranslations()` control, and a `ready` boolean indicating whether translations are loaded.

```typescript fragment
function useTranslations(): I18nContextValue
```

**Parameters** — None.

**Returns** — [`I18nContextValue`](#i18ncontextvalue): `t`, `locale`, `setLocale`, `reloadTranslations`, and `ready`.

**Throws** — `Error` when called outside an `<I18nProvider>`: `useTranslations() must be used within an <I18nProvider>.`

**Example**

```typescript
import { GlobalLoaderProvider, I18nProvider, useTranslations, type TranslationLoader } from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function LanguageSwitcher() {
    const { t, locale, setLocale, ready } = useTranslations();

    return (
        <button onClick={() => setLocale(locale === "en" ? "nl" : "en")} disabled={!ready}>
            {t("common.switchLanguage")}
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <LanguageSwitcher />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

### I18nProviderProps

Props of [`I18nProvider`](#i18nprovider).

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `loader` | `TranslationLoader` | Yes | — | Async function that loads translations for a given locale. |
| `defaultLocale` | `string` | No | `'en'` | Default locale to load on mount. |
| `onMissingTranslation` | `(key: string, locale: string) => void` | No | — | Optional callback invoked when a translation key is not found. |
| `children` | `ReactNode` | Yes | — | Application subtree. |

### I18nContextValue

The context value exposed by `I18nProvider` and returned by [`useTranslations`](#usetranslations).

| Property | Type | Description |
|----------|------|-------------|
| `t` | `TranslateFunction` | Translation function — `t('key', params?) → string`. |
| `locale` | `string` | Current active locale. |
| `setLocale` | `(locale: string) => void` | Switch to a different locale. Triggers a re-fetch through the loader and shows the GlobalLoader overlay while loading. |
| `reloadTranslations` | `() => void` | Force re-fetch of translations for the current locale (e.g., after a server-side reload). |
| `ready` | `boolean` | `true` when translations have been loaded successfully. |

### TranslateFunction

Signature of the translation function exposed as `t`. Translates a key with optional interpolation parameters; supports plurals via the `count` parameter.

```typescript fragment
type TranslateFunction = (key: string, params?: Record<string, unknown>) => string;
```

**Example**

```typescript fragment
const label: string = t("auth.login.button");
const summary: string = t("inbox.unread", { count: 3 });
```

### TranslationLoader

Signature of the async loader the application supplies for fetching a locale's translations. Returns a flat map of translation keys to values; the provider wraps the returned map into a translation catalog internally. (`TranslationValue` comes from `blendsdk/i18n`.)

```typescript fragment
type TranslationLoader = (locale: string) => Promise<Record<string, TranslationValue>>;
```

**Example**

```typescript
import type { TranslationLoader } from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loader: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};
```

---

## Auth

The Auth module implements the front end of BFF (backend-for-frontend) authentication for OIDC. A backend-for-frontend performs the OIDC round-trip and owns an httpOnly cookie session, so OIDC tokens never reach JavaScript; this module maintains that session from the browser — login redirect, session discovery via the `me` endpoint, automatic refresh ahead of expiry, logout, and CSRF handling. Configuration is merged with [`AUTH_DEFAULTS`](#auth_defaults) on mount and published fully resolved as [`ResolvedAuthConfig`](#resolvedauthconfig); `AuthGuard` turns session state into route protection, and the authorization helpers built on top of it are documented in the [Authorization](#authorization) section.

Redirect-based components (`AuthGuard`, `RequireAccess`) rely on `react-router`, an optional peer dependency, for navigation.

### AuthProvider

Provider component for BFF authentication. Merges the supplied `AuthConfig` with `AUTH_DEFAULTS` on mount into a fully resolved config, performs the initial session check against the configured `me` endpoint, and supplies [`AuthContextValue`](#authcontextvalue) to its subtree. When `autoRefresh` is enabled, the provider refreshes the session `refreshLeadTime` seconds before the session expires. The resolved configuration is exposed to consumers as `AuthContextValue.config`.

Mount `AuthProvider` where the protected subtree begins — `AuthGuard`, `RequireAccess`, and the auth hooks read its context and must live inside it.

```typescript fragment
function AuthProvider(props: AuthProviderProps): ReactElement
```

**Props** — [`AuthProviderProps`](#authproviderprops).

**Example**

```typescript
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionBar() {
    const { user, isAuthenticated, isLoading, login, logout } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return <button onClick={() => login()}>Sign in</button>;
    }

    return (
        <div>
            <span>Signed in as {user?.sub}</span>
            <button onClick={() => logout()}>Sign out</button>
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
```

### AuthGuard

Route protection component. When a session is authenticated, `AuthGuard` renders its children; otherwise it redirects the visitor to the frontend route configured by [`loginPath`](#authconfig) (default `/login`). Navigation uses `react-router` — an optional peer dependency — so mount the guard inside the router used by the application.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `children` | `ReactNode` | Yes | The protected subtree, rendered when the session is authenticated. |

**Example**

```typescript
import { AuthGuard, AuthProvider } from "blendsdk/react";
import { BrowserRouter, Route, Routes } from "react-router";

function Dashboard() {
    return <h1>Dashboard</h1>;
}

function LoginPage() {
    return <h1>Sign in</h1>;
}

export function App() {
    return (
        <BrowserRouter>
            <AuthProvider config={{ basePath: "/api/auth" }}>
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
            </AuthProvider>
        </BrowserRouter>
    );
}
```

### useAuth

Consumer hook for the auth context. Returns the current session state — `user`, `isAuthenticated`, `isLoading`, `expiresAt`, `authorized`, `csrfToken`, and the resolved `config` — together with the action functions `login`, `logout`, and `refresh`.

```typescript fragment
function useAuth(): AuthContextValue
```

**Parameters** — None.

**Returns** — [`AuthContextValue`](#authcontextvalue): session state and auth actions.

**Throws** — `Error` when called outside an `<AuthProvider>`: `useAuth() must be used within an <AuthProvider>.`

**Example**

```typescript
import { AuthProvider, useAuth } from "blendsdk/react";

function ProfileButton() {
    const { user, isAuthenticated, authorized, login, logout } = useAuth();

    if (!isAuthenticated) {
        return <button onClick={() => login()}>Sign in</button>;
    }

    if (!authorized) {
        return <p>Signed in as {user?.sub}, but not allowed.</p>;
    }

    return <button onClick={() => logout()}>Sign out ({user?.sub})</button>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <ProfileButton />
        </AuthProvider>
    );
}
```

### AUTH_DEFAULTS

Default configuration values for the auth module, merged with user-provided config when `AuthProvider` mounts. Endpoint paths are relative to `basePath` (e.g., `basePath: "/api/auth"` with the default `login` endpoint resolves to `/api/auth/login`). The object is declared `as const`, so every value carries a literal type.

```typescript fragment
const AUTH_DEFAULTS = {
    endpoints: {
        login: "/login",
        callback: "/callback",
        logout: "/logout",
        me: "/me",
        refresh: "/refresh",
    },
    loginPath: "/login",
    notAuthorizedPath: "/not-authorized",
    defaultReturnTo: "/",
    autoRefresh: true,
    refreshLeadTime: 60,
    csrfHeader: "x-csrf-token",
} as const;
```

| Key | Value | Description |
|-----|-------|-------------|
| `endpoints.login` | `"/login"` | Login endpoint, relative to `basePath`. |
| `endpoints.callback` | `"/callback"` | OIDC callback endpoint, relative to `basePath`. |
| `endpoints.logout` | `"/logout"` | Logout endpoint, relative to `basePath`. |
| `endpoints.me` | `"/me"` | Session check endpoint, relative to `basePath`. |
| `endpoints.refresh` | `"/refresh"` | Session refresh endpoint, relative to `basePath`. |
| `loginPath` | `"/login"` | Frontend route path for the login page; `AuthGuard` redirects here. |
| `notAuthorizedPath` | `"/not-authorized"` | Frontend route path shown when a signed-in user lacks a required grant; `RequireAccess` redirects here. |
| `defaultReturnTo` | `"/"` | Frontend path to redirect to after login. |
| `autoRefresh` | `true` | Refresh tokens before expiry. |
| `refreshLeadTime` | `60` | Seconds before expiry to trigger a refresh. |
| `csrfHeader` | `"x-csrf-token"` | Header carrying the per-session CSRF token. |

### AuthConfig

Configuration for BFF auth endpoints and behavior. `basePath` is required — all other properties have defaults defined in `AUTH_DEFAULTS`; user-provided values are merged with the defaults on mount, producing a [`ResolvedAuthConfig`](#resolvedauthconfig).

```typescript fragment
const config: AuthConfig = {
    basePath: "/api/auth",
    loginPath: "/sign-in",
    refreshLeadTime: 120,
};
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `basePath` | `string` | Yes | — | Base path for all BFF auth endpoints (e.g., `/api/auth`). |
| `endpoints` | `{ login?: string; callback?: string; logout?: string; me?: string; refresh?: string }` | No | `AUTH_DEFAULTS.endpoints` | Override individual endpoint paths relative to `basePath`. Omitted endpoints fall back to their defaults. |
| `loginPath` | `string` | No | `"/login"` | Frontend route path for the login page; `AuthGuard` redirects here. |
| `notAuthorizedPath` | `string` | No | `"/not-authorized"` | Frontend route path shown when a signed-in user lacks a required grant; `RequireAccess` redirects here. |
| `defaultReturnTo` | `string` | No | `"/"` | Frontend path to redirect to after login. |
| `autoRefresh` | `boolean` | No | `true` | Auto-refresh tokens before expiry. |
| `refreshLeadTime` | `number` | No | `60` | Seconds before expiry to trigger a refresh. |
| `csrfHeader` | `string` | No | `"x-csrf-token"` | Header carrying the per-session CSRF token returned by `GET /me` and `POST /refresh`. Must match the server's `csrf.header` value when it differs from the default. |

### AuthUser

Authenticated user from the OIDC session. The `sub` (subject) claim is required per the OIDC Core spec; additional claims from the identity provider are available via the index signature.

| Property | Type | Description |
|----------|------|-------------|
| `sub` | `string` | Subject identifier from the OIDC provider. |
| `[key: string]` | `unknown` | Additional claims attached to the session by the identity provider. |

Claim values are typed `unknown` — narrow them before use:

```typescript fragment
const email: string | undefined = typeof user["email"] === "string" ? user["email"] : undefined;
```

### AuthContextValue

The context value exposed by `AuthProvider` and returned by [`useAuth`](#useauth).

| Property | Type | Description |
|----------|------|-------------|
| `user` | `AuthUser \| null` | Current authenticated user, or `null` if not authenticated. |
| `isAuthenticated` | `boolean` | Whether the user is currently authenticated — derived from `user !== null`. |
| `isLoading` | `boolean` | Whether the initial session check is in progress. |
| `login` | `(returnTo?: string) => void` | Redirects to the BFF login endpoint. The optional `returnTo` path sets the post-login destination (defaults to the configured `defaultReturnTo`). |
| `logout` | `() => Promise<void>` | Signs out via the BFF logout endpoint and clears local state. |
| `refresh` | `() => Promise<boolean>` | Manually refreshes the session. Returns `true` on success, `false` on failure. |
| `expiresAt` | `number \| null` | Unix timestamp (seconds) when the session expires, or `null` if unknown. |
| `authorized` | `boolean` | Whether the server considers the current session authorized — see below. |
| `csrfToken` | `string \| null` | The per-session CSRF token for state-changing BFF calls, or `null` when CSRF is not enforced — see below. |
| `config` | `ResolvedAuthConfig` | Resolved configuration with all defaults applied. |

**Details**

- **`authorized`** is `true` only when `GET /me` returned a session that is not marked `authorized: false`. It is `false` before the first check, for anonymous or failed checks, for a session the application denied, and after logout. An unauthorized session is still authenticated (`isAuthenticated` remains `true`).
- **`csrfToken`** comes from `GET /me`, or from the value returned by `POST /refresh`; it is `null` when CSRF is not enforced. Send it in `config.csrfHeader` on state-changing BFF calls. The server regenerates the token only when session-id rotation is enabled; a token replaced by another browsing context is not observed until the next session check, so a request made with an outdated token can be rejected with `403`.

### AuthProviderProps

Props of [`AuthProvider`](#authprovider).

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `config` | `AuthConfig` | Yes | Auth configuration — `basePath` is required, other values have defaults. |
| `children` | `ReactNode` | Yes | Application subtree that will have access to auth context. |

### ResolvedAuthConfig

Fully resolved auth config with all properties required, including nested endpoint paths. Produced by merging user config with `AUTH_DEFAULTS` when `AuthProvider` mounts; exposed to consumers as `AuthContextValue.config`.

```typescript fragment
endpoints: {
    login: string;
    callback: string;
    logout: string;
    me: string;
    refresh: string;
};
```

| Property | Type | Description |
|----------|------|-------------|
| `basePath` | `string` | Base path for all BFF auth endpoints. |
| `endpoints` | `Required<NonNullable<AuthConfig["endpoints"]>>` | All endpoint paths — fully resolved (`login`, `callback`, `logout`, `me`, `refresh` as `string`), no optionals. |
| `loginPath` | `string` | Frontend route path for the login page. |
| `notAuthorizedPath` | `string` | Frontend route path shown when a signed-in user lacks a required grant. |
| `defaultReturnTo` | `string` | Frontend path to redirect to after login. |
| `autoRefresh` | `boolean` | Whether auto-refresh is enabled. |
| `refreshLeadTime` | `number` | Seconds before expiry to trigger a refresh. |
| `csrfHeader` | `string` | Header carrying the per-session CSRF token. |

---

## Authorization

The Authorization module is the presentation side of access control. It derives the session user's canonical roles and permissions — stored on the session by the server — and evaluates grant checks in the UI through predicates and declarative components, all backed by `blendsdk/authz`. These checks shape the interface; they are never a security boundary, because the server remains the authority that enforces access.

### useAuthorization

Reads the current user's roles and permissions from the auth session and returns them together with two predicates: `hasRole(role)` and `can(permission)`. The grants are the canonical ones the server stored on the session user after translating the provider identity; an anonymous user holds nothing. The result is memoized on the session user, so the returned values and functions stay stable between renders.

The user object is treated as untrusted runtime data: a missing value or a value that is not an array becomes an empty list, non-string entries are discarded, and duplicates are removed (the first occurrence wins). A user with no session or with malformed grants therefore produces an empty principal, and every predicate returns `false` — requirements fail closed instead of throwing. The predicates delegate to `blendsdk/authz` (`hasRole` / `hasPermission`), keeping UI checks consistent with the rest of the BlendSDK authorization stack.

Presentation only: a hidden button is a convenience, never a security boundary.

```typescript fragment
function useAuthorization(): UseAuthorizationResult
```

**Parameters** — None.

**Returns** — [`UseAuthorizationResult`](#useauthorizationresult): `roles`, `permissions`, `hasRole`, and `can`.

**Throws** — Calls `useAuth()` internally, so it throws when no `<AuthProvider>` is present.

**Example**

```typescript
import { AuthProvider, useAuthorization } from "blendsdk/react";

function InvoiceToolbar() {
    const { roles, permissions, hasRole, can } = useAuthorization();

    return (
        <div role="toolbar" aria-label="Invoice actions">
            <p>Roles: {roles.length > 0 ? roles.join(", ") : "none"}</p>
            <p>Permissions: {permissions.length > 0 ? permissions.join(", ") : "none"}</p>
            {hasRole("finance") && <span className="badge">Finance</span>}
            {can("invoice:write") && <button>Edit invoice</button>}
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

### RequireAccess

Declarative guard for a route or area. It renders the guarded content when the current user holds the required grant; a signed-in user who lacks the grant is redirected to the frontend route configured by [`notAuthorizedPath`](#authconfig) (default `/not-authorized`).

- Requirements are evaluated against the session user's canonical grants with the same fail-closed rules as [`useAuthorization`](#useauthorization) — an anonymous session holds no grants and can never satisfy a requirement.
- Relies on `react-router` (optional peer dependency) for navigation.
- Presentation only — the server remains the authority that enforces access.

**Props** — [`RequireAccessProps`](#requireaccessprops). For the underlying predicates, see the [`useAuthorization`](#useauthorization) example.

### Can

Declarative check for a single element. `Can` renders its children only when the current user holds the required grant — the right tool for buttons, menu entries, and other individual controls.

- Evaluates the same canonical grants through the same `blendsdk/authz` predicates as [`useAuthorization`](#useauthorization), and fails closed for anonymous users and malformed grant sets.
- Presentation only — hiding an element is a convenience, never a security boundary.

**Props** — [`CanProps`](#canprops). For the underlying predicates, see the [`useAuthorization`](#useauthorization) example.

### UseAuthorizationResult

The grants and predicates returned by [`useAuthorization`](#useauthorization).

| Property | Type | Description |
|----------|------|-------------|
| `roles` | `readonly string[]` | Roles the current user holds. |
| `permissions` | `readonly string[]` | Permissions the current user holds. |

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `hasRole` | `hasRole(role: string): boolean` | `boolean` | Reports whether the current user holds a role. |
| `can` | `can(permission: string): boolean` | `boolean` | Reports whether the current user holds a permission. |

### RequireAccessProps

Props for [`RequireAccess`](#requireaccess), exported as a type from the package root. The interface expresses the grant requirement a user must hold before the guarded route or area is rendered. Requirements are evaluated against the session user's canonical grants with the same fail-closed rules as [`useAuthorization`](#useauthorization): an anonymous session holds no grants and never satisfies a requirement, and when a signed-in user's requirement is not met, `RequireAccess` redirects to the resolved [`notAuthorizedPath`](#authconfig).

### CanProps

Props for [`Can`](#can), exported as a type from the package root. The interface expresses the grant requirement for the gated element and the content rendered when the requirement is met. Evaluation follows the same canonical grants and fail-closed rules as [`useAuthorization`](#useauthorization).

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
