> **Package**: `blendsdk/react`

# react Overview

---

## What It Is

`blendsdk/react` is the React integration layer of the BlendSDK monorepo. It packages three cross-cutting application concerns — a global loading overlay (GlobalLoader), asynchronous internationalization (I18n), and BFF-based OIDC authentication with client-side authorization (Auth) — behind a uniform Provider + Hook contract. The package is a private, ESM-only workspace library written in TypeScript strict mode for React 19; it ships behavioral components and hooks, not a visual design system. BlendSDK web applications consume it with `import { ... } from 'blendsdk/react'`; it is not published to npm as a standalone package.

---

## Key Features

- **Three feature modules behind one entry point** — GlobalLoader, I18n, and Auth are all re-exported from the package root; there are no subpath entries or deep imports.
- **Uniform Provider + Hook API** — every feature ships a `<Feature>Provider` component plus type-safe consumer hooks (`useGlobalLoader`, `useTranslations`, `useAuth`, `useAuthorization`). Hooks throw a descriptive error when used outside their provider.
- **GlobalLoader** — a full-screen, CSS-only spinner overlay that any component can show, annotate with a message, and hide. Spinner color, width, size, background, text color, z-index, and the text renderer are configurable; hiding the overlay clears the message automatically.
- **I18n** — translations load asynchronously through an application-supplied `loader` function; `setLocale()` switches locales at runtime and triggers a re-fetch; `t(key, params)` supports interpolation and plurals; `ready`, `reloadTranslations()`, and `onMissingTranslation` cover the loading lifecycle. Backed by `blendsdk/i18n`.
- **Auth (BFF authentication for OIDC)** — cookie-session authentication where OIDC tokens never reach JavaScript. Login, callback, logout, session (`me`), and refresh endpoints resolve relative to a single `basePath`; sessions refresh automatically ahead of expiry; the per-session CSRF token needed for state-changing calls is exposed through context. `AuthGuard` protects routes and redirects to the configured login path.
- **Authorization for the UI** — `useAuthorization`, `RequireAccess`, and `Can` derive roles and permissions from the session user and evaluate them through `blendsdk/authz`. Anonymous users and malformed grants fail closed to an empty principal; the client checks are presentation only — the server remains the authority.
- **Defaults over boilerplate** — configuration is merged with built-in defaults on mount, so only the essentials are required (`basePath` for auth, `loader` for i18n); the auth defaults are published as the `AUTH_DEFAULTS` constant.
- **Fully typed, ESM-only surface** — every public config, context value, and props interface is exported from the package root for strict TypeScript consumers.

---

## When To Use

Reach for this package when:

- You are building a React 19 front-end for a BlendSDK application and need the standard integration layer for loading, i18n, or authentication.
- You need an application-wide loading overlay that any component can drive without prop drilling or an external state library.
- Translations must be fetched at runtime from a server or API — not bundled at compile time — and users must be able to switch locales without a page reload.
- Authentication must follow the BFF pattern: httpOnly cookie sessions managed by a backend-for-frontend, with the SPA reading session state from `GET /me` and refreshing via `POST /refresh` — no tokens in the browser.
- You want declarative access control: protect routes with `AuthGuard`, redirect signed-in users who lack a grant with `RequireAccess`, and gate individual elements with `Can`.
- You want UI-level role and permission checks that stay consistent with the rest of the BlendSDK authorization stack through `blendsdk/authz`.

Look elsewhere when:

- Your application is not React — everything in this package is React 19 providers and hooks.
- You need a token-in-the-browser OIDC flow (implicit or client-side PKCE) — the auth module implements the BFF cookie-session model exclusively.
- You need a security boundary — `authorized`, `RequireAccess`, and `Can` shape the UI only; the server remains the authority.

---

## Architecture

The package is organized as three self-contained feature folders behind a single public barrel (`src/index.ts`). Each module owns its types, context, provider, and consumer hooks, and exposes the same external contract: wrap a subtree with the provider, consume state and actions with a hook. The dependency direction is strictly `Application → blendsdk/react → blendsdk/authz / blendsdk/i18n`.

### Module Map

| Module | Provider | Hooks | Guard Components |
|--------|----------|-------|------------------|
| GlobalLoader | `GlobalLoaderProvider` | `useGlobalLoader` | — |
| I18n | `I18nProvider` | `useTranslations` | — |
| Auth | `AuthProvider` | `useAuth`, `useAuthorization` | `AuthGuard`, `RequireAccess`, `Can` |

### Key Design Patterns

- **Provider + Context + Hook (dependency injection)** — each feature publishes its state and actions through React Context; hooks read that context. This is the backbone of the package and the reason every feature has the same shape.
- **Defaults-merge configuration** — user config is layered over built-in defaults on mount, and the fully resolved result is exposed to consumers; `ResolvedAuthConfig` guarantees, for example, that every endpoint path is non-optional after the merge.
- **Strategy / inversion of control** — application-specific behavior is injected as a function: the `TranslationLoader` fetches catalogs from wherever the application keeps them, and `textComponent` is a render prop for custom loading text.
- **Guard components (declarative composition)** — `AuthGuard`, `RequireAccess`, and `Can` express access rules as JSX structure instead of imperative checks, using the configured route paths (`loginPath`, `notAuthorizedPath`) for redirects.
- **Facade over internal libraries** — React-specific concerns live in this package; the heavy lifting is delegated to `blendsdk/i18n` (translation engine) and `blendsdk/authz` (grant evaluation).
- **Fail-closed behavior** — hooks throw when used outside their provider, authorization predicates return `false` for anonymous or malformed principals, and unauthenticated routes redirect instead of rendering protected content.

### Composition

Providers nest to compose the full feature set:

```tsx fragment
<GlobalLoaderProvider>
    <I18nProvider loader={loadTranslations} defaultLocale="en">
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AuthGuard>
                <App />
            </AuthGuard>
        </AuthProvider>
    </I18nProvider>
</GlobalLoaderProvider>
```

- `GlobalLoaderProvider` sits outermost: `I18nProvider` drives the overlay while translations load, so the loader must wrap it.
- `AuthProvider` is independent of the other two; mount it where the protected subtree begins and keep `AuthGuard`, `RequireAccess`, and `Can` inside it.

---

## Dependencies

The dependency surface is deliberately small: React is a required peer, React Router an optional peer, and the only runtime dependencies are internal workspace libraries.

| Dependency | Kind | Version | Purpose |
|------------|------|---------|---------|
| `react` | Peer — required | `^19.0.0` | Component and hook runtime |
| `react-dom` | Peer — required | `^19.0.0` | DOM rendering of provider trees |
| `react-router` | Peer — optional | `^7.0.0` | Navigation for the auth redirect flow (`AuthGuard`, `RequireAccess`) |
| `blendsdk/authz` | Runtime — workspace internal | — | Role and permission evaluation used by `useAuthorization` |
| `blendsdk/i18n` | Runtime — workspace internal | — | Translation engine backing the I18n module |

**Downstream — what depends on this package:** As the presentation layer, `blendsdk/react` sits at the top of the dependency graph — it is consumed by BlendSDK web applications and application templates, while lower-level libraries such as `blendsdk/authz` and `blendsdk/i18n` have no knowledge of it. The package is marked `private` in the workspace and is never published to npm on its own.

Development tooling: built with `tsc` to ESM output in `dist/`; tested with Vitest and React Testing Library under jsdom; Node.js >= 22 for the toolchain.

---

## Minimum Example

Wrap a subtree with `GlobalLoaderProvider`, then drive the overlay from any child through `useGlobalLoader()`:

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function SaveButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleSave = async () => {
        setText("Saving…");
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

Every feature follows the same shape — wrap with a provider, consume with a hook: `I18nProvider` + `useTranslations()`, `AuthProvider` + `useAuth()` and `useAuthorization()`. The dedicated feature documents cover each module in depth.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
