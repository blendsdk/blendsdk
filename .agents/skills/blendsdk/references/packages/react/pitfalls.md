> **Package**: `blendsdk/react`

# react Best Practices

This document collects the practices that keep `blendsdk/react` integrations predictable: hooks used inside the providers that own them, configuration treated as mount-time state, one owner per global concern, and client-side authorization understood as presentation rather than enforcement. Every practice is shown as a pair — the mistake first, the intended shape second — with the reasoning attached.

| # | Practice | Applies to |
|---|----------|------------|
| 1 | Call hooks only inside their provider | All hooks |
| 2 | Nest `GlobalLoaderProvider` outside `I18nProvider` | GlobalLoader, I18n |
| 3 | Import from the package root only | All |
| 4 | Treat provider config as mount-time state | GlobalLoader, Auth |
| 5 | Always hide the loader in `finally` | GlobalLoader |
| 6 | Coordinate overlapping loader users | GlobalLoader |
| 7 | Translate whole sentences with parameters | I18n |
| 8 | Validate and type the translation loader | I18n |
| 9 | Distinguish loading, authenticated, and authorized | Auth |
| 10 | Protect routes with `AuthGuard`, not hand-rolled redirects | Auth |
| 11 | Don't duplicate auto-refresh | Auth |
| 12 | Read grants through `useAuthorization()` | Authorization |

---

## Do / Don't Pairs

### 1. Call hooks only inside their provider

React context is only visible to the subtree *below* the provider — a component never sees a provider it renders itself. All consumer hooks (`useAuth`, `useTranslations`, `useGlobalLoader`) fail fast with a descriptive error when the context is missing, which is exactly the signal to restructure the tree.

**❌ Wrong** — `App` calls `useAuth()` in the same component that renders `<AuthProvider>`:

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

export function App() {
    // ❌ App renders outside the provider it returns, so useAuth() sees the
    //    null context and throws: "useAuth() must be used within an <AuthProvider>."
    const { user } = useAuth();

    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <p>Signed in as {user?.sub ?? "nobody"}</p>
        </AuthProvider>
    );
}
```

**✅ Correct** — extract a child component that consumes the context:

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionLabel() {
    const { user, isLoading } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }
    return <p>{user === null ? "Not signed in" : `Signed in as ${user.sub}`}</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionLabel />
        </AuthProvider>
    );
}
```

The provider/hook split is the package's dependency-injection mechanism: the provider owns the state, children read it. Trying to read and provide in the same expression inverts that direction.

---

### 2. Nest `GlobalLoaderProvider` outside `I18nProvider`

`I18nProvider` drives the GlobalLoader overlay while locales load — `setLocale()` triggers a loader round-trip and uses the overlay as progress feedback. Provider order is therefore dependency order: the loader provider must wrap the i18n provider.

**❌ Wrong** — the overlay is nested inside the consumer that needs it:

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
    const { t } = useTranslations();
    return <p>{t("inbox.greeting", { name: "Ada" })}</p>;
}

export function App() {
    // ❌ I18nProvider cannot reach a loader provider nested inside its own
    //    subtree, so the loading feedback for locale switches is unavailable.
    return (
        <I18nProvider loader={loadTranslations} defaultLocale="en">
            <GlobalLoaderProvider>
                <Greeting />
            </GlobalLoaderProvider>
        </I18nProvider>
    );
}
```

**✅ Correct** — mount the loader provider outermost:

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
    const { t } = useTranslations();
    return <p>{t("inbox.greeting", { name: "Ada" })}</p>;
}

export function App() {
    // ✅ Provider order follows the dependency: I18n drives the overlay,
    //    so the loader provider wraps it.
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <Greeting />
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

The same rule applies to Auth: mount `AuthProvider` where the protected subtree begins, and keep `AuthGuard` inside it — never above it.

---

### 3. Import from the package root only

The package publishes a single entry point through its `exports` map (`.` → `./dist/index.js`). Internal modules are implementation details; deep imports break the moment internals are restructured and are not guaranteed to be type-compatible.

**❌ Wrong**

```typescript fragment
// ❌ Deep import into the build output — not exported by the package and
//    not part of the public API.
import { useAuth } from "blendsdk/react/dist/auth/use-auth.js";
```

**✅ Correct**

```typescript fragment
// ✅ Everything public is re-exported from the package root.
import { useAuth, type AuthContextValue } from "blendsdk/react";
```

Every symbol listed in the public API — providers, hooks, guard components, `AUTH_DEFAULTS`, and all config/context/props types — is available from `blendsdk/react`. There is no reason to reach deeper.

---

### 4. Treat provider config as mount-time state

`GlobalLoaderProvider` captures its `config` on mount and is explicitly not reactive; `AuthProvider` merges its `AuthConfig` with `AUTH_DEFAULTS` on mount as well. Re-rendering with a different config object does not apply it — the only supported way to change configuration is to remount the provider.

**❌ Wrong** — expecting a re-render to restyle the spinner:

```tsx
import { GlobalLoaderProvider } from "blendsdk/react";
import { useState } from "react";

export function App() {
    const [spinnerColor, setSpinnerColor] = useState("#888888");

    return (
        <GlobalLoaderProvider config={{ spinnerColor }}>
            {/* ❌ Re-rendering with a new color does nothing: the provider
                captured its configuration on mount. */}
            <button onClick={() => setSpinnerColor("#25b09b")}>Use teal</button>
        </GlobalLoaderProvider>
    );
}
```

**✅ Correct** — hoist the config to module scope so the mount-time contract is visible:

```tsx
import { GlobalLoaderProvider, type GlobalLoaderConfig } from "blendsdk/react";

const loaderConfig: GlobalLoaderConfig = {
    spinnerColor: "#25b09b",
    textColor: "#25b09b",
    spinnerSize: 60,
};

export function App() {
    // ✅ Configuration is set once per provider instance.
    return (
        <GlobalLoaderProvider config={loaderConfig}>
            <p>Ready</p>
        </GlobalLoaderProvider>
    );
}
```

If the configuration genuinely must change at runtime, remount deliberately with a `key` — and budget for the side effects a remount resets (an in-flight overlay, loaded catalogs, and for auth a fresh `GET /me`):

```tsx fragment
<GlobalLoaderProvider key={theme} config={theme === "dark" ? darkLoaderConfig : lightLoaderConfig}>
    <AppContent />
</GlobalLoaderProvider>
```

---

### 5. Always hide the loader in `finally`

The overlay is global and blocking by design. If any error path skips `showLoader(false)`, the spinner stays on top of the entire application and the user is locked out of the UI. `try`/`finally` makes the cleanup unconditional.

**❌ Wrong** — an early throw skips the hide call:

```tsx
import { useGlobalLoader } from "blendsdk/react";

function DeleteProjectButton({ projectId }: { projectId: string }) {
    const { showLoader, setText } = useGlobalLoader();

    const handleDelete = async () => {
        setText("Deleting project…");
        showLoader(true);
        const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
        if (!response.ok) {
            // ❌ This throw skips showLoader(false) — the full-screen overlay
            //    now blocks every interaction in the application.
            throw new Error(`Delete failed with status ${response.status}`);
        }
        showLoader(false);
    };

    return <button onClick={handleDelete}>Delete project</button>;
}
```

**✅ Correct** — hide in `finally`, on success and failure alike:

```tsx
import { useGlobalLoader } from "blendsdk/react";

function DeleteProjectButton({ projectId }: { projectId: string }) {
    const { showLoader, setText } = useGlobalLoader();

    const handleDelete = async () => {
        setText("Deleting project…");
        showLoader(true);
        try {
            const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
            if (!response.ok) {
                throw new Error(`Delete failed with status ${response.status}`);
            }
        } catch (error) {
            console.error("Could not delete the project:", error);
        } finally {
            // ✅ Runs on success, failure, and cancellation; hiding also
            //    clears the "Deleting project…" caption.
            showLoader(false);
        }
    };

    return <button onClick={handleDelete}>Delete project</button>;
}
```

Note the second half: `showLoader(false)` already clears the caption text, so there is never a need to call `setText(null)` afterwards.

---

### 6. Coordinate overlapping loader users

Visibility is one shared boolean for the whole application, and any component may drive it. Two overlapping operations that each toggle it fight over the flag: the first one to finish calls `showLoader(false)` and hides the overlay while the other is still running — or worse, they flicker against each other.

**❌ Wrong** — two components share one flag with no coordination:

```tsx
import { useGlobalLoader } from "blendsdk/react";

function UploadButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleUpload = async () => {
        setText("Uploading…");
        showLoader(true);
        try {
            await fetch("/api/upload", { method: "POST" });
        } finally {
            // ❌ If ImportButton is still running, this hides the overlay
            //    even though work is still in flight.
            showLoader(false);
        }
    };

    return <button onClick={handleUpload}>Upload</button>;
}

function ImportButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleImport = async () => {
        setText("Importing…");
        showLoader(true);
        try {
            await fetch("/api/import", { method: "POST" });
        } finally {
            showLoader(false); // same shared flag — same race
        }
    };

    return <button onClick={handleImport}>Import</button>;
}
```

**✅ Correct** — count pending operations and hide only when the last one finishes:

```tsx
import { useGlobalLoader } from "blendsdk/react";
import { useCallback, useRef } from "react";

function usePendingLoader(): (label: string, task: () => Promise<void>) => Promise<void> {
    const { showLoader, setText } = useGlobalLoader();
    const pending = useRef(0);

    return useCallback(
        async (label: string, task: () => Promise<void>) => {
            pending.current += 1;
            setText(label);
            showLoader(true);
            try {
                await task();
            } finally {
                pending.current -= 1;
                if (pending.current === 0) {
                    showLoader(false);
                }
            }
        },
        [showLoader, setText],
    );
}

function UploadButton() {
    const runWithLoader = usePendingLoader();

    const handleUpload = async () => {
        try {
            await runWithLoader("Uploading…", async () => {
                const response = await fetch("/api/upload", { method: "POST" });
                if (!response.ok) {
                    throw new Error(`Upload failed with status ${response.status}`);
                }
            });
        } catch (error) {
            console.error("Could not upload the file:", error);
        }
    };

    return <button onClick={handleUpload}>Upload</button>;
}
```

One caveat baked into the design: the caption is a single shared string with last-writer-wins semantics, so keep labels generic ("Saving…") rather than operation-specific details.

---

### 7. Translate whole sentences with parameters

Keep each sentence in the translation catalog as a single key and pass raw values as parameters. Concatenating translated fragments hard-codes the word order of one language, and pre-formatting values hides `count` from the plural rules.

**❌ Wrong** — gluing fragments together in the component:

```tsx
import { useTranslations } from "blendsdk/react";

function UnreadBadge({ unreadCount }: { unreadCount: number }) {
    const { t } = useTranslations();

    // ❌ This fixes the English word order and hides the numeric count
    //    from the plural rules.
    return (
        <p>
            {t("inbox.youHave")} {unreadCount} {t("inbox.unreadMessages")}
        </p>
    );
}
```

**✅ Correct** — one key per sentence, raw values as parameters:

```tsx
import { useTranslations } from "blendsdk/react";

function UnreadBadge({ unreadCount }: { unreadCount: number }) {
    const { t } = useTranslations();

    // ✅ Each locale decides the word order, and the raw `count` drives
    //    plural selection inside the translation engine.
    return <p>{t("inbox.unread", { count: unreadCount })}</p>;
}
```

The `count` parameter exists precisely so the engine can pick the correct plural form — including languages with more than the English two. Formatting the number into a string before the call defeats that contract.

---

### 8. Validate and type the translation loader

The `loader` you hand to `I18nProvider` is the single input boundary for the entire translation system. It must reject failed HTTP responses and return a typed, flat key/value catalog — everything downstream trusts its shape.

**❌ Wrong** — a failed response is parsed as if it were a catalog:

```typescript
import type { TranslationLoader } from "blendsdk/react";

// ❌ A 404/500 response is parsed as if it were translations, and the untyped
//    `json()` result flows into the translation engine unchecked.
const loadTranslations: TranslationLoader = async (locale) =>
    fetch(`/api/translations/${locale}`).then((response) => response.json());
```

**✅ Correct** — check the status and type the catalog:

```typescript
import type { TranslationLoader } from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Failed to load translations for "${locale}" (HTTP ${response.status})`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};
```

A loader that resolves garbage (error pages, `null`) produces silent mistranslations that are far harder to diagnose than a thrown load error, which at least surfaces at the boundary where it happened.

---

### 9. Distinguish loading, authenticated, and authorized

Three different questions deserve three different checks: *is the session check still running* (`isLoading`), *is there a session* (`isAuthenticated`), and *does the server allow it* (`authorized`). Collapsing them produces both visual flashes and privilege bugs — an unauthorized session is still authenticated.

**❌ Wrong** — treating any signed-in session as allowed:

```tsx
import { useAuth } from "blendsdk/react";

function AdminPanel() {
    const { isAuthenticated } = useAuth();

    // ❌ Authenticated is not the same as authorized: the server can accept
    //    the session while marking it `authorized: false`, or the user may
    //    simply lack the required grants.
    return isAuthenticated ? <p>Secret data</p> : <p>Please sign in.</p>;
}
```

**✅ Correct** — check each state in order:

```tsx
import { useAuth } from "blendsdk/react";

function AdminPanel() {
    const { isLoading, isAuthenticated, authorized, user } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }
    if (!isAuthenticated) {
        return <p>Please sign in.</p>;
    }
    if (!authorized) {
        return <p>Your session is not authorized for this application.</p>;
    }
    return <p>{`Secret data for ${user?.sub}`}</p>;
}
```

`authorized` is the server's verdict — `false` before the first check, for anonymous or failed checks, and for sessions the application denied. Treating it as equivalent to `isAuthenticated` either leaks UI to unauthorized sessions or signs out users who are in fact signed in.

---

### 10. Protect routes with `AuthGuard`, not hand-rolled redirects

`AuthGuard` is the supported way to protect a subtree: it encodes the session-state handling and redirects to the configured `loginPath`. Hand-rolled redirects re-implement that logic per route, hardcode the login path, and typically break while the initial session check is running.

**❌ Wrong** — a redirect that fires before the session check settles:

```tsx
import { Navigate } from "react-router";
import { useAuth } from "blendsdk/react";

function ProtectedArea() {
    const { isAuthenticated } = useAuth();

    // ❌ `isAuthenticated` is false while the initial session check runs, so a
    //    signed-in user is bounced to /login for a moment — and the path is
    //    hardcoded instead of coming from config.loginPath.
    if (!isAuthenticated) {
        return <Navigate to="/login" replace />;
    }
    return <p>Private content</p>;
}
```

**✅ Correct** — declare the protection with the guard component:

```tsx
import { AuthGuard } from "blendsdk/react";

function ProtectedArea() {
    // ✅ AuthGuard applies the session-state handling and the configured
    //    loginPath, so this logic is written once and stays consistent with
    //    the auth configuration.
    return (
        <AuthGuard>
            <p>Private content</p>
        </AuthGuard>
    );
}
```

Note that the redirect-based components require `react-router` (an optional peer dependency) — install it in any application that uses route protection. For grant-based areas, the matching declarative form is `RequireAccess`, which redirects to `config.notAuthorizedPath`.

---

### 11. Don't duplicate auto-refresh

`AuthProvider` refreshes the session ahead of expiry automatically: `autoRefresh` defaults to `true` and the refresh fires `refreshLeadTime` seconds (default 60) before `expiresAt`. A second timer on top of it doubles the refresh traffic and races the built-in schedule.

**❌ Wrong** — a polling timer alongside the built-in refresh:

```tsx
import { useAuth } from "blendsdk/react";
import { useEffect } from "react";

function SessionRefresher() {
    const { refresh } = useAuth();

    // ❌ AuthProvider already refreshes ahead of expiry; this timer issues a
    //    second refresh every 30 s and can overlap the built-in one.
    useEffect(() => {
        const id = window.setInterval(() => {
            void refresh();
        }, 30_000);
        return () => window.clearInterval(id);
    }, [refresh]);

    return null;
}
```

**✅ Correct** — tune the built-in behavior instead of polling:

```tsx
import { AuthProvider } from "blendsdk/react";

export function App() {
    return (
        // ✅ Auto-refresh stays on; the lead time simply gives it more margin.
        <AuthProvider config={{ basePath: "/api/auth", refreshLeadTime: 120 }}>
            <p>Application</p>
        </AuthProvider>
    );
}
```

If you genuinely need custom scheduling, turn `autoRefresh` off explicitly and own the entire refresh lifecycle in one place — never run both systems at once.

---

### 12. Read grants through `useAuthorization()`

The session user is untrusted runtime data: claims arrive as `unknown` and can be missing, non-arrays, or contain non-strings. `useAuthorization()` validates the grants, fails closed to an empty principal, and keeps checks consistent with `blendsdk/authz`.

**❌ Wrong** — casting claims into authorization logic:

```tsx
import { useAuth } from "blendsdk/react";

function InvoiceToolbar() {
    const { user } = useAuth();

    // ❌ The cast silences the compiler, not reality: a missing or malformed
    //    claim makes this crash (`includes` on undefined) or pass silently.
    const roles = user?.["roles"] as string[];
    const isFinance = roles.includes("finance");

    return isFinance ? <p>Finance tools</p> : <p>Read-only</p>;
}
```

**✅ Correct** — use the validated predicates:

```tsx
import { useAuthorization } from "blendsdk/react";

function InvoiceToolbar() {
    const { hasRole, can } = useAuthorization();

    // ✅ Grants are validated (non-string entries dropped, duplicates removed)
    //    and checks fail closed to `false` for anonymous or malformed data.
    return (
        <>
            {hasRole("finance") && <p>Finance tools</p>}
            {can("invoice:write") && <button>Edit invoice</button>}
        </>
    );
}
```

The sanitization in `useAuthorization()` is the whole point: malformed grants degrade to an empty principal instead of throwing or, worse, accidentally granting access.

---

## Anti-Patterns

The mistakes below recur across integrations. Each one is a variant of ignoring a contract described in Core Concepts.

### Remounting providers on navigation or conditionally

`AuthProvider` and `I18nProvider` do their initial work on mount — a session check against `GET /me` (plus scheduling auto-refresh) and a loader fetch, respectively. Mounting them inside routed content, modals, or `key`-changing wrappers repeats that work on every remount and resets their state.

```tsx fragment
// ❌ Remounts on every navigation — each mount costs an initial GET /me
//    and a fresh auto-refresh schedule.
function AccountRoute() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <AccountPage />
        </AuthProvider>
    );
}
```

Mount each provider once, high in the tree. Use the `key`-based remount only when deliberately changing mount-captured configuration.

### Awaiting `login()`

`login()` returns `void` and performs a full browser redirect to the BFF. There is no promise to await, and any code that appears to run "after login" in the current document simply runs if the redirect never happened.

```tsx fragment
// ❌ There is nothing to await — and this line only runs if the redirect
//    never happened.
await login("/dashboard");
```

### Using `setLocale()` as a refresh control

`setLocale()` is for switching to a *different* locale; it performs a loader round-trip and drives the global overlay. To re-fetch the current locale (for example, after server-side content changed), call `reloadTranslations()` — that is the API that expresses the intent.

### Rendering translated UI before `ready`

Until `ready` is `true`, the catalog for the active locale may not have loaded, so `t()` has nothing to resolve against. Gate the first render on `ready` (as the examples do) and register `onMissingTranslation` so catalog gaps are reported instead of silently shipping unresolved keys.

### Assuming `csrfToken` is always current

A token rotated by another browsing context is only observed at the next session check; a state-changing call made with an outdated token can fail with `403`. Handle that status by calling `refresh()` and retrying once — never retry in a loop. And don't treat `csrfToken === null` as broken: it means CSRF is not enforced by the server.

### Treating `authorized: false` as signed out

An unauthorized session is still authenticated: `isAuthenticated` is `true` while `authorized` is `false`. Sending that user to the login page loops them straight back in, signed in. The UI path for denied sessions is `notAuthorizedPath` (default `/not-authorized`), which `RequireAccess` redirects to.

### Mutating a config prop

Provider configuration is read on mount and merged with defaults (`AUTH_DEFAULTS` for auth). Reassigning fields — `config.spinnerColor = "#fff"` — or passing a new object after mount has no effect. Change configuration by remounting the provider with a deliberate `key`, or not at all.

### Re-deriving BFF endpoint URLs

The resolved `config` exposed on the auth context exists so consumers never hardcode `/login`, `/me`, or `/refresh` paths, which applications may override per endpoint. Build URLs from `config.basePath` and `config.endpoints.*`, and use the provider's `login`, `logout`, and `refresh` actions instead of calling those endpoints directly.

---

## Performance Tips

Where the costs actually are in this package: provider mounts perform network work, context updates re-render every consumer, and locale switches are round-trips.

### Mount each provider exactly once

Every mount of `AuthProvider` performs the initial `GET /me` and schedules auto-refresh; every mount of `I18nProvider` invokes the loader and can show the global overlay. Keep the provider tree static — one instance per feature at the app root with stable `key`s — so navigation and re-renders never repeat that work. The `key`-based remount for config changes is a deliberate cost, not something that should happen as a side effect.

### Keep context consumers small and local

Context updates re-render every consumer of that context: a `showLoader`/`setText` change re-renders all `useGlobalLoader()` consumers, and any session change re-renders all `useAuth()`/`useAuthorization()` consumers. Call these hooks in the smallest component that needs them — the save button that toggles the overlay, the status bar that shows the user — not in a page shell that wraps the whole screen, so spinner text changes don't re-render an entire page.

### Destructure `useAuthorization()` once per component

The hook memoizes its result on the session user, so `roles`, `permissions`, `hasRole`, and `can` keep their identities while the user is unchanged. Destructure them once and reuse them — including in dependency arrays — instead of recomputing equivalent checks per element or wrapping the predicates in additional `useMemo` calls yourself.

### Batch overlay updates

Treat `setText` and `showLoader` as what they are: provider state updates that fan out to every loader consumer. Set the caption once *before* showing, toggle visibility once per operation group, and let the final hide clear the text. For overlapping operations, use the pending-counter shape from [practice 6](#6-coordinate-overlapping-loader-users) so one finished task doesn't hide progress for another that is still running.

### Make locale switches deliberate

`setLocale()` performs a network round-trip and blocks the UI with the overlay. Guard against calling it with the current locale, disable the control while a switch is in flight, and avoid rapid toggling — the cost per call is real, and each loaded catalog re-renders translation consumers. Reserve `reloadTranslations()` for when the catalog actually changed.

### Hoist configuration objects

Configuration is captured on mount, so inline object literals buy nothing but per-render allocation and the illusion that updates matter. Module-scope constants state the mount-time contract and keep render bodies identical between passes.

---

## Security Considerations

The auth module is built on a backend-for-frontend: the browser holds no OIDC tokens, and the server is the only authority. Most security rules here follow from staying inside that model.

### Keep the BFF boundary intact

In this model the browser never holds OIDC tokens — the backend-for-frontend keeps an httpOnly cookie session, and the SPA only reads session state through the configured endpoints. Don't add client code that fetches, stores, or logs tokens; don't mirror session data into `localStorage`/`sessionStorage`; keep `basePath` a same-origin path served by your BFF.

### Client-side checks are presentation, not enforcement

`authorized`, `hasRole()`, `can()`, `RequireAccess`, `Can`, and `AuthGuard` shape what the interface offers. None of them is a security boundary: the server must validate the session and grants on every endpoint, and you should assume any API URL can be called directly regardless of what the UI renders. A hidden button is a convenience; a rejecting server is control.

### Send the CSRF token on state-changing BFF calls

The per-session token from `GET /me` / `POST /refresh` is exposed as `csrfToken`, and the header name comes from `config.csrfHeader` (default `x-csrf-token`). Include it on every state-changing call.

**❌ Wrong** — a mutation with no CSRF header:

```tsx
import { useAuth } from "blendsdk/react";

function ProfileForm() {
    const { config } = useAuth();

    const handleSave = async () => {
        // ❌ A state-changing BFF call with no CSRF header — the server
        //    cannot distinguish it from a cross-site forgery.
        await fetch(`${config.basePath}/profile`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ displayName: "Ada" }),
        });
    };

    return <button onClick={handleSave}>Save</button>;
}
```

**✅ Correct** — attach the token in the configured header when CSRF is enforced:

```tsx
import { useAuth } from "blendsdk/react";

function ProfileForm() {
    const { csrfToken, config } = useAuth();

    const handleSave = async () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        try {
            const response = await fetch(`${config.basePath}/profile`, {
                method: "PUT",
                headers,
                body: JSON.stringify({ displayName: "Ada" }),
            });
            if (!response.ok) {
                throw new Error(`Saving the profile failed with status ${response.status}`);
            }
        } catch (error) {
            console.error("Could not save the profile:", error);
        }
    };

    return <button onClick={handleSave}>Save</button>;
}
```

If the server rejects with `403`, the token may have been rotated by another browsing context — call `refresh()` and retry **once** rather than looping. Keep `csrfHeader` aligned with the server's configured header name, or requests will not carry the token where the server looks for it.

### Treat the session user as untrusted input

`AuthUser` carries the required `sub` claim plus arbitrary `[key: string]: unknown` claims. Never `as`-cast claims into logic (`user["roles"] as string[]`); validate them, or read grants through `useAuthorization()`, which sanitizes the lists and fails closed on malformed data.

### Keep authenticated and authorized distinct

An unauthorized session is still an authenticated one. Show the not-authorized route (`notAuthorizedPath`) for denied sessions; don't sign the user out or send them through login again — they are already signed in, and the round-trip gains nothing.

### Only pass application-owned paths to `login(returnTo)`

The post-login destination is a classic open-redirect surface. Pass fixed, app-owned paths; if a path must come from user input (a deep link, a query parameter), validate it against an allowlist of internal routes before handing it to `login()`.

---

**See also:** react Overview · react Core Concepts

---

# react Testing Patterns

This document explains how to test code that uses `blendsdk/react` — the providers, hooks, and guard components — and how to structure the tests themselves. The toolchain is Vitest with React Testing Library under jsdom, mirroring the package's own setup. Two levels are covered: **unit tests** that isolate a component by mocking the package's hooks, and **integration tests** that render the real providers and replace only the I/O edges (the translation `loader` and `fetch`).

The patterns build on the package's public Provider + Hook contract (see Core Concepts); everything is imported from the package root, `blendsdk/react`, never from `dist/` or `src/` paths.

---

## Test Setup

### Toolchain

| Package | Version | Role |
|---------|---------|------|
| `vitest` | ^4.1.10 | Test runner, assertions, and mocking (`vi`) |
| `@testing-library/react` | ^16.3.2 | `render`, `renderHook`, `screen`, `fireEvent`, `waitFor`, `act` |
| `@testing-library/jest-dom` | ^7.0.0 | DOM matchers (`toBeInTheDocument`, `toHaveTextContent`, …) |
| `@testing-library/dom` | ^10.4.1 | Query engine underneath React Testing Library |
| `jsdom` | ^30.0.1 | DOM environment |
| `@vitest/coverage-v8` | ^4.1.10 | Coverage provider used by `npm run test:coverage` |

`react` ^19.2.8, `react-dom` ^19.2.8, and `react-router` ^8.3.0 are installed as dev dependencies for tests. `react-router` is needed only by specs that exercise `AuthGuard` and `RequireAccess`, which redirect through the router.

There are **no Docker or external-service dependencies**: every test runs in-process under jsdom.

### Vitest Configuration

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
        setupFiles: ["./vitest.setup.ts"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.{ts,tsx}"],
        },
    },
});
```

- `environment: "jsdom"` gives every test file a DOM. A file that needs a different environment can override it with a `// @vitest-environment node` docblock.
- `setupFiles` registers the jest-dom matchers and RTL cleanup (below).
- The default `include` pattern (`**/*.{test,spec}.?(c|m)[jt]s?(x)`) picks up specs in both `test/` and `src/`; this document assumes specs live in `test/` with shared utilities in `test/helpers.ts`.

### Setup File

```typescript
// vitest.setup.ts
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
```

- `@testing-library/jest-dom/vitest` adds matchers such as `toBeInTheDocument()` and `toHaveTextContent()` to `expect`.
- `cleanup()` unmounts every rendered tree and clears the document between tests. It runs explicitly so the suite works whether or not `globals` is enabled (when globals are on, RTL also auto-cleans up — the explicit call is harmless).
- `vi.unstubAllGlobals()` removes the stubbed `fetch` installed by the helpers, so no stub leaks into the next test.

### Test Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `npm test` | `vitest run --passWithNoTests --reporter=verbose` | Single CI-style run |
| `npm run test:fast` | Same as `test` | Alias for a quick full run |
| `npm run test:watch` | `vitest watch --reporter=verbose` | Watch mode during development |
| `npm run test:coverage` | `vitest run --passWithNoTests --coverage` | Run with V8 coverage |

The `--passWithNoTests` flag keeps `vitest run` green even while no test file matches yet, so the suite can be grown file by file.

### Import Conventions

| Library | What to import |
|---------|----------------|
| `vitest` | `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` |
| `@testing-library/react` | `render`, `renderHook`, `screen`, `fireEvent`, `waitFor`, `act`, `cleanup` |
| `@testing-library/jest-dom` | `@testing-library/jest-dom/vitest` (setup file only) |
| `react` | `Component` and `ReactNode` types for wrappers, harnesses, and error boundaries |
| `react-router` | `MemoryRouter`, `Routes`, `Route` (only for guard specs) |
| `blendsdk/react` | Providers, hooks, guard components, and their types — always from the package root |

A typical spec header:

```tsx fragment
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "blendsdk/react";
import { createAuthValue } from "./helpers";
```

Never import from `dist/` or `src/` internals, and never mock those paths — the package root is the only supported surface for both imports and mocks.

### Test Helpers

A single helper module keeps fixtures and doubles consistent. It exposes stub factories for each context value, an in-memory translation loader that records requested locales, and fetch utilities for auth tests.

```typescript
// test/helpers.ts
import { vi } from "vitest";
import { AUTH_DEFAULTS } from "blendsdk/react";
import type {
    AuthContextValue,
    GlobalLoaderContextValue,
    I18nContextValue,
    ResolvedAuthConfig,
    TranslationLoader,
    UseAuthorizationResult,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

/** A session payload as returned by the BFF's GET /me endpoint. */
export const authenticatedSession = {
    user: {
        sub: "user-123",
        roles: ["finance"],
        permissions: ["invoice:write"],
    },
    authorized: true,
    expiresAt: 4_102_444_800, // far future, ~year 2100
    csrfToken: "csrf-abc123",
};

/** Builds a stub AuthContextValue, defaulting to an anonymous, idle session. */
export function createAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
    const config: ResolvedAuthConfig = {
        basePath: "/api/auth",
        endpoints: { ...AUTH_DEFAULTS.endpoints },
        loginPath: AUTH_DEFAULTS.loginPath,
        notAuthorizedPath: AUTH_DEFAULTS.notAuthorizedPath,
        defaultReturnTo: AUTH_DEFAULTS.defaultReturnTo,
        autoRefresh: AUTH_DEFAULTS.autoRefresh,
        refreshLeadTime: AUTH_DEFAULTS.refreshLeadTime,
        csrfHeader: AUTH_DEFAULTS.csrfHeader,
    };

    return {
        user: null,
        isAuthenticated: false,
        isLoading: false,
        login: vi.fn(),
        logout: vi.fn(async () => {}),
        refresh: vi.fn(async () => true),
        expiresAt: null,
        authorized: false,
        csrfToken: null,
        config,
        ...overrides,
    };
}

/** Builds a stub I18nContextValue. The default `t` echoes the key. */
export function createTranslationsValue(
    overrides: Partial<I18nContextValue> = {},
): I18nContextValue {
    return {
        t: vi.fn((key: string) => key),
        locale: "en",
        setLocale: vi.fn(),
        reloadTranslations: vi.fn(),
        ready: true,
        ...overrides,
    };
}

/** Builds a stub GlobalLoaderContextValue. */
export function createLoaderValue(
    overrides: Partial<GlobalLoaderContextValue> = {},
): GlobalLoaderContextValue {
    return {
        showLoader: vi.fn(),
        setText: vi.fn(),
        visible: false,
        ...overrides,
    };
}

/** Builds a stub UseAuthorizationResult from plain grant lists. */
export function createAuthorizationValue(
    grants: { roles?: readonly string[]; permissions?: readonly string[] } = {},
): UseAuthorizationResult {
    const roles = grants.roles ?? [];
    const permissions = grants.permissions ?? [];

    return {
        roles,
        permissions,
        hasRole: (role: string) => roles.includes(role),
        can: (permission: string) => permissions.includes(permission),
    };
}

/** In-memory TranslationLoader double that records every requested locale. */
export function createTranslationLoader(
    catalogs: Record<string, Record<string, TranslationValue>>,
): { loader: TranslationLoader; calls: string[] } {
    const calls: string[] = [];

    const loader: TranslationLoader = async (locale) => {
        calls.push(locale);
        return catalogs[locale] ?? {};
    };

    return { loader, calls };
}

/** Extracts the URL string from a fetch input (string, URL, or Request). */
export function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    return input.url;
}

/** Builds a JSON Response for fetch stubs. */
export function jsonResponse<T>(data: T, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** Installs a typed fetch stub and returns it for per-test configuration. */
export function createFetchMock() {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}
```

| Helper | Purpose |
|--------|---------|
| `createAuthValue` | Stub `AuthContextValue` — anonymous, idle session by default; pass overrides per test |
| `createTranslationsValue` | Stub `I18nContextValue` — `ready: true`, `t` echoes the key unless overridden |
| `createLoaderValue` | Stub `GlobalLoaderContextValue` |
| `createAuthorizationValue` | Stub `UseAuthorizationResult` from plain role/permission lists |
| `createTranslationLoader` | Real `TranslationLoader` behavior from in-memory catalogs; records locales |
| `authenticatedSession` | Session fixture for `GET /me` (user, `authorized`, `expiresAt`, `csrfToken`) |
| `createFetchMock` | Typed `fetch` stub installed with `vi.stubGlobal` |
| `jsonResponse` | Builds a JSON `Response` (Node ≥ 22 provides the Web `Response` global) |
| `requestUrl` | Normalizes a fetch input to a URL string for assertions |

---

## Unit Testing

A unit test isolates one component from the package's context. Replace the consumer hooks the component uses with `vi.fn()`s via a partial module mock, feed them values from the helper factories, and assert two things: the rendered output, and the interactions the component requested from the hooks.

### Approach

- **Mock the hooks, not the providers.** A component that calls `useGlobalLoader`, `useTranslations`, `useAuth`, or `useAuthorization` can be rendered with no providers at all once the hook is mocked.
- **Use partial module mocks** (`importOriginal`) so every other export stays real — this keeps the helper module and unrelated components working.
- **Always set a return value** for the mocked hook — a bare `vi.fn()` returns `undefined`, and a component destructuring `const { t } = useTranslations()` would crash.
- **Assert user-visible output plus the spy calls.** "The Save button asked the loader to show" is the contract worth testing, not which internal state changed.
- **Keep mocked and real-provider tests in separate files** — `vi.mock` is file-scoped and applies to every test in the file.

### Pattern: Component With a Mocked Context Hook

A save button that drives the global loader while a request is in flight. The loader hook is mocked; the network edge is stubbed so the async path is deterministic.

```tsx
// test/save-button.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useGlobalLoader } from "blendsdk/react";
import { createFetchMock, createLoaderValue, jsonResponse } from "./helpers";

vi.mock("blendsdk/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/react")>();
    return { ...actual, useGlobalLoader: vi.fn() };
});

function SaveButton() {
    const { showLoader, setText } = useGlobalLoader();

    const handleSave = async () => {
        setText("Saving changes…");
        showLoader(true);
        try {
            const response = await fetch("/api/documents/42", { method: "PUT" });
            if (!response.ok) {
                throw new Error(`Save failed with status ${response.status}`);
            }
        } catch (error) {
            console.error("Could not save the document:", error);
        } finally {
            showLoader(false);
        }
    };

    return (
        <button
            onClick={() => {
                void handleSave();
            }}
        >
            Save document
        </button>
    );
}

it("drives the global loader around the save request", async () => {
    const setText = vi.fn();
    const showLoader = vi.fn();
    vi.mocked(useGlobalLoader).mockReturnValue(createLoaderValue({ setText, showLoader }));

    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValue(jsonResponse({ saved: true }));

    render(<SaveButton />);
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));

    expect(setText).toHaveBeenCalledWith("Saving changes…");
    expect(showLoader).toHaveBeenNthCalledWith(1, true);

    await waitFor(() => {
        expect(showLoader).toHaveBeenLastCalledWith(false);
    });
});
```

This is both a synchronous pattern (spy assertions right after `fireEvent.click`) and an asynchronous one (`waitFor` for the `finally` block that runs after the request settles).

### Pattern: Verifying the Hook Fault Contract

Each hook throws a descriptive error when used outside its provider. Assert the message through an error boundary — a robust approach under React 19, which reports uncaught render errors rather than rethrowing them from `render()`.

```tsx
// test/hook-contract.test.tsx
import { Component, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { useGlobalLoader } from "blendsdk/react";

class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
    state: { message: string | null } = { message: null };

    static getDerivedStateFromError(error: Error): { message: string | null } {
        return { message: error.message };
    }

    render(): ReactNode {
        if (this.state.message !== null) {
            return <p role="alert">{this.state.message}</p>;
        }
        return this.props.children;
    }
}

function UnwrappedConsumer() {
    useGlobalLoader();
    return <p>unreachable</p>;
}

it("throws a descriptive error outside its provider", async () => {
    render(
        <ErrorBoundary>
            <UnwrappedConsumer />
        </ErrorBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
        "useGlobalLoader() must be used within a <GlobalLoaderProvider>",
    );
});
```

React logs the boundary-caught error to the console; if the noise bothers you, add `vi.spyOn(console, "error").mockImplementation(() => {})` at the top of the test and restore it afterwards.

The full set of messages to assert against:

| Hook | Error message |
|------|---------------|
| `useGlobalLoader` | `useGlobalLoader() must be used within a <GlobalLoaderProvider>.` |
| `useTranslations` | `useTranslations() must be used within an <I18nProvider>.` |
| `useAuth` | `useAuth() must be used within an <AuthProvider>.` |
| `useAuthorization` | Fails through `useAuth()` when rendered without an `AuthProvider` wrapping the tree. |

### Synchronous vs. Asynchronous Assertions

| Situation | Tool |
|-----------|------|
| Element expected immediately after a synchronous render | `getBy*` / `queryBy*` |
| Element appears after async work (fetch, loader, locale switch) | `await findBy*` |
| Assertion on a spy after an async flow | `await waitFor(() => expect(spy)...)` |
| State change driven imperatively through a hook result | `act(() => result.current...)` |

`fireEvent` is already `act`-wrapped by React Testing Library, so click handlers that trigger state updates do not need an extra `act`.

---

## Integration Testing

An integration test renders the **real providers** and replaces only the I/O edges. For this package that means exactly two doubles: the `TranslationLoader` and `fetch` (auth). Everything else — context wiring, loading state, locale switching, CSRF exposure, guard redirects — is exercised for real.

### Approach

- **Provide the documented provider stack.** `GlobalLoaderProvider` must wrap `I18nProvider` (i18n shows the overlay while translations load). `AuthProvider` is independent and wraps the protected subtree.
- **Replace the loader with `createTranslationLoader`** — real async behavior from in-memory catalogs, with a `calls` array for assertions.
- **Stub `fetch` with `createFetchMock`.** jsdom has no network; route responses per endpoint and throw on unexpected requests so missing expectations fail loudly.
- **Add `MemoryRouter` when the test mounts `AuthGuard` or `RequireAccess`** — the redirect components navigate through `react-router`.
- **Keep auth tests hermetic**: pass `autoRefresh: false` in the test config (or a far-future `expiresAt`) so no refresh timer fires mid-test.
- **Assert request URLs, not transport details.** Use `requestUrl()` against recorded calls; the method and headers the provider sends are implementation details.

### Pattern: Full Provider Stack With Stubbed I/O

A dashboard page that consumes translations and the session at once, rendered under the real stack:

```tsx
// test/dashboard-page.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    useAuth,
    useTranslations,
} from "blendsdk/react";
import {
    authenticatedSession,
    createFetchMock,
    createTranslationLoader,
    jsonResponse,
    requestUrl,
} from "./helpers";

function DashboardPage() {
    const { t } = useTranslations();
    const { user } = useAuth();

    return (
        <main>
            <h1>{t("dashboard.title")}</h1>
            <p>{user ? user.sub : t("dashboard.anonymous")}</p>
        </main>
    );
}

describe("DashboardPage with real providers", () => {
    it("renders translated content and the session subject", async () => {
        const { loader, calls } = createTranslationLoader({
            en: {
                "dashboard.title": "Dashboard",
                "dashboard.anonymous": "Guest",
            },
        });
        const fetchMock = createFetchMock();
        fetchMock.mockResolvedValue(jsonResponse(authenticatedSession));

        render(
            <GlobalLoaderProvider>
                <I18nProvider loader={loader}>
                    <AuthProvider config={{ basePath: "/api/auth", autoRefresh: false }}>
                        <DashboardPage />
                    </AuthProvider>
                </I18nProvider>
            </GlobalLoaderProvider>,
        );

        expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
        expect(await screen.findByText("user-123")).toBeInTheDocument();
        expect(calls).toEqual(["en"]);
        expect(requestUrl(fetchMock.mock.calls[0][0])).toBe("/api/auth/me");
    });
});
```

Await every asynchronous boundary with `findBy*` — the heading waits for the loader, the subject waits for the session check — then assert the recorded I/O.

### Fidelity Notes

- jsdom does not implement navigation. Router redirects are asserted by mounting routes and checking which one renders (see the `AuthGuard` pattern under [Auth](#auth)), not by observing `window.location`.
- No request ever leaves the process: auth flows are driven entirely by the `fetch` stub, translations by the loader double.
- Client-side authorization checks are presentation only. Do not treat "the button is hidden" as an access-control test — keep a server-side test for the actual enforcement, per Core Concepts.

---

## Mocking & Stubbing

There are two techniques: mock the **hooks** to isolate a component, and mock the **provider and guard components** to neutralize infrastructure in tests about your own routing or layout. Both are built on the same Vitest mechanism.

### Partial Module Mocks

```tsx fragment
import { expect, it, vi } from "vitest";
import { useAuth, useTranslations } from "blendsdk/react";
import { createAuthValue, createTranslationsValue } from "./helpers";

vi.mock("blendsdk/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/react")>();
    return {
        ...actual,
        useAuth: vi.fn(),
        useTranslations: vi.fn(),
    };
});

it("renders a greeting for the signed-in user", () => {
    vi.mocked(useAuth).mockReturnValue(
        createAuthValue({ user: { sub: "user-123" }, isAuthenticated: true }),
    );
    vi.mocked(useTranslations).mockReturnValue(
        createTranslationsValue({ locale: "nl" }),
    );

    // render(<Greeting />) and assert against the mocked context values…
});
```

- `vi.mock` is **hoisted** to the top of the file and applies to every test in it — even above the imports. Keep mocked-hook tests in their own files.
- `importOriginal` keeps all real exports (`AUTH_DEFAULTS`, the providers, the guard components, the types) so the helper module keeps working.
- `vi.mocked(useAuth)` gives typed access to `.mockReturnValue(...)` with the hook's real return type.
- Return values persist for the whole file. Set them in each test, or reset between tests:

```typescript fragment
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuth).mockReturnValue(createAuthValue({ isLoading: true }));
});
```

### Passthrough Mocks for Providers and Guards

For tests about your own route trees or layouts, replace infrastructure components with passthroughs instead of arranging sessions and translations:

```tsx fragment
import type { ReactNode } from "react";
import type { CanProps, RequireAccessProps } from "blendsdk/react";

vi.mock("blendsdk/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/react")>();
    return {
        ...actual,
        AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
        AuthGuard: ({ children }: { children: ReactNode }) => <>{children}</>,
        Can: ({ children }: CanProps) => <>{children}</>,
        RequireAccess: ({ children }: RequireAccessProps) => <>{children}</>,
    };
});
```

This lets a spec render the application shell — `<AuthProvider>` → `<AuthGuard>` → `<Can>` — without performing a session check, requiring a router, or evaluating grants. Attributes passed by production code (endpoint config, required grants) are ignored by the passthroughs.

### What Module Mocks Do Not Change

`vi.mock("blendsdk/react", …)` replaces the package's **public entry** for the test file that imports it. Code *inside* the package keeps referencing its sibling modules directly, so:

- Mocking `useAuth` changes what your test file's `useAuth()` returns — it does **not** change what the real `AuthGuard` sees. To neutralize guards, mock the guard components themselves; to exercise them for real, drive a session through a real `AuthProvider` (see [Auth](#auth)).
- The same applies to `useGlobalLoader` and the real `I18nProvider`, which talks to the loader context internally.

### Practical Rules

- Prefer **partial** mocks (`...actual`) over full replacements — factories and unrelated components keep working.
- Don't mock `blendsdk/authz` or `blendsdk/i18n` from consumer tests; they are internal dependencies of the package. Drive their behavior through the providers and fixtures instead.
- Don't mock internal paths (`dist/`, `src/`); the package root is the only supported mock target.
- Let the setup file's `afterEach` handle `cleanup()` and `vi.unstubAllGlobals()` so stubs never leak between tests.

---

## Test Patterns by Feature

| Feature | Unit-test double | Integration harness | Key assertions |
|---------|------------------|---------------------|----------------|
| GlobalLoader | mocked `useGlobalLoader` | real `GlobalLoaderProvider` + harness component | `visible`, message shown/cleared |
| I18n | mocked `useTranslations` | real `I18nProvider` + loader double, inside `GlobalLoaderProvider` | loader calls per locale, rendered strings, `ready` |
| Auth | mocked `useAuth` | real `AuthProvider` + fetch stub | session fields, endpoint URLs, guard redirect |
| Authorization | mocked `useAuthorization` | real `AuthProvider` + fetch stub with session grants | `hasRole`/`can` results, fail-closed behavior |

### GlobalLoader

**Unit test pattern.** Mock `useGlobalLoader` and assert the component's calls — the complete example is in [Unit Testing](#pattern-component-with-a-mocked-context-hook).

**Integration test pattern.** Use `renderHook` with a wrapper for hook-level assertions, and a harness component for DOM-level behavior such as the message being cleared on hide.

```tsx
// test/global-loader.test.tsx
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";
import type { ReactNode } from "react";

function LoaderWrapper({ children }: { children: ReactNode }) {
    return <GlobalLoaderProvider>{children}</GlobalLoaderProvider>;
}

it("tracks visibility through the real provider", () => {
    const { result } = renderHook(() => useGlobalLoader(), { wrapper: LoaderWrapper });

    expect(result.current.visible).toBe(false);

    act(() => {
        result.current.showLoader(true);
    });
    expect(result.current.visible).toBe(true);

    act(() => {
        result.current.showLoader(false);
    });
    expect(result.current.visible).toBe(false);
});

function LoaderHarness() {
    const { showLoader, setText, visible } = useGlobalLoader();

    return (
        <div>
            <span data-testid="visible">{String(visible)}</span>
            <button onClick={() => setText("Loading…")}>Set message</button>
            <button onClick={() => showLoader(true)}>Show loader</button>
            <button onClick={() => showLoader(false)}>Hide loader</button>
        </div>
    );
}

it("shows the message while visible and clears it on hide", () => {
    render(
        <GlobalLoaderProvider
            config={{
                textComponent: ({ text }) => <em data-testid="loader-text">{text}</em>,
            }}
        >
            <LoaderHarness />
        </GlobalLoaderProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set message" }));
    fireEvent.click(screen.getByRole("button", { name: "Show loader" }));
    expect(screen.getByTestId("visible")).toHaveTextContent("true");
    expect(screen.getByTestId("loader-text")).toHaveTextContent("Loading…");

    fireEvent.click(screen.getByRole("button", { name: "Hide loader" }));
    expect(screen.getByTestId("visible")).toHaveTextContent("false");

    // Hiding clears the message; showing again starts without text.
    fireEvent.click(screen.getByRole("button", { name: "Show loader" }));
    expect(screen.getByTestId("visible")).toHaveTextContent("true");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
});
```

The custom `textComponent` makes the caption directly assertable. Remember that provider config is captured on mount — assert custom configuration by rendering the provider with that config, not by changing it mid-test.

### I18n

**Unit test pattern.** Mock `useTranslations` and assert which keys and parameters the component requests.

```tsx
// test/inbox-summary.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useTranslations } from "blendsdk/react";
import { createTranslationsValue } from "./helpers";

vi.mock("blendsdk/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/react")>();
    return { ...actual, useTranslations: vi.fn() };
});

function InboxSummary() {
    const { t, locale, setLocale, ready } = useTranslations();

    if (!ready) {
        return <p>Loading translations…</p>;
    }

    return (
        <section>
            <h1>{t("inbox.title")}</h1>
            <p>{t("inbox.unread", { count: 3 })}</p>
            <button onClick={() => setLocale(locale === "en" ? "nl" : "en")}>
                Switch language
            </button>
        </section>
    );
}

it("requests the keys it renders and switches locale through the hook", () => {
    const t = vi.fn((key: string) => `t:${key}`);
    const setLocale = vi.fn();
    vi.mocked(useTranslations).mockReturnValue(
        createTranslationsValue({ t, setLocale, locale: "en" }),
    );

    render(<InboxSummary />);

    expect(screen.getByRole("heading", { name: "t:inbox.title" })).toBeInTheDocument();
    expect(t).toHaveBeenCalledWith("inbox.title");
    expect(t).toHaveBeenCalledWith("inbox.unread", { count: 3 });

    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(setLocale).toHaveBeenCalledWith("nl");
});

it("renders the fallback until translations are ready", () => {
    vi.mocked(useTranslations).mockReturnValue(createTranslationsValue({ ready: false }));

    render(<InboxSummary />);

    expect(screen.getByText("Loading translations…")).toBeInTheDocument();
});
```

**Integration test pattern.** Render the real `I18nProvider` (inside `GlobalLoaderProvider`) with the loader double, and assert the loading lifecycle end to end.

```tsx
// test/i18n-provider.test.tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { GlobalLoaderProvider, I18nProvider, useTranslations } from "blendsdk/react";
import { createTranslationLoader } from "./helpers";

function InboxSummary() {
    const { t, locale, setLocale, reloadTranslations, ready } = useTranslations();

    if (!ready) {
        return <p>Loading translations…</p>;
    }

    return (
        <section>
            <h1>{t("inbox.title")}</h1>
            <button onClick={() => setLocale(locale === "en" ? "nl" : "en")}>
                Switch language
            </button>
            <button onClick={() => reloadTranslations()}>Reload</button>
        </section>
    );
}

it("loads the default locale, then re-fetches on switch and reload", async () => {
    const { loader, calls } = createTranslationLoader({
        en: { "inbox.title": "Inbox" },
        nl: { "inbox.title": "Postvak IN" },
    });

    render(
        <GlobalLoaderProvider>
            <I18nProvider loader={loader} defaultLocale="en">
                <InboxSummary />
            </I18nProvider>
        </GlobalLoaderProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(calls).toEqual(["en"]);

    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(await screen.findByRole("heading", { name: "Postvak IN" })).toBeInTheDocument();
    expect(calls).toEqual(["en", "nl"]);

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => {
        expect(calls).toEqual(["en", "nl", "nl"]);
    });
});

it("reports unresolvable keys through onMissingTranslation", async () => {
    const { loader } = createTranslationLoader({ en: {} });
    const onMissingTranslation = vi.fn();

    render(
        <GlobalLoaderProvider>
            <I18nProvider
                loader={loader}
                defaultLocale="en"
                onMissingTranslation={onMissingTranslation}
            >
                <InboxSummary />
            </I18nProvider>
        </GlobalLoaderProvider>,
    );

    await waitFor(() => {
        expect(onMissingTranslation).toHaveBeenCalledWith("inbox.title", "en");
    });
});
```

Catalog fixtures use plain strings so assertions hold regardless of how interpolation or plural syntax is written in real catalogs.

### Auth

**Unit test pattern.** Mock `useAuth` and verify how the component reacts to each session state.

```tsx
// test/session-bar.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAuth } from "blendsdk/react";
import { createAuthValue } from "./helpers";

vi.mock("blendsdk/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/react")>();
    return { ...actual, useAuth: vi.fn() };
});

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
            <button
                onClick={() => {
                    void logout();
                }}
            >
                Sign Out
            </button>
        </div>
    );
}

it("offers sign-in when the session is anonymous", () => {
    const login = vi.fn();
    vi.mocked(useAuth).mockReturnValue(createAuthValue({ login }));

    render(<SessionBar />);
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    expect(login).toHaveBeenCalled();
});

it("renders the subject and signs out when authenticated", () => {
    const logout = vi.fn(async () => {});
    vi.mocked(useAuth).mockReturnValue(
        createAuthValue({
            user: { sub: "user-123" },
            isAuthenticated: true,
            authorized: true,
            logout,
        }),
    );

    render(<SessionBar />);
    expect(screen.getByText("Signed in as user-123")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
    expect(logout).toHaveBeenCalled();
});
```

**Integration test pattern — session lifecycle.** Render the real `AuthProvider` with a `fetch` stub and read the context through `renderHook`.

```tsx
// test/auth-session.test.tsx
import { renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { AuthProvider, useAuth } from "blendsdk/react";
import type { ReactNode } from "react";
import { authenticatedSession, createFetchMock, jsonResponse, requestUrl } from "./helpers";

function AuthWrapper({ children }: { children: ReactNode }) {
    return (
        <AuthProvider config={{ basePath: "/api/auth", autoRefresh: false }}>
            {children}
        </AuthProvider>
    );
}

it("populates the session from GET /me", async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValue(jsonResponse(authenticatedSession));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthWrapper });

    await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.sub).toBe("user-123");
    expect(result.current.authorized).toBe(true);
    expect(result.current.csrfToken).toBe("csrf-abc123");
    expect(result.current.config.basePath).toBe("/api/auth");
    expect(result.current.config.loginPath).toBe("/login");
    expect(requestUrl(fetchMock.mock.calls[0][0])).toBe("/api/auth/me");
});

it("stays anonymous when GET /me reports no session", async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValue(jsonResponse({ user: null }, 401));

    const { result } = renderHook(() => useAuth(), { wrapper: AuthWrapper });

    await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.authorized).toBe(false);
    expect(result.current.csrfToken).toBeNull();
});
```

**Integration test pattern — route protection and sign-out.** Guards navigate through `react-router`, so wrap the tree in `MemoryRouter` and assert which route renders. Route the fetch stub per endpoint and throw on anything unexpected.

```tsx
// test/auth-flows.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import { AuthGuard, AuthProvider, useAuth } from "blendsdk/react";
import { authenticatedSession, createFetchMock, jsonResponse, requestUrl } from "./helpers";

it("redirects anonymous visitors to the configured login path", async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValue(jsonResponse({ user: null }, 401));

    render(
        <MemoryRouter initialEntries={["/dashboard"]}>
            <AuthProvider config={{ basePath: "/api/auth", autoRefresh: false }}>
                <Routes>
                    <Route
                        path="/dashboard"
                        element={
                            <AuthGuard>
                                <h1>Dashboard</h1>
                            </AuthGuard>
                        }
                    />
                    <Route path="/login" element={<h1>Sign in</h1>} />
                </Routes>
            </AuthProvider>
        </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Dashboard" })).not.toBeInTheDocument();
});

function SessionBar() {
    const { user, isAuthenticated, isLoading, logout } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    if (!isAuthenticated) {
        return <p>Signed out</p>;
    }

    return (
        <div>
            <span>Signed in as {user?.sub}</span>
            <button
                onClick={() => {
                    void logout();
                }}
            >
                Sign Out
            </button>
        </div>
    );
}

it("signs out through the BFF and clears the session", async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockImplementation(async (input) => {
        const url = requestUrl(input);
        if (url.endsWith("/me")) {
            return jsonResponse(authenticatedSession);
        }
        if (url.endsWith("/logout")) {
            return jsonResponse({ ok: true });
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    render(
        <AuthProvider config={{ basePath: "/api/auth", autoRefresh: false }}>
            <SessionBar />
        </AuthProvider>,
    );

    expect(await screen.findByText("Signed in as user-123")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));

    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toContain(
        "/api/auth/logout",
    );
});
```

Additional notes:

- **Config resolution** is asserted through the context (`result.current.config`): `basePath` passes through, endpoint paths stay relative to it, and omitted values fall back to `AUTH_DEFAULTS`. Assert joined request URLs (`/api/auth/me`) rather than resolved config strings.
- **Auto-refresh**: with `autoRefresh` enabled the provider schedules a refresh `refreshLeadTime` seconds before `expiresAt`. Keep tests hermetic by disabling it and using a far-future `expiresAt`; to test the timing itself, switch to `vi.useFakeTimers()`, advance past the lead time, and assert a call to `/api/auth/refresh`.
- **`RequireAccess`** redirects a signed-in user who lacks a required grant to `config.notAuthorizedPath`. The test shape is the same as the `AuthGuard` test above: run the session payload through a real `AuthProvider`, mount routes for the protected path and for the not-authorized path, and assert which one settles.

### Authorization

**Unit test pattern.** Mock `useAuthorization` and assert that the toolbar offers exactly the actions the grants allow.

```tsx
// test/invoice-toolbar.test.tsx
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAuthorization } from "blendsdk/react";
import { createAuthorizationValue } from "./helpers";

vi.mock("blendsdk/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/react")>();
    return { ...actual, useAuthorization: vi.fn() };
});

function InvoiceToolbar() {
    const { can, hasRole } = useAuthorization();

    return (
        <div>
            {hasRole("finance") && <span>Finance team</span>}
            {can("invoice:write") && <button>Edit invoice</button>}
            {!can("invoice:write") && <p>Read-only access</p>}
        </div>
    );
}

it("shows only the actions the grants allow", () => {
    vi.mocked(useAuthorization).mockReturnValue(
        createAuthorizationValue({
            roles: ["finance"],
            permissions: ["invoice:write"],
        }),
    );

    render(<InvoiceToolbar />);

    expect(screen.getByText("Finance team")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit invoice" })).toBeInTheDocument();
    expect(screen.queryByText("Read-only access")).not.toBeInTheDocument();
});

it("falls back to read-only when no grants are held", () => {
    vi.mocked(useAuthorization).mockReturnValue(createAuthorizationValue());

    render(<InvoiceToolbar />);

    expect(screen.queryByText("Finance team")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit invoice" })).not.toBeInTheDocument();
    expect(screen.getByText("Read-only access")).toBeInTheDocument();
});
```

**Integration test pattern.** Drive the real `AuthProvider` with a session payload and assert the predicates produced by `useAuthorization`, including the fail-closed behavior for malformed grants.

```tsx
// test/authorization-session.test.tsx
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { AuthProvider, useAuth, useAuthorization } from "blendsdk/react";
import type { ReactNode } from "react";
import { authenticatedSession, createFetchMock, jsonResponse } from "./helpers";

function AuthWrapper({ children }: { children: ReactNode }) {
    return (
        <AuthProvider config={{ basePath: "/api/auth", autoRefresh: false }}>
            {children}
        </AuthProvider>
    );
}

it("derives roles and permissions from the session user", async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValue(jsonResponse(authenticatedSession));

    const { result } = renderHook(() => useAuthorization(), { wrapper: AuthWrapper });

    await waitFor(() => {
        expect(result.current.hasRole("finance")).toBe(true);
    });

    expect(result.current.can("invoice:write")).toBe(true);
    expect(result.current.can("invoice:approve")).toBe(false);
    expect(result.current.roles).toEqual(["finance"]);
    expect(result.current.permissions).toEqual(["invoice:write"]);
});

function GrantsProbe() {
    const { isLoading } = useAuth();
    const { can, hasRole, roles } = useAuthorization();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    return (
        <p>{`roles=${roles.length} finance=${hasRole("finance")} write=${can("invoice:write")}`}</p>
    );
}

it("fails closed when the session user carries malformed grants", async () => {
    const fetchMock = createFetchMock();
    fetchMock.mockResolvedValue(
        jsonResponse({
            user: { sub: "user-123", roles: "finance", permissions: 42 },
            authorized: true,
            expiresAt: null,
            csrfToken: null,
        }),
    );

    render(
        <AuthProvider config={{ basePath: "/api/auth", autoRefresh: false }}>
            <GrantsProbe />
        </AuthProvider>,
    );

    expect(
        await screen.findByText("roles=0 finance=false write=false"),
    ).toBeInTheDocument();
});
```

For the declarative guards:

- **`Can`** — test it the same way as the hook: render a real `AuthProvider` with a session that does or does not hold the grant, and assert whether the children appear. In tests focused on other features, mock `Can` as a passthrough (see [Mocking & Stubbing](#passthrough-mocks-for-providers-and-guards)).
- **`RequireAccess`** — render the protected area under a real `AuthProvider` inside `MemoryRouter`, with a route for `config.notAuthorizedPath`. A session with the required grant renders the protected content; a session without it settles on the not-authorized route.
- Remember the boundary: these tests verify UI behavior, not security. Server-side enforcement belongs in your BFF/API test suite.

---

# react Troubleshooting

Most `blendsdk/react` problems fall into three buckets: **provider placement** (a hook cannot find its context), **configuration** (paths, loaders, or grants that do not match what the server provides), and **lifecycle** (async work that never settles, or state that is not refreshed when you expect it to be). This document lists the errors and symptoms you are most likely to encounter, explains the technical cause behind each one, and shows a working fix — followed by debugging procedures and the pitfalls that are easy to miss.

For the feature model behind these symptoms, see the Overview and Core Concepts.

---

## Common Errors

### Hook Context Errors

Every consumer hook in this package throws a descriptive error when it is called outside its provider. These failures are fast to diagnose because the exact message names the missing provider.

#### `useAuth() must be used within an <AuthProvider>.`

**Error**

```
Error: useAuth() must be used within an <AuthProvider>. Wrap your component tree with <AuthProvider> to use this hook.
```

**Cause** — The hook read a `null` context because no `AuthProvider` is above the calling component. Frequent reasons:

- The component is a sibling of (or above) the provider instead of a descendant.
- The provider was mounted inside one route subtree while the component rendered in another.
- The hook is called outside a component render (module scope, plain helper function) — a Rules of Hooks violation.
- The component renders into a *different React root* (a widget or micro-frontend that mounts its own root); separate roots share no context.

**Fix** — Mount `AuthProvider` once at the application shell, above every consumer. `useAuthorization()` fails through `useAuth()`, so it produces this exact message too.

```tsx
import { AuthGuard, AuthProvider, useAuth } from "blendsdk/react";

function ProfileBadge() {
    const { user, isAuthenticated } = useAuth();

    if (!isAuthenticated) {
        return <span>Guest</span>;
    }

    return <span>{user?.sub}</span>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <header>
                <ProfileBadge />
            </header>
            <AuthGuard>
                <main>Protected content</main>
            </AuthGuard>
        </AuthProvider>
    );
}
```

#### `useGlobalLoader() must be used within a <GlobalLoaderProvider>.`

**Error**

```
Error: useGlobalLoader() must be used within a <GlobalLoaderProvider>. Wrap your component tree with <GlobalLoaderProvider> to use this hook.
```

**Cause** — No `GlobalLoaderProvider` is above the caller (same failure mechanism as `useAuth()` above).

**Fix** — Wrap the subtree once, close to the top of the app, so every feature that drives the overlay shares the same instance.

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function BusyIndicator() {
    const { visible } = useGlobalLoader();
    return visible ? <p aria-busy="true">Loading…</p> : null;
}

export function App() {
    return (
        <GlobalLoaderProvider>
            <BusyIndicator />
        </GlobalLoaderProvider>
    );
}
```

#### `useTranslations() must be used within an <I18nProvider>.`

**Error**

```
Error: useTranslations() must be used within an <I18nProvider>. Wrap your component tree with <I18nProvider> to use this hook.
```

**Cause** — No `I18nProvider` is above the caller. Also check the nesting order: because `setLocale()` shows the global loading overlay while it re-fetches translations, the recommended composition mounts `I18nProvider` *inside* a `GlobalLoaderProvider`. Keep that order when you fix the provider placement.

**Fix**

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
        throw new Error(`Translations for "${locale}" failed with HTTP ${response.status}`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function Greeting() {
    const { t } = useTranslations();
    return <h1>{t("home.greeting")}</h1>;
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

#### `Warning: Invalid hook call.` (usually a duplicate React)

**Error**

```
Warning: Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:
1. You might have mismatching versions of React and the renderer (such as React DOM)
2. You might be breaking the Rules of Hooks
3. You might have more than one copy of React in the same app
See https://react.dev/link/invalid-hook-call for tips about how to debug and fix this problem.
```

**Cause** — `react` and `react-dom` are peer dependencies (`^19.0.0`). With linked workspace packages or `file:`/`link:` installs, the app can end up with two copies of React — one resolved by the app, one resolved through the package — and the internal hook dispatcher is not shared. Reason #2 (Rules of Hooks) is the other classic: hooks such as `useAuth()` must never be called conditionally or from non-component functions.

**Fix** — Collapse to a single React copy:

1. Run `npm ls react react-dom` and confirm exactly one copy of each at 19.x.
2. Run `npm dedupe` (or the pnpm/yarn equivalent) and reinstall if duplicates persist.
3. In Vite apps, dedupe explicitly:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    plugins: [react()],
    resolve: {
        dedupe: ["react", "react-dom"],
    },
});
```

4. For Rules-of-Hooks violations, move the hook call to the top level of the component and branch on the returned values instead.

#### `useNavigate() may be used only in the context of a <Router> component.`

**Error** — react-router reports that the navigation context is missing (or TypeScript fails with `Cannot find module 'react-router' or its corresponding type declarations.` when the package is not installed).

**Cause** — `AuthGuard` and `RequireAccess` redirect through `react-router`, which is an *optional* peer dependency (`^7.0.0`). If they render outside a router — a bare test render, a root without `BrowserRouter`, or a widget mounted into its own root — there is no navigation context to use.

**Fix** — Install `react-router` (^7) when you use the guard components, and render them inside the router.

```tsx
import { BrowserRouter, Route, Routes } from "react-router";
import { AuthGuard, AuthProvider } from "blendsdk/react";

export function App() {
    return (
        <BrowserRouter>
            <AuthProvider config={{ basePath: "/api/auth" }}>
                <Routes>
                    <Route
                        path="/*"
                        element={
                            <AuthGuard>
                                <main>Protected application</main>
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

### Import and Module Errors

#### Installing the package returns `404` from the npm registry

**Error**

```
npm ERR! 404 Not Found - GET https://registry.npmjs.org/@blendsdk%2freact - Not found
```

**Cause** — The package is marked `"private": true` and is never published to npm on its own. It is consumed from the BlendSDK monorepo as a workspace dependency, not installed from the registry.

**Fix** — Declare it as a workspace dependency in the consuming application (protocol depends on your package manager — `workspace:*` for pnpm/yarn):

```json
{
    "dependencies": {
        "blendsdk/react": "workspace:*"
    }
}
```

Then install from the repository root so the workspace link is created.

#### `Cannot find module 'blendsdk/react' or its corresponding type declarations.` (TS2307)

**Error**

```
error TS2307: Cannot find module 'blendsdk/react' or its corresponding type declarations.
```

**Cause** — Two common origins:

1. **Module resolution.** The package publishes through an `exports` map (`"types": "./dist/index.d.ts"`, `"import": "./dist/index.js"`). TypeScript's legacy `"node"`/`"node10"` resolution ignores `exports`, so the import never resolves.
2. **Unbuilt workspace package.** The package ships only `dist/`; if `tsc` has not run (no `dist/`), both TypeScript and Node fail to resolve it (`ERR_MODULE_NOT_FOUND` at runtime).

**Fix** — 1. Use a modern resolution mode:

```json
{
    "compilerOptions": {
        "module": "esnext",
        "moduleResolution": "bundler",
        "strict": true
    }
}
```

2. Build the package (and keep the watcher running while developing):

```bash
cd packages/react
npm run build   # tsc → dist/
npm run dev     # tsc --watch
```

#### `Error [ERR_PACKAGE_PATH_NOT_EXPORTED]` — `require()` or deep imports

**Error**

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../packages/react/package.json
```

or, for a subpath import:

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/index.js' is not defined by "exports" in .../packages/react/package.json
```

**Cause** — The package is ESM-only (`"type": "module"`) and its `exports` map defines exactly one entry — `.` with `types` and `import` conditions. There is no `require` condition and no subpath for `dist/`, so CommonJS `require()` calls and deep imports fail by design.

**Fix** — Import from the package root in ESM code and run tooling in ESM mode (Vitest and modern bundlers handle this natively):

```tsx
import { AuthProvider, useAuth } from "blendsdk/react";

function SignInButton() {
    const { login } = useAuth();
    return <button onClick={() => login()}>Sign in</button>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SignInButton />
        </AuthProvider>
    );
}
```

If you must interop from CommonJS, use a dynamic import:

```typescript fragment
const { AuthProvider } = await import("blendsdk/react");
```

#### `Module '"blendsdk/react"' has no exported member '...'`

**Error**

```
error TS2614: Module '"blendsdk/react"' has no exported member 'GLOBAL_LOADER_DEFAULTS'.
```

**Cause** — The package root exports only its public API; internal constants, contexts, and helper modules are not re-exported. Common mistaken imports:

| Attempted import | Correct approach |
|------------------|------------------|
| `GLOBAL_LOADER_DEFAULTS` | Internal — not exported. Override values through `GlobalLoaderProvider`'s `config` prop instead. |
| `AuthContext`, `I18nContext`, `GlobalLoaderContext` | Internal — consume through `useAuth`, `useTranslations`, `useGlobalLoader`. |
| `TranslationValue` | Import from `blendsdk/i18n`. |
| `hasPermission`, `hasRole`, `AccessPrincipal` | Import from `blendsdk/authz`. |
| `blendsdk/react/dist/...` (any deep path) | Not exported — import from the package root. |

**Fix** — Use the public surface:

```tsx
import { GlobalLoaderProvider } from "blendsdk/react";
import type { ReactNode } from "react";

export function App({ children }: { children: ReactNode }) {
    return <GlobalLoaderProvider config={{ spinnerSize: 64 }}>{children}</GlobalLoaderProvider>;
}
```

---

### TypeScript Compiler Errors

#### Missing required provider props (TS2741)

**Error** — one of:

```
error TS2741: Property 'config' is missing in type '{ children: Element; }' but required in type 'AuthProviderProps'.
error TS2741: Property 'basePath' is missing in type '{}' but required in type 'AuthConfig'.
error TS2741: Property 'loader' is missing in type '{ children: ReactNode; }' but required in type 'I18nProviderProps'.
```

**Cause** — Each provider has exactly one required value, and the compiler enforces it: `AuthProvider` requires `config` with `basePath`; `I18nProvider` requires `loader`. Everything else has defaults (`AUTH_DEFAULTS`, `defaultLocale: 'en'`).

**Fix**

```tsx
import { AuthProvider, I18nProvider, type TranslationLoader } from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";
import type { ReactNode } from "react";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translations for "${locale}" failed with HTTP ${response.status}`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

export function App({ children }: { children: ReactNode }) {
    return (
        <I18nProvider loader={loadTranslations} defaultLocale="en">
            <AuthProvider config={{ basePath: "/api/auth" }}>{children}</AuthProvider>
        </I18nProvider>
    );
}
```

#### Type-only imports rejected under `verbatimModuleSyntax` (TS1484)

**Error**

```
error TS1484: 'AuthConfig' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.
```

**Cause** — Under `verbatimModuleSyntax`, interfaces and type aliases must be imported with `import type` (or an inline `type` modifier). The package exports many types (`AuthConfig`, `AuthUser`, `GlobalLoaderConfig`, `TranslateFunction`, …), so a single value-style import of config or props types breaks the build.

**Fix**

```tsx
import { AuthProvider, type AuthConfig } from "blendsdk/react";
import type { ReactNode } from "react";

const config: AuthConfig = {
    basePath: "/api/auth",
    loginPath: "/sign-in",
};

export function App({ children }: { children: ReactNode }) {
    return <AuthProvider config={config}>{children}</AuthProvider>;
}
```

#### Reading claims off `user` is a type error (TS18046)

**Error**

```
error TS18046: 'user.roles' is of type 'unknown'.
```

**Cause** — `AuthUser` types additional OIDC claims through an index signature (`[key: string]: unknown`), so every claim read off `user` is `unknown` and cannot be used directly — for example, `user.roles.includes("finance")` fails this way.

**Fix** — Use `useAuthorization()` for grants; it reads the session user safely and fails closed. For other custom claims, narrow before use:

```tsx
import { useAuth, useAuthorization } from "blendsdk/react";

export function AccountSummary() {
    const { user } = useAuth();
    const { roles, can } = useAuthorization();

    const emailClaim = user?.email;
    const email = typeof emailClaim === "string" ? emailClaim : "unknown";

    return (
        <section>
            <p>Email: {email}</p>
            <p>Roles: {roles.join(", ") || "none"}</p>
            {can("invoice:write") && <button>Edit invoice</button>}
        </section>
    );
}
```

#### `textComponent` must return a ReactElement (TS2322)

**Error** — TypeScript reports TS2322 on the `config` object:

```
error TS2322: Type 'string' is not assignable to type 'ReactElement<unknown, string | JSXElementConstructor<any>>'.
```

**Cause** — `GlobalLoaderConfig.textComponent` must return a `ReactElement`. Returning a string (or `null`) fails the assignment.

**Fix** — Return JSX:

```tsx
import { GlobalLoaderProvider } from "blendsdk/react";

export function App() {
    return (
        <GlobalLoaderProvider
            config={{
                textColor: "#25b09b",
                textComponent: ({ text, textColor }) => (
                    <strong style={{ color: textColor, fontSize: 16 }}>{text}</strong>
                ),
            }}
        >
            <main>Application content</main>
        </GlobalLoaderProvider>
    );
}
```

---

### Authentication and Authorization Errors

#### Redirect loop between the guarded subtree and the login page

**Symptom** — The browser bounces between the protected route and `/login` (or the login page itself redirects and nothing renders).

**Cause** — `AuthGuard` redirects unauthenticated visitors to `config.loginPath`. If the component rendering that path is itself wrapped in `AuthGuard` — or the fallback route is guarded — the redirect target is unreachable and the guard keeps redirecting. The same applies to `notAuthorizedPath` and `RequireAccess`.

**Fix** — Register `loginPath` and `notAuthorizedPath` as public routes, outside the guard:

```tsx
import { BrowserRouter, Route, Routes } from "react-router";
import { AuthGuard, AuthProvider, useAuth } from "blendsdk/react";

function LoginPage() {
    const { login } = useAuth();

    return (
        <main>
            <h1>Sign in</h1>
            <button onClick={() => login()}>Continue with SSO</button>
        </main>
    );
}

function Dashboard() {
    return <main>Dashboard</main>;
}

export function App() {
    return (
        <BrowserRouter>
            <AuthProvider config={{ basePath: "/api/auth", loginPath: "/login" }}>
                <Routes>
                    {/* Public routes — never wrap these in AuthGuard. */}
                    <Route path="/login" element={<LoginPage />} />
                    <Route
                        path="/*"
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

#### `isLoading` never becomes `false`

**Symptom** — UI gated on `isLoading` shows "Checking session…" indefinitely; the session-check request may be hanging in the Network tab.

**Cause** — The initial check runs against `GET {basePath}{endpoints.me}`. If that request never settles — the route hangs behind a dev proxy or gateway, the BFF is unreachable, or `basePath` points somewhere that never answers — the provider has nothing to transition on.

**Fix** — 1. Open DevTools → Network, filter for the `me` request, and confirm it completes. 2. Print the resolved endpoint from context to verify the URL:

```tsx
import { useEffect } from "react";
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionDiagnostics() {
    const { isLoading, isAuthenticated, config } = useAuth();

    useEffect(() => {
        console.info("Session check:", `${config.basePath}${config.endpoints.me}`);
    }, [config]);

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    return <p>{isAuthenticated ? "Signed in" : "Anonymous"}</p>;
}

export function App() {
    return (
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionDiagnostics />
        </AuthProvider>
    );
}
```

3. Point `basePath` at the path the BFF actually serves (or fix the dev-server proxy).

#### Requests are rejected with `403` (CSRF token)

**Symptom** — State-changing calls to the BFF return HTTP 403 even though the session is valid.

**Cause** — The BFF enforces CSRF protection: mutating requests must carry the per-session token in the header named by `config.csrfHeader` (default `x-csrf-token`). The token is missing, sent under the wrong header name, or stale — a token replaced by another browsing context is not observed until the next session check, so a request made with an outdated value can be rejected with 403.

**Fix** — Read `csrfToken` from `useAuth()` and send it under `config.csrfHeader`:

```tsx
import { useAuth } from "blendsdk/react";

export function RevokeButton({ sessionId }: { sessionId: string }) {
    const { csrfToken, config } = useAuth();

    const handleRevoke = async () => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (csrfToken !== null) {
            headers[config.csrfHeader] = csrfToken;
        }

        const response = await fetch(`/api/sessions/${sessionId}/revoke`, {
            method: "POST",
            headers,
        });

        if (response.status === 403) {
            console.error("The CSRF token was rejected — refresh the session and retry.");
            return;
        }

        if (!response.ok) {
            console.error(`Revoke failed with HTTP ${response.status}`);
        }
    };

    return <button onClick={handleRevoke}>Revoke session</button>;
}
```

If the server uses a different header name, set `csrfHeader` in the `AuthProvider` config to match. A `null` token means CSRF is not enforced — omitting the header is correct in that case. If your BFF lives on another origin, cookie and CORS rules apply as well.

#### Endpoints resolve to a doubled path, e.g. `/api/auth/api/auth/login`

**Symptom** — The Network tab shows requests like `POST /api/auth/api/auth/login` returning 404.

**Cause** — `endpoints.*` paths are **relative to `basePath`**. An override that repeats the base path (or an absolute URL) is concatenated into a doubled prefix.

**Fix** — Keep endpoint overrides relative:

```tsx
import { AuthProvider } from "blendsdk/react";
import type { ReactNode } from "react";

export function App({ children }: { children: ReactNode }) {
    return (
        <AuthProvider
            config={{
                basePath: "/api/auth",
                endpoints: {
                    me: "/session",              // GET  /api/auth/session
                    refresh: "/session/refresh", // POST /api/auth/session/refresh
                },
            }}
        >
            {children}
        </AuthProvider>
    );
}
```

#### `refresh()` resolves to `false`

**Symptom** — Code that ignores the return value continues with a dead session and then receives 401s on subsequent calls.

**Cause** — `refresh()` reports success as a boolean. It returns `false` when the refresh round-trip fails — typically because the session cookie is gone, the session expired beyond recovery, or the endpoint is unreachable.

**Fix** — Branch on the result and send the user back through login:

```tsx
import { useAuth } from "blendsdk/react";

export function ExtendSessionButton() {
    const { refresh, login } = useAuth();

    const handleRefresh = async () => {
        const refreshed = await refresh();
        if (!refreshed) {
            login();
        }
    };

    return <button onClick={handleRefresh}>Extend session</button>;
}
```

#### `useAuthorization()` returns empty grants for a signed-in user

**Symptom** — The user is authenticated (`isAuthenticated === true`) but `roles` and `permissions` are empty; `Can` renders nothing and `RequireAccess` redirects.

**Cause** — Grants are read from the session user as **top-level `roles` and `permissions` arrays of strings**. The hook treats the user as untrusted runtime data: a missing value, a non-array, or non-string entries are discarded, and malformed grants degrade to an empty principal — checks fail closed rather than throw. Provider-style claims (nested objects, comma-separated strings, claim nesting such as `realm_access.roles`) never match.

**Fix** — Make the BFF attach grants to the session user in the expected shape:

```json
{
    "sub": "8f14e45fceea167a5a36dedd4bea2543",
    "roles": ["finance"],
    "permissions": ["invoice:write", "invoice:approve"]
}
```

Then verify from the component side:

```tsx
import { useAuthorization } from "blendsdk/react";

export function GrantDiagnostics() {
    const { roles, permissions } = useAuthorization();

    return (
        <pre>
            {JSON.stringify({ roles, permissions }, null, 2)}
        </pre>
    );
}
```

Remember that these checks shape the UI only — the server remains the authority.

---

### I18n Errors

#### Some labels are not translated

**Symptom** — Part of the UI shows raw keys (or nothing) where translated text is expected.

**Cause** — The key is not present in the flat catalog returned by the `loader` for the active locale; or the loader returned a structure the provider cannot use (nested objects instead of a flat key → value map); or the catalog for a different locale than the keys expect was loaded.

**Fix** — Instrument the loader and wire `onMissingTranslation` so unresolved keys are visible instead of silent:

```tsx
import { I18nProvider, useTranslations, type TranslationLoader } from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translations for "${locale}" failed with HTTP ${response.status}`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function Welcome() {
    const { t } = useTranslations();
    return <h1>{t("home.welcome")}</h1>;
}

export function App() {
    return (
        <I18nProvider
            loader={loadTranslations}
            defaultLocale="en"
            onMissingTranslation={(key, locale) => {
                console.warn(`Missing translation "${key}" for locale "${locale}"`);
            }}
        >
            <Welcome />
        </I18nProvider>
    );
}
```

The loader must return the flat map whose keys are exactly the strings passed to `t()` — compare the logged missing keys against the catalog your endpoint serves.

#### `ready` stays `false` — the UI never leaves the loading state

**Symptom** — Any `if (!ready)` guard keeps its fallback on screen forever.

**Cause** — `ready` flips to `true` only after a successful load. If the loader rejects — HTTP error, invalid JSON, network failure — nothing transitions, and application code often never surfaces the failure.

**Fix** — Make the loader fail loudly (the example above throws with the locale and status), watch the Network tab per locale, and offer a manual retry through `reloadTranslations()`:

```tsx
import { useTranslations } from "blendsdk/react";

export function TranslationFallback() {
    const { ready, locale, reloadTranslations } = useTranslations();

    if (ready) {
        return null;
    }

    return (
        <div>
            <p>Translations for "{locale}" are not available yet.</p>
            <button onClick={() => reloadTranslations()}>Retry</button>
        </div>
    );
}
```

---

### GlobalLoader Errors

#### The overlay never appears

**Symptom** — `showLoader(true)` runs but nothing is visible; the app stays fully interactive.

**Cause** — Most often a stacking problem: application chrome with a higher `z-index` than the overlay's default (`999999`) covers it, or the provider is mounted inside a stacking context that sits below such chrome. Two further traps: calling `setText()` without ever calling `showLoader(true)`, and changing the `zIndex` config after mount — config is captured on mount and is not reactive.

**Fix** — Raise the overlay's `z-index` and verify visibility through the hook:

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "blendsdk/react";

function OverlayProbe() {
    const { showLoader, visible } = useGlobalLoader();

    return (
        <button onClick={() => showLoader(!visible)}>
            {visible ? "Hide" : "Show"} overlay
        </button>
    );
}

export function App() {
    return (
        <GlobalLoaderProvider config={{ zIndex: 10000000 }}>
            <OverlayProbe />
        </GlobalLoaderProvider>
    );
}
```

Mount the provider as high in the tree as possible so the overlay is not nested inside application layout containers.

#### The overlay is stuck on screen

**Symptom** — The spinner remains after the operation finished; the UI underneath is blocked.

**Cause** — A code path showed the loader but never hid it: an exception skipped the `showLoader(false)` line, or an early exit bypassed it. Hiding is the only thing that clears the overlay (and it also clears the caption text).

**Fix** — Always hide in a `finally` block so every outcome — success, error, or early return — restores the UI:

```tsx
import { useGlobalLoader } from "blendsdk/react";
import { useState } from "react";

export function ExportButton() {
    const { showLoader, setText } = useGlobalLoader();
    const [status, setStatus] = useState("idle");

    const handleExport = async () => {
        setText("Preparing export…");
        showLoader(true);
        try {
            const response = await fetch("/api/reports/export", { method: "POST" });
            if (!response.ok) {
                throw new Error(`Export failed with HTTP ${response.status}`);
            }
            setStatus("done");
        } catch (error) {
            console.error("Export failed:", error);
            setStatus("error");
        } finally {
            showLoader(false);
        }
    };

    return <button onClick={handleExport}>{status === "done" ? "Exported" : "Export"}</button>;
}
```

---

### Testing Errors

#### `ReferenceError: document is not defined`

**Symptom** — A test that imports and renders anything from `blendsdk/react` fails with `ReferenceError: document is not defined` (or `window is not defined`).

**Cause** — The default Vitest environment is Node, which has no DOM. These components render DOM nodes (the overlay, the provider trees), so they need a DOM environment — the package's own toolchain runs against jsdom.

**Fix** — Install `jsdom` as a dev dependency and select it in the Vitest config:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
    },
});
```

Alternatively, put `/** @vitest-environment jsdom */` at the top of an individual test file.

#### `Warning: An update to ... was not wrapped in act(...)`

**Symptom** — React logs `Warning: An update to AuthProvider inside a test was not wrapped in act(...)` while a test passes, or assertions run before the provider settles.

**Cause** — The providers do asynchronous work on mount — the session check (`GET /me`), and the translation load for `I18nProvider`. If the test asserts synchronously, updates land after the test finished.

**Fix** — Stub the network layer and await the settled state with `findBy*` queries so pending updates complete inside `act()`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "blendsdk/react";

function SessionLabel() {
    const { isLoading, isAuthenticated } = useAuth();

    if (isLoading) {
        return <p>Checking session…</p>;
    }

    return <p>{isAuthenticated ? "Signed in" : "Signed out"}</p>;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

it("settles the initial session check inside act()", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));

    render(
        <AuthProvider config={{ basePath: "/api/auth" }}>
            <SessionLabel />
        </AuthProvider>,
    );

    expect(await screen.findByText("Signed out")).toBeInTheDocument();
});
```

---

## Debugging Strategies

When the failure is not spelled out by an error message, work through the following procedures from the outside in: confirm the provider stack, verify the resolved configuration, then trace the network and state transitions.

### Verify provider placement with a diagnostics component

Mount the component below at the app shell. It consumes all four contexts: if it renders, every provider is present and correctly nested; if it throws, the message names the missing provider.

1. Render `ProviderDiagnostics` inside the same provider stack your app uses.
2. If it renders, move the real screens under that same stack (do not add providers deeper in the tree).
3. If it throws, add the missing provider around the failing component; check for components rendered into a second React root if the error persists.

```tsx
import {
    AuthProvider,
    GlobalLoaderProvider,
    I18nProvider,
    useAuth,
    useAuthorization,
    useGlobalLoader,
    useTranslations,
    type TranslationLoader,
} from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

const loadTranslations: TranslationLoader = async (locale) => {
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`Translations for "${locale}" failed with HTTP ${response.status}`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    return catalog;
};

function ProviderDiagnostics() {
    const { isLoading, isAuthenticated, authorized } = useAuth();
    const { ready, locale } = useTranslations();
    const { visible } = useGlobalLoader();
    const { roles, permissions } = useAuthorization();

    return (
        <pre>
            {JSON.stringify(
                {
                    isLoading,
                    isAuthenticated,
                    authorized,
                    locale,
                    ready,
                    loaderVisible: visible,
                    roles,
                    permissions,
                },
                null,
                2,
            )}
        </pre>
    );
}

export function DiagnosticsApp() {
    return (
        <GlobalLoaderProvider>
            <I18nProvider loader={loadTranslations} defaultLocale="en">
                <AuthProvider config={{ basePath: "/api/auth" }}>
                    <ProviderDiagnostics />
                </AuthProvider>
            </I18nProvider>
        </GlobalLoaderProvider>
    );
}
```

### Inspect the resolved auth configuration

Endpoint mistakes are among the most common integration bugs. Read `config` from context and compare it against `AUTH_DEFAULTS` to see exactly which URLs the provider will call.

1. Render `ConfigReport` anywhere inside `AuthProvider`.
2. Confirm each printed URL matches what the BFF serves (including the dev-server proxy prefix).
3. Compare anything unexpected against `AUTH_DEFAULTS` — if you did not override a value, the default applies.

```tsx
import { AUTH_DEFAULTS, useAuth } from "blendsdk/react";

export function ConfigReport() {
    const { config } = useAuth();

    console.info("Resolved auth endpoints:", {
        login: `${config.basePath}${config.endpoints.login}`,
        callback: `${config.basePath}${config.endpoints.callback}`,
        logout: `${config.basePath}${config.endpoints.logout}`,
        me: `${config.basePath}${config.endpoints.me}`,
        refresh: `${config.basePath}${config.endpoints.refresh}`,
        defaults: AUTH_DEFAULTS,
    });

    return <pre>{JSON.stringify(config, null, 2)}</pre>;
}
```

### Trace the session lifecycle in DevTools

Open DevTools → Network, filter by your `basePath`, and walk the session through its full lifecycle:

| Stage | Request to look for | What to verify |
|-------|--------------------|----------------|
| App load | `GET {basePath}/me` | The request completes; the JSON carries the session claims (`sub`, grants, `authorized`, `csrfToken` when enforced); the session cookie is sent |
| `login()` | Browser navigates to `{basePath}/login` | The BFF answers with a redirect into the OIDC provider |
| Manual `refresh()` | `POST {basePath}/refresh` | 200 with a new expiry (and possibly a new CSRF token) while the session cookie is valid |
| `logout()` | `{basePath}/logout` | The cookie is cleared and the context falls back to anonymous |

If a request is missing entirely, the provider did not reach that stage — check the state values from the diagnostics component first.

### Probe the BFF endpoints directly

Before blaming the React layer, verify the server contract with plain HTTP calls:

```bash
curl -i http://localhost:3000/api/auth/me
curl -i http://localhost:3000/api/auth/login
```

Replace host and port with your dev-server address. Expected: `me` answers with a JSON body (anonymous or session payload), and `login` answers with a 3xx redirect toward the identity provider. If either fails here, the problem is in the BFF or the proxy — not in `blendsdk/react`.

### Instrument the translation loader

Wrap the loader in logging to see when and how often the provider loads catalogs, and whether the response is usable:

```ts
import type { TranslationLoader } from "blendsdk/react";
import type { TranslationValue } from "blendsdk/i18n";

export const instrumentedLoader: TranslationLoader = async (locale) => {
    console.info(`[i18n] loading catalog for "${locale}"`);
    const response = await fetch(`/api/translations/${locale}`);
    if (!response.ok) {
        throw new Error(`[i18n] catalog "${locale}" failed with HTTP ${response.status}`);
    }
    const catalog: Record<string, TranslationValue> = await response.json();
    console.info(`[i18n] loaded ${Object.keys(catalog).length} keys for "${locale}"`);
    return catalog;
};
```

Interpret the output:

- One load for the default locale on mount, then one per `setLocale()` call — anything else points to an unmounting provider (check where it is mounted; see the pitfalls below).
- Zero keys (or a JSON parse error) means the endpoint shape is wrong — the map must be flat, keyed exactly as `t()` callers pass keys.
- Add `onMissingTranslation` alongside to catch per-key problems at render time.

### Verify the GlobalLoader overlay in the DOM

1. Render the `OverlayProbe` from the "overlay never appears" entry and call `showLoader(true)`.
2. In the Elements panel, the provider should render a full-screen overlay node; inspect its computed `z-index`.
3. If it is present but invisible, an element with a higher `z-index` — or an ancestor creating a stacking context (transform, filter, opacity) below other chrome — is covering it. Raise `config.zIndex` and, because config is captured on mount, remount the provider with a `key`:

```tsx
import { GlobalLoaderProvider } from "blendsdk/react";
import type { ReactNode } from "react";

export function ThemedProviders({ theme, children }: { theme: "light" | "dark"; children: ReactNode }) {
    return (
        <GlobalLoaderProvider
            key={theme}
            config={{ backgroundColor: theme === "dark" ? "#1e1e1e" : "#fafafa" }}
        >
            {children}
        </GlobalLoaderProvider>
    );
}
```

### Check for duplicate React copies and version alignment

Signs of a duplicate React map to "Invalid hook call" warnings and hooks that return `null` context despite providers being present.

1. Run `npm ls react react-dom` — the tree must contain exactly one `react@19.x` and one `react-dom@19.x`.
2. Run `npm dedupe` (or `pnpm dedupe` / `yarn dedupe`), then reinstall if duplicates remain.
3. In bundled apps, add `resolve.dedupe: ["react", "react-dom"]` to the bundler config.
4. Confirm the peer ranges are satisfied: `react`/`react-dom` `^19.0.0` are required; `react-router` `^7.0.0` is optional and only needed when the guard components are used.

### Reduce to a minimal reproduction

1. Build a minimal tree containing only the failing provider and the hook/component that misbehaves (the `ProviderDiagnostics` component is a good template).
2. If it works in isolation, add your application layers back one at a time — router, layout, portals, additional roots — until the failure returns; the last layer added contains the cause.
3. Run the same tree against a production build: providers start asynchronous work in effects, and development `StrictMode` double-invokes those effects, which can look like a bug in logs.
4. If the failure only appears in the full app, check whether two copies of the library (or two module paths to it) are loaded — hooks from one copy cannot read contexts created by the other.

---

## Known Pitfalls

These behaviors are by design but regularly surprise integrators.

### Provider configuration is captured on mount, not reactive

`AuthProvider` merges its `config` with `AUTH_DEFAULTS` **on mount**, and `GlobalLoaderProvider` captures its config on mount as well. Passing a new `config` object later does not take effect — the session keeps the original endpoints, and the spinner keeps the original appearance. To apply new configuration, remount the provider (for example by changing its `key`) or hoist the config to a constant that never changes:

```tsx fragment
<GlobalLoaderProvider key={theme} config={{ spinnerColor: theme === "dark" ? "#ffffff" : "#888888" }}>
```

### One global overlay — concurrent operations race

The loader has a single visibility flag shared by every consumer. If two operations overlap, the first one to finish calls `showLoader(false)` and hides the indicator while the second is still running; overlapping `setText` calls overwrite each other's captions. Track active operations yourself:

```tsx
import { useCallback, useRef } from "react";
import { useGlobalLoader } from "blendsdk/react";

export function useScopedLoader() {
    const { showLoader, setText } = useGlobalLoader();
    const activeCount = useRef(0);

    return useCallback(
        async function runWithLoader<T>(text: string, task: () => Promise<T>): Promise<T> {
            activeCount.current += 1;
            if (activeCount.current === 1) {
                setText(text);
                showLoader(true);
            }

            try {
                return await task();
            } finally {
                activeCount.current -= 1;
                if (activeCount.current === 0) {
                    showLoader(false);
                }
            }
        },
        [showLoader, setText],
    );
}
```

Components then call `await runWithLoader("Saving…", () => save())`, and the overlay only disappears when the last overlapping task completes.

### Hiding the overlay clears its caption

`showLoader(false)` resets the caption text as a convenience. If your code sets the text once and shows/hides repeatedly, the caption will be missing on the second show. Set the caption immediately before every show:

```tsx fragment
setText("Saving…");
showLoader(true);
```

### `isAuthenticated` and `authorized` answer different questions

`isAuthenticated` means "a user is present". `authorized` is the server's verdict for the session — `false` before the first check, for anonymous or failed checks, for a session the application denied, and after logout. An unauthorized session is still authenticated. Gate the two states separately:

```tsx fragment
if (!isAuthenticated) {
    return <SignInPrompt />;
}

if (!authorized) {
    return <NotAuthorizedNotice />;
}
```

### Grants fail closed — and are presentation only

`useAuthorization()` (and the `Can`/`RequireAccess` components) read only the top-level `roles` and `permissions` string arrays of the session user. Anything else — missing values, nested claims, non-string entries — silently becomes an empty principal: buttons disappear and `RequireAccess` redirects, with no runtime error to explain why. And no client-side check is a security boundary; the server must enforce the same rules that shape the UI.

### Two kinds of paths — don't mix them

| Config value | Kind | Resolves against |
|--------------|------|------------------|
| `basePath` | BFF endpoint prefix | Request origin |
| `endpoints.*` | BFF endpoint paths | `basePath` |
| `loginPath`, `notAuthorizedPath`, `defaultReturnTo` | Frontend routes | Your application router |

Pairing a frontend route into `endpoints` (or a BFF path into `loginPath`) produces 404s or redirects to routes your router does not know. Note that `login()` navigates to the **BFF** login endpoint — it does not navigate to `loginPath`; that is the guard's job.

### CSRF tokens can be stale across tabs

The per-session token comes from the session check (`GET /me`) or a refresh. If another browsing context rotates it, this tab does not observe the new value until its next session check, and a request made with the outdated token can be rejected with `403`. Treat a 403 as retryable: refresh the session and repeat the request. A `null` `csrfToken` is not an error — it means CSRF is not enforced.

### `login()` is a full-page redirect, not client-side navigation

`login()` hands the browser over to the BFF login endpoint, which starts the OIDC round-trip server-side; the SPA reloads afterwards, so no React state survives the call. This also means navigation cannot be observed in jsdom-based tests ("Not implemented: navigation" is logged and nothing moves) — cover the redirect end-to-end and test the surrounding UI with stubbed context instead.

### Auto-refresh cannot outrun browser timer throttling

Automatic refresh is scheduled relative to `expiresAt` with `refreshLeadTime` (default 60 seconds). Browsers throttle — and can suspend — timers in background tabs, so the refresh can fire late, possibly after the session has already expired. Do not treat `autoRefresh` as a guarantee: handle `refresh()` returning `false` and expired sessions by sending the user back through `login()`, and increase `refreshLeadTime` if your sessions are short.

### Development `StrictMode` double-invokes effects

With React 19 `StrictMode` in development, mount effects run twice, so you will see duplicate `GET {basePath}/me` requests and duplicate loader calls in logs. This is expected React behavior, not a provider bug — re-test against a production build before chasing the duplicates.

### Mount providers once, at the app shell

Providers mounted inside route elements unmount and remount on navigation: `AuthProvider` re-runs its session check, `I18nProvider` reloads catalogs, and the loader loses its state. Mount all providers above the router's route tree so their lifetime outlives navigation.

### Guard components need a router and existing redirect targets

`AuthGuard` and `RequireAccess` redirect through `react-router` (an optional peer dependency). Render them inside your router, and make sure both redirect destinations — `loginPath` and `notAuthorizedPath` — exist as public routes in that router. Rendering a guard outside a router fails with a navigation-context error instead of a redirect.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
