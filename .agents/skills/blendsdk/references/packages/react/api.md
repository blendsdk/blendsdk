> **Package**: `blendsdk/react`

# react API Reference

This document is the complete reference for every symbol re-exported by `src/index.ts`. Symbols are grouped by module — Global Loader, I18n, Auth, and State — and every module follows the same Provider / Context / Hook shape. All information below is derived from the package source; internal modules that the package root does not re-export are not part of the public contract.

---

## Public API Index

| Symbol | Kind | Section |
|---|---|---|
| `GlobalLoaderProvider` | Component | [GlobalLoaderProvider](#globalloaderprovider) |
| `useGlobalLoader` | Hook | [useGlobalLoader](#usegloballoader) |
| `GlobalLoaderConfig` | Interface | [GlobalLoaderConfig](#globalloaderconfig) |
| `GlobalLoaderContextValue` | Interface | [GlobalLoaderContextValue](#globalloadercontextvalue) |
| `GlobalLoaderProviderProps` | Interface | [GlobalLoaderProviderProps](#globalloaderproviderprops) |
| `I18nProvider` | Component | [I18nProvider](#i18nprovider) |
| `useTranslations` | Hook | [useTranslations](#usetranslations) |
| `TranslationLoader` | Type alias | [TranslationLoader](#translationloader) |
| `TranslateFunction` | Type alias | [TranslateFunction](#translatefunction) |
| `I18nProviderProps` | Interface | [I18nProviderProps](#i18nproviderprops) |
| `I18nContextValue` | Interface | [I18nContextValue](#i18ncontextvalue) |
| `AuthProvider` | Component | [AuthProvider](#authprovider) |
| `AuthGuard` | Component | [AuthGuard](#authguard) |
| `useAuth` | Hook | [useAuth](#useauth) |
| `AUTH_DEFAULTS` | Constant | [AUTH_DEFAULTS](#auth_defaults) |
| `useAuthorization` | Hook | [useAuthorization](#useauthorization) |
| `RequireAccess` | Component | [RequireAccess](#requireaccess) |
| `Can` | Component | [Can](#can) |
| `AuthConfig` | Interface | [AuthConfig](#authconfig) |
| `AuthUser` | Interface | [AuthUser](#authuser) |
| `AuthContextValue` | Interface | [AuthContextValue](#authcontextvalue) |
| `AuthProviderProps` | Interface | [AuthProviderProps](#authproviderprops) |
| `ResolvedAuthConfig` | Interface | [ResolvedAuthConfig](#resolvedauthconfig) |
| `UseAuthorizationResult` | Interface | [UseAuthorizationResult](#useauthorizationresult) |
| `RequireAccessProps` | Interface | [RequireAccessProps](#requireaccessprops) |
| `CanProps` | Interface | [CanProps](#canprops) |
| `useObjectState` | Hook | [useObjectState](#useobjectstate) |
| `ObjectStateSetter` | Type alias | [ObjectStateSetter](#objectstatesetter) |
| `ObjectStateReset` | Type alias | [ObjectStateReset](#objectstatereset) |
| `UseObjectStateResult` | Type alias | [UseObjectStateResult](#useobjectstateresult) |

**Peer requirements**

| Peer | Version | Required | Needed by |
|---|---|---|---|
| `react` | `^19.0.0` | Yes | All providers, hooks, and components |
| `react-dom` | `^19.0.0` | Yes | Host application renderer |
| `react-router` | `^7.0.0` | No | `AuthGuard`, `RequireAccess` |

Install the umbrella package together with its peers — a subpath such as `blendsdk/react` is an import path, not a separately installable package:

```bash
npm install blendsdk react react-dom
```

---

## Global Loader

Controls one application-wide full-screen overlay with a CSS-drawn spinner and an optional message.

### GlobalLoaderProvider

React component that owns the overlay state and renders the overlay above its subtree. Configuration is captured on mount and is **not reactive** — remount the provider to apply a different configuration.

```typescript fragment
function GlobalLoaderProvider(props: GlobalLoaderProviderProps): ReactElement;
```

**Props** — see [`GlobalLoaderProviderProps`](#globalloaderproviderprops).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `config` | `GlobalLoaderConfig` | No | `{}` (all defaults applied) | Appearance configuration for the overlay. Captured on mount. |
| `children` | `ReactNode` | Yes | — | Application subtree that gains access to the loader context. |

**Returns** — `ReactElement`. Renders `children` wrapped by the loader context and, when visible, the overlay itself.

**Example**

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
        <button type="button" disabled={visible} onClick={() => void save()}>
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
                zIndex: 1000,
            }}
        >
            <SaveButton />
        </GlobalLoaderProvider>
    );
}
```

---

### useGlobalLoader

Hook that returns the control surface of the nearest `GlobalLoaderProvider`.

```typescript fragment
function useGlobalLoader(): GlobalLoaderContextValue;
```

**Parameters** — none.

**Returns** — [`GlobalLoaderContextValue`](#globalloadercontextvalue).

| Property | Type | Description |
|---|---|---|
| `showLoader` | `(visible: boolean) => void` | Shows or hides the overlay. Passing `false` also clears the current text. |
| `setText` | `(text: string \| null) => void` | Sets the message below the spinner. `null` or `""` clears it. Does not change visibility. |
| `visible` | `boolean` | Current visibility of the overlay. Read-only. |

**Throws** — `Error` when called outside a `<GlobalLoaderProvider>`:

```text
useGlobalLoader() must be used within a <GlobalLoaderProvider>. Wrap your component tree with <GlobalLoaderProvider> to use this hook.
```

**Example** — see [GlobalLoaderProvider](#globalloaderprovider).

---

### GlobalLoaderConfig

Appearance configuration for the overlay. Every property is optional; omitted properties use the defaults listed below.

```typescript fragment
interface GlobalLoaderConfig {
    spinnerColor?: string;
    spinnerWidth?: number;
    backgroundColor?: string;
    spinnerSize?: number;
    textColor?: string;
    zIndex?: number;
    textComponent?: (props: { text: string; textColor: string }) => ReactElement;
}
```

| Property | Type | Default | Description |
|---|---|---|---|
| `spinnerColor` | `string` | `"#888888"` | CSS color of the spinner arc. |
| `spinnerWidth` | `number` | `3` | Spinner arc width (padding), in pixels. |
| `backgroundColor` | `string` | `"#fafafa"` | Background color of the full-screen overlay. |
| `spinnerSize` | `number` | `50` | Spinner diameter, in pixels. |
| `textColor` | `string` | `"#888888"` | CSS color of the message below the spinner. |
| `zIndex` | `number` | `999999` | CSS `z-index` of the overlay. |
| `textComponent` | `(props: { text: string; textColor: string }) => ReactElement` | Paragraph element | Custom renderer for the message. Receives the current `text` and the resolved `textColor`. |

The default renderer is a `<p>` element with `color: textColor`, `fontSize: 14px`, and `marginTop: 16px`.

> The defaults above are applied internally by the provider. The internal defaults object is not re-exported from the package root, so read the values from this table rather than importing the constant.

**Example — custom text renderer**

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";
import type { GlobalLoaderConfig } from "blendsdk/react";

const loaderConfig: GlobalLoaderConfig = {
    spinnerColor: "#0f62fe",
    textColor: "#161616",
    textComponent: ({ text, textColor }) => (
        <strong style={{ color: textColor, fontSize: 16 }}>{text}</strong>
    ),
};

function Importer() {
    const { showLoader, setText } = useGlobalLoader();

    const importInvoices = async (): Promise<void> => {
        setText("Importing invoices…");
        showLoader(true);
        try {
            await fetch("/api/invoices/import", { method: "POST" });
        } finally {
            showLoader(false);
        }
    };

    return (
        <button type="button" onClick={() => void importInvoices()}>
            Import
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider config={loaderConfig}>
            <Importer />
        </GlobalLoaderProvider>
    );
}
```

---

### GlobalLoaderContextValue

The value carried by the loader context and returned by `useGlobalLoader()`.

```typescript fragment
interface GlobalLoaderContextValue {
    showLoader: (visible: boolean) => void;
    setText: (text: string | null) => void;
    visible: boolean;
}
```

| Property | Type | Description |
|---|---|---|
| `showLoader` | `(visible: boolean) => void` | Shows or hides the overlay. Hiding automatically clears the text. |
| `setText` | `(text: string \| null) => void` | Sets the message displayed below the spinner. Pass `null` or `""` to clear. |
| `visible` | `boolean` | Current visibility state of the loader (read-only). |

**Example**

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function LoaderStatus() {
    const { visible } = useGlobalLoader();
    return <p>{visible ? "Busy" : "Idle"}</p>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <LoaderStatus />
        </GlobalLoaderProvider>
    );
}
```

---

### GlobalLoaderProviderProps

```typescript fragment
interface GlobalLoaderProviderProps {
    config?: GlobalLoaderConfig;
    children: ReactNode;
}
```

| Property | Type | Description |
|---|---|---|
| `config` | `GlobalLoaderConfig \| undefined` | Optional configuration. Defaults applied for all omitted properties. |
| `children` | `ReactNode` | Application subtree. |

---

## I18n

Asynchronous translation loading for React applications. The application supplies a `TranslationLoader`; the provider wraps the returned flat key/value map into a `TranslationCatalog` from `blendsdk/i18n` and exposes `t()` to descendants.

### I18nProvider

React component that loads translations for a locale and provides them through context. Translation fetches report progress through the global loader, so mount this provider inside `<GlobalLoaderProvider>`.

```typescript fragment
function I18nProvider(props: I18nProviderProps): ReactElement;
```

**Props** — see [`I18nProviderProps`](#i18nproviderprops).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `loader` | `TranslationLoader` | Yes | — | Async function that loads a flat translation map for a locale. |
| `defaultLocale` | `string` | No | `"en"` | Locale loaded on mount. |
| `onMissingTranslation` | `(key: string, locale: string) => void` | No | — | Called when a translation key is not found. |
| `children` | `ReactNode` | Yes | — | Application subtree. |

**Returns** — `ReactElement`.

**Example**

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

---

### useTranslations

Hook that returns the translation context of the nearest `I18nProvider`.

```typescript fragment
function useTranslations(): I18nContextValue;
```

**Parameters** — none.

**Returns** — [`I18nContextValue`](#i18ncontextvalue).

| Property | Type | Description |
|---|---|---|
| `t` | `TranslateFunction` | Translates a key with optional interpolation parameters. |
| `locale` | `string` | Active locale. |
| `setLocale` | `(locale: string) => void` | Switches locale and re-fetches translations through the loader. |
| `reloadTranslations` | `() => void` | Re-fetches translations for the current locale. |
| `ready` | `boolean` | `true` when translations have loaded successfully. |

**Throws** — `Error` when called outside an `<I18nProvider>`:

```text
useTranslations() must be used within an <I18nProvider>. Wrap your component tree with <I18nProvider> to use this hook.
```

**Example**

```tsx
import { GlobalLoaderProvider, I18nProvider, useTranslations } from "blendsdk/react";
import type { TranslationLoader } from "blendsdk/react";

const loader: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    return response.json();
};

function LoginButton() {
    const { t, ready } = useTranslations();
    return (
        <button type="button" disabled={!ready}>
            {ready ? t("auth.login.button") : "…"}
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loader} defaultLocale="en">
                <LoginButton />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

---

### TranslationLoader

Function type the application implements to supply translations. The provider converts the returned flat map into a catalog internally.

```typescript fragment
type TranslationLoader = (locale: string) => Promise<Record<string, TranslationValue>>;
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locale` | `string` | Yes | Locale to load translations for. |

**Returns** — `Promise<Record<string, TranslationValue>>` — a flat map of translation keys to values. `TranslationValue` is exported by `blendsdk/i18n`.

**Example**

```typescript
import type { TranslationLoader } from "blendsdk/react";

const loadFromCdn: TranslationLoader = async (locale) => {
    const response = await fetch(`https://cdn.example.com/i18n/${locale}.json`);
    if (!response.ok) {
        throw new Error(`Could not load translations for "${locale}"`);
    }
    return response.json();
};
```

---

### TranslateFunction

Signature of the `t()` translation function exposed by `useTranslations()`.

```typescript fragment
type TranslateFunction = (key: string, params?: Record<string, unknown>) => string;
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | `string` | Yes | Translation key, for example `"auth.login.button"`. |
| `params` | `Record<string, unknown>` | No | Interpolation values. A `count` entry selects plural forms. |

**Returns** — `string` — the translated text.

**Example**

```typescript
import type { TranslateFunction } from "blendsdk/react";

const formatItemCount = (t: TranslateFunction, count: number): string =>
    t("cart.items", { count });

export const summary = formatItemCount(
    (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
    2,
);
```

---

### I18nProviderProps

```typescript fragment
interface I18nProviderProps {
    loader: TranslationLoader;
    defaultLocale?: string;
    onMissingTranslation?: (key: string, locale: string) => void;
    children: ReactNode;
}
```

| Property | Type | Required | Description |
|---|---|---|---|
| `loader` | `TranslationLoader` | Yes | Async source of translations for a locale. |
| `defaultLocale` | `string` | No | Locale loaded on mount. Default: `"en"`. |
| `onMissingTranslation` | `(key: string, locale: string) => void` | No | Callback invoked when a key cannot be resolved. |
| `children` | `ReactNode` | Yes | Application subtree. |

---

### I18nContextValue

```typescript fragment
interface I18nContextValue {
    t: TranslateFunction;
    locale: string;
    setLocale: (locale: string) => void;
    reloadTranslations: () => void;
    ready: boolean;
}
```

| Property | Type | Description |
|---|---|---|
| `t` | `TranslateFunction` | Translation function: `t('key', params?) → string`. |
| `locale` | `string` | Current active locale. |
| `setLocale` | `(locale: string) => void` | Switches to a different locale and triggers a re-fetch through the loader. |
| `reloadTranslations` | `() => void` | Forces a re-fetch for the current locale, for example after a server-side reload. |
| `ready` | `boolean` | `true` when translations have been loaded successfully. |

---

## Auth

Session-based authentication against an OIDC backend-for-frontend (BFF), plus declarative and imperative authorization. The browser never handles access or refresh tokens; the BFF holds an HttpOnly session cookie and `GET {basePath}{endpoints.me}` hydrates the client state.

### AuthProvider

React component that resolves configuration, hydrates the session, schedules automatic refresh, and provides auth context to descendants.

```typescript fragment
function AuthProvider(props: AuthProviderProps): ReactElement;
```

**Props** — see [`AuthProviderProps`](#authproviderprops).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `config` | `AuthConfig` | Yes | — | Auth configuration. `basePath` is required; all other properties fall back to `AUTH_DEFAULTS`. |
| `children` | `ReactNode` | Yes | — | Application subtree that gains access to the auth context. |

**Returns** — `ReactElement`.

**Behavior**

- Merges `config` with `AUTH_DEFAULTS` once on mount into a [`ResolvedAuthConfig`](#resolvedauthconfig), available as `useAuth().config`.
- Performs the initial session check against `GET {basePath}{endpoints.me}` while `isLoading` is `true`.
- With `autoRefresh` enabled (default), schedules a refresh `refreshLeadTime` seconds before `expiresAt`.
- Exposes the per-session CSRF token returned by `me`/`refresh` as `csrfToken`.

**Example**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";

const authConfig: AuthConfig = {
    basePath: "/api/auth",
    loginPath: "/sign-in",
    defaultReturnTo: "/dashboard",
    autoRefresh: true,
    refreshLeadTime: 30,
};

function SessionBar() {
    const { user, isAuthenticated, isLoading, authorized, login, logout } = useAuth();

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

    return (
        <section>
            <p>Signed in as {user.sub}</p>
            <p>Authorized: {authorized ? "yes" : "no"}</p>
            <button type="button" onClick={() => void logout()}>
                Sign out
            </button>
        </section>
    );
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <SessionBar />
        </AuthProvider>
    );
}
```

---

### AuthGuard

React component that gates a subtree on authentication. An unauthenticated user is redirected to `config.loginPath`; an authenticated user sees `children`.

```typescript fragment
function AuthGuard(props: { children: ReactNode }): ReactElement;
```

**Props**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `children` | `ReactNode` | Yes | — | Subtree rendered when the user is authenticated. |

**Returns** — `ReactElement`, or a router redirect to `config.loginPath`.

**Router requirement** — performs a redirect and therefore needs the optional `react-router` peer. It must render inside a router (for example `BrowserRouter`). `AuthGuard` has no dedicated exported props interface; it accepts `children`.

**Example**

```tsx
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
            <AuthProvider config={{ basePath: "/api/auth", loginPath: "/login" }}>
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

---

### useAuth

Hook that returns the auth context of the nearest `AuthProvider`.

```typescript fragment
function useAuth(): AuthContextValue;
```

**Parameters** — none.

**Returns** — [`AuthContextValue`](#authcontextvalue).

| Property | Type | Description |
|---|---|---|
| `user` | `AuthUser \| null` | Current authenticated user, or `null` when anonymous. |
| `isAuthenticated` | `boolean` | `true` when `user !== null`. |
| `isLoading` | `boolean` | `true` while the initial session check is in progress. |
| `login` | `(returnTo?: string) => void` | Navigates to the BFF login endpoint, optionally with a post-login return path. |
| `logout` | `() => Promise<void>` | Signs out through the BFF logout endpoint and clears local state. |
| `refresh` | `() => Promise<boolean>` | Manually refreshes the session; resolves `true` on success, `false` on failure. |
| `expiresAt` | `number \| null` | Unix timestamp in seconds when the session expires, or `null` if unknown. |
| `authorized` | `boolean` | Whether the server considers the session authorized. |
| `csrfToken` | `string \| null` | Per-session CSRF token, or `null` when CSRF is not enforced. |
| `config` | `ResolvedAuthConfig` | Fully resolved configuration with defaults applied. |

**Throws** — `Error` when called outside an `<AuthProvider>`:

```text
useAuth() must be used within an <AuthProvider>. Wrap your component tree with <AuthProvider> to use this hook.
```

**Example — CSRF-aware state-changing call**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function InvoiceActions() {
    const { csrfToken, config, authorized, refresh } = useAuth();

    const deleteInvoice = async (): Promise<void> => {
        const headers: Record<string, string> = {};
        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        const response = await fetch("/api/invoices/42", {
            method: "DELETE",
            headers,
        });
        if (!response.ok) {
            throw new Error(`Delete failed with ${response.status}`);
        }
    };

    const refreshSession = async (): Promise<void> => {
        const refreshed = await refresh();
        if (!refreshed) {
            console.warn("Session refresh failed");
        }
    };

    return (
        <div>
            <button type="button" onClick={() => void refreshSession()}>
                Refresh session
            </button>
            {authorized && (
                <button type="button" onClick={() => void deleteInvoice()}>
                    Delete invoice
                </button>
            )}
        </div>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <InvoiceActions />
        </AuthProvider>
    );
}
```

---

### AUTH_DEFAULTS

Default auth configuration values, merged with user config on mount. Declared `as const`, so every property keeps its literal type.

```typescript fragment
const AUTH_DEFAULTS: {
    readonly endpoints: {
        readonly login: "/login";
        readonly callback: "/callback";
        readonly logout: "/logout";
        readonly me: "/me";
        readonly refresh: "/refresh";
    };
    readonly loginPath: "/login";
    readonly notAuthorizedPath: "/not-authorized";
    readonly defaultReturnTo: "/";
    readonly autoRefresh: true;
    readonly refreshLeadTime: 60;
    readonly csrfHeader: "x-csrf-token";
};
```

| Property | Value | Description |
|---|---|---|
| `endpoints.login` | `"/login"` | BFF login endpoint, relative to `basePath`. |
| `endpoints.callback` | `"/callback"` | BFF OIDC callback endpoint, relative to `basePath`. |
| `endpoints.logout` | `"/logout"` | BFF logout endpoint, relative to `basePath`. |
| `endpoints.me` | `"/me"` | BFF session endpoint, relative to `basePath`. |
| `endpoints.refresh` | `"/refresh"` | BFF refresh endpoint, relative to `basePath`. |
| `loginPath` | `"/login"` | Frontend login route used by `AuthGuard`. |
| `notAuthorizedPath` | `"/not-authorized"` | Frontend route used by `RequireAccess` when a grant is missing. |
| `defaultReturnTo` | `"/"` | Frontend path to redirect to after login. |
| `autoRefresh` | `true` | Whether the session is refreshed before expiry. |
| `refreshLeadTime` | `60` | Seconds before expiry that trigger the refresh. |
| `csrfHeader` | `"x-csrf-token"` | Header carrying the per-session CSRF token. |

**Default resolution table**

| `AuthConfig` property | Effective default |
|---|---|
| `endpoints.login` | `AUTH_DEFAULTS.endpoints.login` |
| `endpoints.callback` | `AUTH_DEFAULTS.endpoints.callback` |
| `endpoints.logout` | `AUTH_DEFAULTS.endpoints.logout` |
| `endpoints.me` | `AUTH_DEFAULTS.endpoints.me` |
| `endpoints.refresh` | `AUTH_DEFAULTS.endpoints.refresh` |
| `loginPath` | `AUTH_DEFAULTS.loginPath` |
| `notAuthorizedPath` | `AUTH_DEFAULTS.notAuthorizedPath` |
| `defaultReturnTo` | `AUTH_DEFAULTS.defaultReturnTo` |
| `autoRefresh` | `AUTH_DEFAULTS.autoRefresh` |
| `refreshLeadTime` | `AUTH_DEFAULTS.refreshLeadTime` |
| `csrfHeader` | `AUTH_DEFAULTS.csrfHeader` |

**Example — build a config from the defaults**

```tsx
import { AUTH_DEFAULTS, AuthProvider, useAuth } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";

const authConfig: AuthConfig = {
    ...AUTH_DEFAULTS,
    basePath: "/api/auth",
    endpoints: {
        ...AUTH_DEFAULTS.endpoints,
        me: "/session",
        refresh: "/session/refresh",
    },
    refreshLeadTime: 30,
};

function SessionSummary() {
    const { config, isLoading } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    return (
        <ul>
            <li>Session endpoint: {config.basePath}{config.endpoints.me}</li>
            <li>Refresh endpoint: {config.basePath}{config.endpoints.refresh}</li>
            <li>Refresh lead time: {config.refreshLeadTime}s</li>
            <li>CSRF header: {config.csrfHeader}</li>
        </ul>
    );
}

export function App() {
    return (
        <AuthProvider config={authConfig}>
            <SessionSummary />
        </AuthProvider>
    );
}
```

> `endpoints.login` is the BFF endpoint used by `login()`; `loginPath` is the frontend route used by `AuthGuard`. They serve different purposes and may have different values.

---

### useAuthorization

Hook that reads the current user's canonical grants from the session and exposes role and permission predicates. Derived from `useAuth()`, so it must be used inside `<AuthProvider>`.

```typescript fragment
function useAuthorization(): UseAuthorizationResult;
```

**Parameters** — none.

**Returns** — [`UseAuthorizationResult`](#useauthorizationresult).

| Property | Type | Description |
|---|---|---|
| `roles` | `readonly string[]` | Roles the current user holds. |
| `permissions` | `readonly string[]` | Permissions the current user holds. |
| `hasRole` | `(role: string) => boolean` | Reports whether the current user holds a role. |
| `can` | `(permission: string) => boolean` | Reports whether the current user holds a permission. |

**Principal derivation** — grants come from the session user's `roles` and `permissions` properties and are treated as untrusted runtime data:

| Input | Result |
|---|---|
| Missing or non-array value | Empty list |
| Non-string array entries | Ignored |
| Duplicate strings | Removed; the first occurrence wins |
| Anonymous user (`user === null`) | Empty principal |

The result is memoized on the user object; `hasRole` and `can` are stable while the user is unchanged. Evaluation delegates to `hasRole()` and `hasPermission()` from `blendsdk/authz`.

**Throws** — propagates the `useAuth()` error when called outside `<AuthProvider>`.

**Example**

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

---

### RequireAccess

React component that gates a subtree on a grant. A signed-in user without the required grant is redirected to `config.notAuthorizedPath`.

```typescript fragment
function RequireAccess(props: RequireAccessProps): ReactElement;
```

**Props** — see [`RequireAccessProps`](#requireaccessprops). Grant props mirror the `useAuthorization()` vocabulary: `role` corresponds to `hasRole()`, `permission` corresponds to `can()`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `role` | `string` | No | — | Role the current user must hold. |
| `permission` | `string` | No | — | Permission the current user must hold. |
| `children` | `ReactNode` | Yes | — | Subtree rendered when the requirement is met. |

**Returns** — `ReactElement`, or a router redirect to `config.notAuthorizedPath`.

**Router requirement** — performs a redirect and therefore needs the optional `react-router` peer.

**Example**

```tsx
import { AuthProvider, RequireAccess } from "blendsdk/react";
import { BrowserRouter, Route, Routes } from "react-router";

function FinanceReports() {
    return <h1>Finance reports</h1>;
}

function NotAuthorized() {
    return <h1>You do not have access to this page.</h1>;
}

export function App() {
    return (
        <BrowserRouter>
            <AuthProvider
                config={{
                    basePath: "/api/auth",
                    notAuthorizedPath: "/not-authorized",
                }}
            >
                <Routes>
                    <Route path="/not-authorized" element={<NotAuthorized />} />
                    <Route
                        path="/finance"
                        element={
                            <RequireAccess role="finance" permission="invoice:read">
                                <FinanceReports />
                            </RequireAccess>
                        }
                    />
                </Routes>
            </AuthProvider>
        </BrowserRouter>
    );
}
```

---

### Can

React component that conditionally renders a UI fragment when the current user holds the required grant. It never redirects.

```typescript fragment
function Can(props: CanProps): ReactElement | null;
```

**Props** — see [`CanProps`](#canprops).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `role` | `string` | No | — | Role the current user must hold. |
| `permission` | `string` | No | — | Permission the current user must hold. |
| `children` | `ReactNode` | Yes | — | Fragment rendered when the requirement is met. |

**Returns** — `ReactElement` when the requirement is met; otherwise nothing is rendered.

**Router requirement** — none. `Can` reads `useAuthorization()` only, so it works outside a router as long as it is inside `<AuthProvider>`.

**Example**

```tsx
import { AuthProvider, Can } from "blendsdk/react";

function InvoiceToolbar() {
    return (
        <div>
            <Can permission="invoice:write">
                <button type="button">Edit invoice</button>
            </Can>
            <Can role="finance">
                <span>Finance</span>
            </Can>
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

> Client-side checks are presentation only. The BFF must enforce the same roles and permissions on every endpoint; a hidden or absent element is a convenience, never a security boundary.

---

### AuthConfig

Configuration accepted by `AuthProvider`. `basePath` is required; every other property has a default in [`AUTH_DEFAULTS`](#auth_defaults). User values are merged with the defaults on mount.

```typescript fragment
interface AuthConfig {
    basePath: string;
    endpoints?: {
        login?: string;
        callback?: string;
        logout?: string;
        me?: string;
        refresh?: string;
    };
    loginPath?: string;
    notAuthorizedPath?: string;
    defaultReturnTo?: string;
    autoRefresh?: boolean;
    refreshLeadTime?: number;
    csrfHeader?: string;
}
```

| Property | Type | Required | Default | Description |
|---|---|---|---|---|
| `basePath` | `string` | Yes | — | Base path for all BFF auth endpoints, for example `"/api/auth"`. |
| `endpoints` | `{ login?: string; callback?: string; logout?: string; me?: string; refresh?: string }` | No | `AUTH_DEFAULTS.endpoints` | Overrides individual endpoint paths relative to `basePath`. |
| `loginPath` | `string` | No | `"/login"` | Frontend route for the login page; `AuthGuard` redirects here. |
| `notAuthorizedPath` | `string` | No | `"/not-authorized"` | Frontend route shown when a signed-in user lacks a required grant; `RequireAccess` redirects here. |
| `defaultReturnTo` | `string` | No | `"/"` | Frontend path to redirect to after login. |
| `autoRefresh` | `boolean` | No | `true` | Refresh the session before it expires. |
| `refreshLeadTime` | `number` | No | `60` | Seconds before expiry that trigger the refresh. |
| `csrfHeader` | `string` | No | `"x-csrf-token"` | Header carrying the per-session CSRF token. Must match the server's `csrf.header` value when it differs from the default. |

**Example**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";
import type { AuthConfig } from "blendsdk/react";

const config: AuthConfig = {
    basePath: "/api/auth",
    endpoints: {
        login: "/sign-in",
        callback: "/sign-in/callback",
        logout: "/sign-out",
        me: "/session",
        refresh: "/session/refresh",
    },
    loginPath: "/login",
    notAuthorizedPath: "/no-access",
    defaultReturnTo: "/dashboard",
    autoRefresh: true,
    refreshLeadTime: 45,
    csrfHeader: "x-xsrf-token",
};

function EndpointSummary() {
    const { config: resolved } = useAuth();
    return <code>{resolved.basePath}{resolved.endpoints.me}</code>;
}

export function App() {
    return (
        <AuthProvider config={config}>
            <EndpointSummary />
        </AuthProvider>
    );
}
```

---

### AuthUser

Authenticated user from the OIDC session, as returned by the BFF's `me` endpoint.

```typescript fragment
interface AuthUser {
    sub: string;
    [key: string]: unknown;
}
```

| Property | Type | Description |
|---|---|---|
| `sub` | `string` | Subject identifier from the OIDC provider. Required per the OIDC Core specification. |
| `[key: string]` | `unknown` | Additional claims from the identity provider, including `roles` and `permissions` read by `useAuthorization()`. |

**Example**

```tsx
import { type AuthUser } from "blendsdk/react";

const user: AuthUser = {
    sub: "248289761001",
    name: "Ada Lovelace",
    roles: ["finance"],
    permissions: ["invoice:read", "invoice:write"],
};

const label = `${user.sub} (${user.name === undefined ? "unnamed" : String(user.name)})`;

export { label };
```

---

### AuthContextValue

Context value provided by `AuthProvider` and returned by `useAuth()`.

```typescript fragment
interface AuthContextValue {
    user: AuthUser | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    login: (returnTo?: string) => void;
    logout: () => Promise<void>;
    refresh: () => Promise<boolean>;
    expiresAt: number | null;
    authorized: boolean;
    csrfToken: string | null;
    config: ResolvedAuthConfig;
}
```

| Property | Type | Description |
|---|---|---|
| `user` | `AuthUser \| null` | Current authenticated user, or `null` if not authenticated. |
| `isAuthenticated` | `boolean` | Whether a user is present (derived from `user !== null`). |
| `isLoading` | `boolean` | Whether the initial session check is in progress. |
| `login` | `(returnTo?: string) => void` | Redirects to the BFF login endpoint. Optional post-login return path. |
| `logout` | `() => Promise<void>` | Signs out via the BFF logout endpoint and clears local state. |
| `refresh` | `() => Promise<boolean>` | Manually refreshes the session. Resolves `true` on success, `false` on failure. |
| `expiresAt` | `number \| null` | Unix timestamp (seconds) when the session expires, or `null` if unknown. |
| `authorized` | `boolean` | Whether the server considers the current session authorized. |
| `csrfToken` | `string \| null` | Per-session CSRF token from `me` or `refresh`, or `null` when CSRF is not enforced. |
| `config` | `ResolvedAuthConfig` | Resolved configuration with all defaults applied. |

**`authorized` semantics**

| Situation | `authorized` |
|---|---|
| Before the first session check | `false` |
| Session returned without `authorized: false` | `true` |
| Anonymous session | `false` |
| Failed session check | `false` |
| Session the application denied | `false` |
| After logout | `false` |

`authorized` is independent of `isAuthenticated`: a signed-in session that the server did not authorize has `isAuthenticated === true` and `authorized === false`.

**`csrfToken` semantics**

The token is a snapshot of the value returned by `GET /me` or `POST /refresh`. Send it in `config.csrfHeader` on state-changing BFF calls. The server regenerates the token only when session-id rotation is enabled; a token replaced by another browsing context is not observed until the next session check, so a request made with an outdated token can be rejected with `403`.

**Example** — see [useAuth](#useauth).

---

### AuthProviderProps

```typescript fragment
interface AuthProviderProps {
    config: AuthConfig;
    children: ReactNode;
}
```

| Property | Type | Description |
|---|---|---|
| `config` | `AuthConfig` | Auth configuration. `basePath` is required; other values have defaults. |
| `children` | `ReactNode` | Application subtree that will have access to the auth context. |

---

### ResolvedAuthConfig

Fully resolved auth configuration with all properties required, produced by merging [`AuthConfig`](#authconfig) with [`AUTH_DEFAULTS`](#auth_defaults) on mount. Available as `useAuth().config`.

```typescript fragment
interface ResolvedAuthConfig {
    basePath: string;
    endpoints: Required<NonNullable<AuthConfig["endpoints"]>>;
    loginPath: string;
    notAuthorizedPath: string;
    defaultReturnTo: string;
    autoRefresh: boolean;
    refreshLeadTime: number;
    csrfHeader: string;
}
```

| Property | Type | Description |
|---|---|---|
| `basePath` | `string` | Base path for all BFF auth endpoints. |
| `endpoints` | `{ login: string; callback: string; logout: string; me: string; refresh: string }` | All endpoint paths — fully resolved, no optionals. |
| `loginPath` | `string` | Frontend route path for the login page. |
| `notAuthorizedPath` | `string` | Frontend route path shown when a signed-in user lacks a required grant. |
| `defaultReturnTo` | `string` | Frontend path to redirect to after login. |
| `autoRefresh` | `boolean` | Whether auto-refresh is enabled. |
| `refreshLeadTime` | `number` | Seconds before expiry that trigger a refresh. |
| `csrfHeader` | `string` | Header carrying the per-session CSRF token. |

**Example**

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";
import type { ResolvedAuthConfig } from "blendsdk/react";

function ResolvedConfigView() {
    const { config } = useAuth();
    const resolved: ResolvedAuthConfig = config;

    return (
        <dl>
            <dt>me</dt>
            <dd>{`${resolved.basePath}${resolved.endpoints.me}`}</dd>
            <dt>refresh</dt>
            <dd>{`${resolved.basePath}${resolved.endpoints.refresh}`}</dd>
            <dt>loginPath</dt>
            <dd>{resolved.loginPath}</dd>
            <dt>notAuthorizedPath</dt>
            <dd>{resolved.notAuthorizedPath}</dd>
            <dt>defaultReturnTo</dt>
            <dd>{resolved.defaultReturnTo}</dd>
            <dt>autoRefresh</dt>
            <dd>{resolved.autoRefresh ? "enabled" : "disabled"}</dd>
            <dt>refreshLeadTime</dt>
            <dd>{resolved.refreshLeadTime}</dd>
            <dt>csrfHeader</dt>
            <dd>{resolved.csrfHeader}</dd>
        </dl>
    );
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <ResolvedConfigView />
        </AuthProvider>
    );
}
```

---

### UseAuthorizationResult

The grants and predicates returned by [`useAuthorization`](#useauthorization).

```typescript fragment
interface UseAuthorizationResult {
    roles: readonly string[];
    permissions: readonly string[];
    hasRole(role: string): boolean;
    can(permission: string): boolean;
}
```

| Property | Type | Description |
|---|---|---|
| `roles` | `readonly string[]` | Roles the current user holds. |
| `permissions` | `readonly string[]` | Permissions the current user holds. |
| `hasRole` | `(role: string) => boolean` | Reports whether the current user holds a role. |
| `can` | `(permission: string) => boolean` | Reports whether the current user holds a permission. |

**Example**

```tsx
import { AuthProvider, useAuthorization } from "blendsdk/react";
import type { UseAuthorizationResult } from "blendsdk/react";

function AccessSummary() {
    const authorization: UseAuthorizationResult = useAuthorization();
    const granted =
        authorization.hasRole("finance") && authorization.can("invoice:write");

    return <p>{granted ? "Invoice editing allowed" : "Read-only access"}</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AccessSummary />
        </AuthProvider>
    );
}
```

---

### RequireAccessProps

```typescript fragment
interface RequireAccessProps {
    role?: string;
    permission?: string;
    children: ReactNode;
}
```

| Property | Type | Required | Description |
|---|---|---|---|
| `role` | `string` | No | Role the current user must hold. Evaluated with `hasRole()`. |
| `permission` | `string` | No | Permission the current user must hold. Evaluated with `can()`. |
| `children` | `ReactNode` | Yes | Subtree rendered when the requirement is met; otherwise the user is redirected to `config.notAuthorizedPath`. |

**Example** — see [RequireAccess](#requireaccess).

---

### CanProps

```typescript fragment
interface CanProps {
    role?: string;
    permission?: string;
    children: ReactNode;
}
```

| Property | Type | Required | Description |
|---|---|---|---|
| `role` | `string` | No | Role the current user must hold. Evaluated with `hasRole()`. |
| `permission` | `string` | No | Permission the current user must hold. Evaluated with `can()`. |
| `children` | `ReactNode` | Yes | Fragment rendered when the requirement is met; otherwise nothing is rendered. |

**Example** — see [Can](#can).

---

## State

Local component state for one plain object, with partial-patch updates and a factory-based reset.

### useObjectState

Hook that manages an object-shaped piece of local component state.

```typescript fragment
function useObjectState<T extends object>(create: () => T): UseObjectStateResult<T>;
```

**Type parameters**

| Parameter | Constraint | Description |
|---|---|---|
| `T` | `extends object` | The state shape. It must be a plain object type; no index signature is required. |

**Parameters**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `create` | `() => T` | Yes | — | Lazy factory for the initial object. Runs on mount; must be pure and return a new plain object on every call. |

**Returns** — [`UseObjectStateResult<T>`](#useobjectstateresult), a three-element tuple:

| Index | Type | Description |
|---|---|---|
| `0` | `T` | Current state object. |
| `1` | `ObjectStateSetter<T>` | Shallow-merges a partial patch into the latest state. |
| `2` | `ObjectStateReset` | Re-runs the original factory and stores a fresh object. |

**Behavior**

- `setState` accepts `Partial<T>` or `(previous: T) => Partial<T>` and applies `{ ...previous, ...patch }` inside React's functional updater, so consecutive updates in the same event build on the latest state.
- `setState` and `reset` keep the same identity across renders.
- `reset` calls the factory captured on the first render and stores a **fresh** object; it does not reuse the initial reference.
- Arrays, class instances, and function values are outside the contract because object spreading drops prototypes and array behavior. Nested objects are replaced, not deep-merged. Setting a property to `undefined` leaves the key present.

**Example**

```tsx
import { useObjectState } from "blendsdk/react";

interface FormState {
    name: string;
    age: number;
    active: boolean;
}

export function ProfileForm() {
    const [state, setState, reset] = useObjectState<FormState>(() => ({
        name: "",
        age: 0,
        active: true,
    }));

    return (
        <form onSubmit={(event) => event.preventDefault()}>
            <label>
                Name
                <input
                    value={state.name}
                    onChange={(event) => setState({ name: event.target.value })}
                />
            </label>
            <button
                type="button"
                onClick={() => setState((previous) => ({ age: previous.age + 1 }))}
            >
                Older ({state.age})
            </button>
            <label>
                <input
                    type="checkbox"
                    checked={state.active}
                    onChange={(event) => setState({ active: event.target.checked })}
                />
                Active
            </label>
            <button type="button" onClick={reset}>
                Reset
            </button>
        </form>
    );
}
```

---

### ObjectStateSetter

Updates object-shaped local state with a partial patch. The callback form receives the latest state, so consecutive updates in the same event always build on each other instead of on a stale render value.

```typescript fragment
type ObjectStateSetter<T extends object> = (
    update: Partial<T> | ((previous: T) => Partial<T>),
) => void;
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `update` | `Partial<T> \| ((previous: T) => Partial<T>)` | Yes | Partial patch, or a function receiving the latest state and returning a partial patch. |

**Returns** — `void`.

**Example**

```typescript fragment
setState({ name: "Bob" });
setState(previous => ({ age: previous.age + 1 }));
```

---

### ObjectStateReset

Restores the state produced by the hook's original factory. The reset stores a fresh object rather than reusing the initial reference, so later mutations cannot leak into the reset baseline.

```typescript fragment
type ObjectStateReset = () => void;
```

**Parameters** — none.

**Returns** — `void`.

**Example**

```typescript fragment
reset();
```

---

### UseObjectStateResult

The tuple returned by [`useObjectState`](#useobjectstate).

```typescript fragment
type UseObjectStateResult<T extends object> = [
    T,
    ObjectStateSetter<T>,
    ObjectStateReset,
];
```

| Position | Type | Description |
|---|---|---|
| `0` | `T` | Current state object. |
| `1` | `ObjectStateSetter<T>` | Patch-oriented setter. |
| `2` | `ObjectStateReset` | Reset function bound to the original factory. |

**Example**

```typescript fragment
const [state, setState, reset] = useObjectState<FormState>(() => ({
    name: "Alice",
    age: 30,
    active: true,
}));
```

---

## Provider Requirement Matrix

Every hook except `useObjectState` requires its provider; calling a hook outside its provider throws an `Error` with a message naming the missing provider.

| Hook | Required provider | Also requires | Throws outside provider |
|---|---|---|---|
| `useGlobalLoader` | `GlobalLoaderProvider` | — | Yes |
| `useTranslations` | `I18nProvider` | `GlobalLoaderProvider` (mount inside it for fetch feedback) | Yes |
| `useAuth` | `AuthProvider` | — | Yes |
| `useAuthorization` | `AuthProvider` | — | Yes (via `useAuth`) |
| `useObjectState` | None | — | No |

| Component | Required provider | Router required |
|---|---|---|
| `GlobalLoaderProvider` | — | No |
| `I18nProvider` | `GlobalLoaderProvider` above it | No |
| `AuthProvider` | — | No |
| `AuthGuard` | `AuthProvider` | Yes |
| `RequireAccess` | `AuthProvider` | Yes |
| `Can` | `AuthProvider` | No |

---

## Import Reference

All public symbols resolve from the single package entry point.

```typescript fragment
import {
    // Global loader
    GlobalLoaderProvider,
    useGlobalLoader,
    // I18n
    I18nProvider,
    useTranslations,
    // Auth
    AuthProvider,
    AuthGuard,
    useAuth,
    AUTH_DEFAULTS,
    useAuthorization,
    RequireAccess,
    Can,
    // State
    useObjectState,
} from "blendsdk/react";

import type {
    GlobalLoaderConfig,
    GlobalLoaderContextValue,
    GlobalLoaderProviderProps,
    I18nProviderProps,
    I18nContextValue,
    TranslateFunction,
    TranslationLoader,
    AuthConfig,
    AuthUser,
    AuthContextValue,
    AuthProviderProps,
    ResolvedAuthConfig,
    UseAuthorizationResult,
    RequireAccessProps,
    CanProps,
    ObjectStateReset,
    ObjectStateSetter,
    UseObjectStateResult,
} from "blendsdk/react";
```

Internal modules such as `./auth/auth-provider.js`, `./global-loader/global-loader-context.js`, and `./i18n/i18n-context.js` are barrel-internal. Their types are consumed by the public context values, but the modules themselves are not part of the public contract and must not be imported directly.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
