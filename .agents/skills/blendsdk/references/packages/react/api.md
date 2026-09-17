> **Package**: `blendsdk/react`

# react API Reference

---

## GlobalLoader

### GlobalLoaderProvider

| Method   | Signature                                               | Returns       | Description                                          |
|----------|--------------------------------------------------------|---------------|------------------------------------------------------|
| `render` | `({ config, children }: GlobalLoaderProviderProps) => JSX.Element` | `JSX.Element` | Provides a context for managing the global loader state. |

---

### Hook: useGlobalLoader

#### Signature

```typescript
function useGlobalLoader(): GlobalLoaderContextValue
```

#### Parameters
N/A

#### Returns
The object with methods and properties:
- `showLoader`: Function to control visibility of the loader.
- `setText`: Function to set the loading message.
- `visible`: Read-only state indicating loader visibility.

#### Example
```typescript
import { GlobalLoaderProvider, useGlobalLoader } from 'blendsdk/react';

function MyComponent() {
    const { showLoader, setText } = useGlobalLoader();

    const loadData = async () => {
        setText("Loading data...");
        showLoader(true);
        // fetch data logic
        showLoader(false);
    };

    return <button onClick={loadData}>Load Data</button>;
}
```

---

### Types

#### GlobalLoaderProviderProps

| Property | Type                         | Description                                           |
|----------|------------------------------|------------------------------------------------------|
| `config` | `GlobalLoaderConfig`         | Optional configuration for the loader.               |
| `children` | `ReactNode`               | Application subtree that will have access to loader context. |

#### GlobalLoaderContextValue

| Property | Type                                       | Description                                           |
|----------|--------------------------------------------|-------------------------------------------------------|
| `showLoader` | `(visible: boolean) => void`           | Show or hide the loader overlay.                      |
| `setText`    | `(text: string | null) => void`       | Set the message displayed below the spinner.         |
| `visible`    | `boolean`                              | Current visibility state of the loader.               |

---

## I18n

### I18nProvider

| Method   | Signature                                               | Returns       | Description                                          |
|----------|--------------------------------------------------------|---------------|------------------------------------------------------|
| `render` | `({ loader, defaultLocale, children }: I18nProviderProps) => JSX.Element` | `JSX.Element` | Provides context for internationalization and translating content.  |

---

### Hook: useTranslations

#### Signature

```typescript
function useTranslations(): I18nContextValue
```

#### Parameters
N/A

#### Returns
The object with methods and properties:
- `t`: Translation function that takes a key and returns the translated string.
- `locale`: Current active locale.
- `setLocale`: Function to switch to a different locale.
- `reloadTranslations`: Function to force re-fetch translations for the current locale.
- `ready`: Boolean indicating if translations have been loaded successfully.

#### Example
```typescript
import { I18nProvider, useTranslations } from 'blendsdk/react';

const fetchTranslations = async (locale: string) => {
    // fetching logic
};

function MyComponent() {
    const { t, setLocale } = useTranslations();

    return (
        <div>
            <h1>{t('welcome.header')}</h1>
            <button onClick={() => setLocale('es')}>{t('language.switch')}</button>
        </div>
    );
}
```

---

### Types

#### I18nProviderProps

| Property          | Type                   | Description                                           |
|-------------------|------------------------|------------------------------------------------------|
| `loader`          | `TranslationLoader`    | Async function that loads translations for a given locale. |
| `defaultLocale`   | `string`               | Default locale to load on mount.                     |
| `children`        | `ReactNode`            | Application subtree that will have access to translations context. |

#### I18nContextValue

| Property           | Type                                 | Description                                           |
|--------------------|--------------------------------------|------------------------------------------------------|
| `t`                | `(key: string, params?: Record<string, unknown>) => string` | Translation function.                                 |
| `locale`           | `string`                             | Current active locale.                               |
| `setLocale`        | `(locale: string) => void`          | Function to switch locales.                          |
| `reloadTranslations`| `() => void`                        | Force re-fetch translations for the current locale. |
| `ready`            | `boolean`                            | Indicates if translations have been loaded.         |

---

## Authentication

### AuthProvider

| Method   | Signature                                                   | Returns       | Description                                          |
|----------|------------------------------------------------------------|---------------|------------------------------------------------------|
| `render` | `({ config, children }: AuthProviderProps) => JSX.Element` | `JSX.Element` | Provides context for managing authentication state.   |

---

### Hook: useAuth

#### Signature

```typescript
function useAuth(): AuthContextValue
```

#### Parameters
N/A

#### Returns
The object with methods and properties:
- `user`: Current authenticated user or null if not authenticated.
- `isAuthenticated`: Boolean indicating if the user is authenticated.
- `isLoading`: Boolean indicating if the initial session check is in progress.
- `login`: Function to redirect to the login endpoint.
- `logout`: Function to sign out the user.
- `refresh`: Function to manually refresh the session.
- `expiresAt`: Unix timestamp of session expiry or null if unknown.

#### Example
```typescript
import { AuthProvider, useAuth } from 'blendsdk/react';

function MyComponent() {
    const { user, isAuthenticated, login, logout } = useAuth();

    if (!isAuthenticated) {
        return <button onClick={login}>Sign In</button>;
    }

    return <button onClick={logout}>Sign Out ({user?.sub})</button>;
}
```

---

### Types

#### AuthProviderProps

| Property | Type                         | Description                                           |
|----------|------------------------------|------------------------------------------------------|
| `config` | `AuthConfig`                 | Required configuration for authentication.            |
| `children` | `ReactNode`               | Application subtree that will have access to auth context. |

#### AuthContextValue

| Property         | Type                                        | Description                                         |
|------------------|---------------------------------------------|-----------------------------------------------------|
| `user`           | `AuthUser | null`                           | Current authenticated user or null if not authenticated. |
| `isAuthenticated` | `boolean`                                  | Whether the user is currently authenticated.        |
| `isLoading`      | `boolean`                                  | Whether the initial session check is in progress.   |
| `login`          | `(returnTo?: string) => void`              | Redirect to the BFF login endpoint.                 |
| `logout`         | `() => Promise<void>`                       | Sign out via the BFF logout endpoint.               |
| `refresh`        | `() => Promise<boolean>`                    | Refresh the session.                                |
| `expiresAt`      | `number | null`                             | Unix timestamp when the session expires, or null.  |

---

## Constants

### AUTH_DEFAULTS

| Key                  | Type                         | Description                                           |
|----------------------|------------------------------|------------------------------------------------------|
| `endpoints`          | `{ login: string, callback: string, logout: string, me: string, refresh: string }` | Default endpoint paths for the authentication module. |
| `loginPath`          | `string`                     | Path for the login page.                            |
| `notAuthorizedPath`  | `string`                     | Path for unauthorized access.                       |
| `defaultReturnTo`    | `string`                     | Path to redirect to post-login.                     |
| `autoRefresh`        | `boolean`                    | Enable automatic token refresh.                      |
| `refreshLeadTime`    | `number`                     | Seconds before expiry to trigger refresh.           |

#### Usage Example
```typescript
import { AUTH_DEFAULTS } from 'blendsdk/react';
console.log(AUTH_DEFAULTS.loginPath); // Outputs: '/login'
```

---

## Additional Types

### GlobalLoaderConfig

| Property          | Type                   | Description                                           |
|-------------------|------------------------|------------------------------------------------------|
| `spinnerColor`    | `string`               | CSS color for the spinner arc.                       |
| `spinnerWidth`    | `number`               | Spinner arc width in pixels.                         |
| `backgroundColor` | `string`               | Background color of the full-screen overlay.        |
| `spinnerSize`     | `number`               | Diameter of the spinner in pixels.                   |
| `textColor`       | `string`               | CSS color for the text below the spinner.           |
| `zIndex`          | `number`               | CSS z-index for the overlay.                         |
| `textComponent`   | `(props: { text: string; textColor: string }) => ReactElement` | Custom render function for the text displayed below the spinner. |

### AuthConfig

| Property                  | Type                           | Description                                           |
|---------------------------|--------------------------------|------------------------------------------------------|
| `basePath`                | `string`                       | Required base path for all auth endpoints.          |
| `endpoints`              | `{ login?: string, ... }`     | Override paths for login, logout, etc.              |
| `loginPath`              | `string`                       | Path for login redirection.                          |
| `notAuthorizedPath`      | `string`                       | Path shown when unauthorized access occurs.          |
| `defaultReturnTo`        | `string`                       | Path for redirection after login.                    |
| `autoRefresh`            | `boolean`                      | Enable automatic token refresh before expiry.       |
| `refreshLeadTime`        | `number`                       | Seconds before expiry for refresh initiation.        |

### TranslationLoader

| Signature                                          | Description                                           |
|----------------------------------------------------|------------------------------------------------------|
| `(locale: string) => Promise<Record<string, TranslationValue>>` | Function that loads translations for a specific locale. |

### TranslateFunction

| Signature                                          | Description                                           |
|----------------------------------------------------|------------------------------------------------------|
| `(key: string, params?: Record<string, unknown>) => string` | Translates a key with optional parameters.           |

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
