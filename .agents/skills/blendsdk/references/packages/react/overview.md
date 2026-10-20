> **Package**: `blendsdk/react`

# react Overview

---

## What It Is

`blendsdk/react` is the React application layer of BlendSDK. It supplies the cross-cutting infrastructure of a BlendSDK single-page application — session-based authentication against an OIDC backend-for-frontend (BFF), declarative role and permission checks, asynchronous internationalization, and a global loading overlay — as a small set of context providers, guard components, and hooks. It also provides `useObjectState`, a local-state utility for object-shaped component state. The package is not a visual component library: apart from the loader overlay it renders no styled UI, leaving presentation to the application or its design system. It targets React 19, is written in strict TypeScript, ships declaration files, and exposes its entire public surface from a single ESM entry point.

| Fact | Value |
|---|---|
| Publisher | TrueSoftware B.V. |
| License | MIT |
| Module format | ESM only (`"type": "module"`) |
| Public entry | `blendsdk/react` → `dist/index.js` + `dist/index.d.ts` |
| React target | React 19 function components and hooks |
| Distribution | Private workspace package, consumed through the `blendsdk` umbrella |
| Workspace tooling | Node.js >= 22, `tsc`, Vitest, Testing Library, jsdom |

---

## Key Features

- **BFF session authentication for OIDC** — `AuthProvider` and `useAuth()` manage an HttpOnly cookie session held by a backend-for-frontend. The browser never handles access or refresh tokens. `login()`, `logout()`, and `refresh()` are exposed as actions, and the session is hydrated from the BFF's `/me` endpoint.
- **Automatic session renewal** — with `autoRefresh` enabled (the default), the provider refreshes the session before `expiresAt`; `refreshLeadTime` controls how many seconds ahead of expiry the refresh starts. Manual `refresh()` returns a boolean result.
- **CSRF-aware client state** — the per-session token returned by `/me` and `/refresh` is exposed as `csrfToken`, together with the configured `csrfHeader` name, so state-changing BFF calls can send it back.
- **Declarative authorization** — `AuthGuard` gates an unauthenticated user to the login route, `RequireAccess` gates a signed-in user without the required grant to the not-authorized route, and `Can` conditionally renders individual UI. `useAuthorization()` exposes the same rules imperatively as `roles`, `permissions`, `hasRole()`, and `can()`, backed by `blendsdk/authz`.
- **Server-aligned, fail-closed checks** — authorization is presentation only: the server remains the authority. Anonymous users and malformed `roles`/`permissions` claims produce an empty principal, so guards deny instead of throwing.
- **Asynchronous internationalization** — `I18nProvider` accepts an application-supplied `TranslationLoader`, loads a default locale on mount, and exposes `t()` with interpolation and plurals through `blendsdk/i18n`. `setLocale()` re-fetches at runtime, `reloadTranslations()` refreshes the current locale, and `onMissingTranslation` reports unknown keys.
- **Global loading overlay** — `GlobalLoaderProvider` and `useGlobalLoader()` control a full-screen, CSS-only spinner from anywhere in the tree. Spinner color, width, size, background, text color, z-index, and the text renderer are configurable; hiding the loader also clears its text.
- **Object-shaped local state** — `useObjectState()` keeps one plain object per component, applies partial patches or functional updates, and resets by re-running the original factory. The setter and reset callbacks are stable across renders.
- **Type-complete public surface** — every public value has exported companion types, including `AuthConfig`, `AuthUser`, `AuthContextValue`, `ResolvedAuthConfig`, `UseAuthorizationResult`, `RequireAccessProps`, `CanProps`, `I18nProviderProps`, `TranslationLoader`, `GlobalLoaderConfig`, and `UseObjectStateResult`. Hooks throw descriptive errors when used outside their provider.

---

## When To Use

Use `blendsdk/react` when:

- You are building a React 19 SPA against a BlendSDK BFF that exposes login, callback, logout, session, and refresh endpoints.
- You want session-cookie authentication with no token storage, refresh scheduling, or OIDC handling in browser code.
- UI visibility must follow server-issued roles and permissions while the server remains the enforcement point.
- Translations are loaded asynchronously from an API, CDN, or bundler and locales switch without a page reload.
- Long-running operations need one application-wide loading overlay instead of per-screen spinners.
- A component owns a plain object of related fields — a form, filter panel, or editor — and you want partial updates without one `useState` per field.
- You need optional React Router integration: only the redirecting guards require `react-router`; the providers and hooks do not.

Reach for something else when:

- You need a styled component library or design system. This package supplies application infrastructure, not visuals.
- Authentication is token-based in the browser or not fronted by a BFF. The auth module models a cookie session with `/me` and `/refresh`; endpoint paths are configurable, but the session contract is assumed.
- You are on React 18 or earlier. The package targets React 19.

---

## Architecture

The package is organized into four independent modules that share one public entry point and a common Provider/Context/Hook shape. Each module has its own barrel under `src/`, and only the root `src/index.ts` re-exports the public contract.

### Module Map

| Module | Public surface | Requires | Responsibility |
|---|---|---|---|
| Global loader | `GlobalLoaderProvider`, `useGlobalLoader` | `GlobalLoaderProvider` around the hook | Full-screen overlay with a CSS spinner, optional message, and configurable appearance |
| I18n | `I18nProvider`, `useTranslations` | `I18nProvider`; expects `GlobalLoaderProvider` above it | Loader-driven translations, `t()`, `locale`, `setLocale()`, `reloadTranslations()`, `ready` |
| Auth | `AuthProvider`, `AuthGuard`, `useAuth`, `useAuthorization`, `RequireAccess`, `Can`, `AUTH_DEFAULTS` | `AuthProvider`; the redirecting guards also need React Router | BFF/OIDC session state, actions, guards, role/permission predicates |
| State | `useObjectState` | none | Partial-patch state for one plain object, with reset |

### Provider Composition

A typical application tree composes the providers from the outside in. Only the I18n-inside-GlobalLoader edge is required: `I18nProvider` uses the global loader while fetching translations. The auth subtree may sit inside or outside the i18n subtree depending on whether auth UI needs translations.

```text
<GlobalLoaderProvider>                     overlay + useGlobalLoader()
└── <I18nProvider loader={...}>            translations + useTranslations()
    └── <AuthProvider config={{ basePath }}>
        ├── <AuthGuard> ... </AuthGuard>           authentication gate
        ├── <RequireAccess ...> ... </RequireAccess>   grant gate
        ├── <Can ...> ... </Can>                   element visibility
        └── application routes and components
```

`useObjectState` is provider-independent and can be used anywhere.

### Authentication Model

Authentication follows the BFF pattern. `login(returnTo?)` navigates the browser to `${basePath}${endpoints.login}`; the BFF performs the OIDC authorization-code flow and establishes an HttpOnly session cookie. `AuthProvider` then hydrates state from `${basePath}${endpoints.me}`, which returns the user, the authorization decision, the session expiry, and the CSRF token. A `POST` to `${basePath}${endpoints.refresh}` renews the session, automatically when `autoRefresh` is true and `refreshLeadTime` seconds before expiry. Logout goes through `${basePath}${endpoints.logout}` and clears local state.

Two session flags are deliberately separate:

- `isAuthenticated` means a user object is present.
- `authorized` means the server returned a session that is not marked `authorized: false`. It is `false` before the first check, for anonymous or failed checks, for a session the application denied, and after logout. A signed-in but unauthorized session therefore has `isAuthenticated === true` and `authorized === false`.

All endpoint paths and behavioral defaults are merged from `AUTH_DEFAULTS` and the user-supplied `AuthConfig` into a fully resolved `ResolvedAuthConfig` on mount. The CSRF token is the only credential the client handles; the session cookie itself is not readable by JavaScript.

### Design Patterns

- **Provider / Context / Hook** — each feature owns state in a provider, carries it through a React context, and exposes a consumer hook that throws a descriptive error outside its provider.
- **Composition over configuration** — capabilities are layered in JSX. `I18nProvider` composes the global loader; auth guards compose `AuthProvider` state.
- **Configuration resolution with defaults** — `AUTH_DEFAULTS` is merged with `AuthConfig` into `ResolvedAuthConfig`; `GlobalLoaderConfig` has defaults for every property. Global loader config is captured on mount and is not reactive, so changing it requires remounting the provider.
- **Strategy / dependency injection** — the application supplies the `TranslationLoader`, so translations can come from any source. Auth endpoint paths can be overridden relative to `basePath`.
- **Declarative guards** — `AuthGuard`, `RequireAccess`, and `Can` express access rules in JSX; `useAuthorization()` is the imperative counterpart for logic that cannot be expressed as a wrapper.
- **Fail-closed authorization** — non-array grants, non-string entries, and anonymous users all resolve to an empty principal, so requirements deny rather than crash.
- **Lazy factory and stable callbacks** — `useObjectState` runs its factory lazily on mount, shallow-merges patches into the latest state, and keeps `setState` and `reset` stable across renders; `reset` stores a fresh object.
- **Single public entry point** — internal modules are reachable only through the root barrel; the published contract is the set of symbols listed under `src/index.ts`.

---

## Dependencies

| Dependency | Version | Kind | Purpose |
|---|---|---|---|
| `react` | `^19.0.0` | Peer, required | Context, hooks, and component rendering |
| `react-dom` | `^19.0.0` | Peer, required | DOM renderer for the host application |
| `react-router` | `^7.0.0` | Peer, optional | Redirects performed by `AuthGuard` and `RequireAccess` |
| `blendsdk/authz` | Workspace | Runtime dependency | `AccessPrincipal`, `hasRole()`, `hasPermission()` |
| `blendsdk/i18n` | Workspace | Runtime dependency | `Translator` and `TranslationValue` used by the i18n module |

The runtime footprint is React 19 plus the two internal BlendSDK libraries; the package does not bundle a UI framework or a state-management library. `react-router` is declared as an optional peer: install it only when the redirecting guard components are rendered.

**Dependents.** Consumers are BlendSDK React application packages. `blendsdk/react` is `private` in the monorepo and reaches end users only through the `blendsdk` umbrella package; it is not published standalone.

**Installation in a host application.** Install the umbrella and the peer packages together:

```bash
npm install blendsdk react react-dom
```

Add `react-router` when using the guards:

```bash
npm install blendsdk react react-dom react-router
```

**Build.** `tsc` emits ESM JavaScript and declarations into `dist/`. There is no CommonJS build and no CSS file to import; the loader injects its styles at runtime.

---

## Minimum Example

The shortest complete example shows the two central pieces: a provider that owns session state and a hook that consumes it. `AuthProvider` hydrates from `GET /api/auth/me` and exposes login and logout actions; `GlobalLoaderProvider` supplies the application-wide overlay available to descendants.

```tsx
import { AuthProvider, GlobalLoaderProvider, useAuth } from "blendsdk/react";

function SessionBar() {
    const { user, isAuthenticated, isLoading, login, logout } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return <button onClick={() => login()}>Sign in</button>;
    }

    return <button onClick={() => void logout()}>Sign out ({user?.sub})</button>;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <AuthProvider config={{ basePath: "/api/auth" }}>
                <SessionBar />
            </AuthProvider>
        </GlobalLoaderProvider>
    );
}
```

`SessionBar` reads the session through `useAuth()`; `isLoading` covers the initial `/me` check, and `login()` redirects to the BFF login endpoint. The i18n and state modules compose in the same way — wrap with their provider where required, then consume with the matching hook. Their detailed contracts are covered in the module-specific documents.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
