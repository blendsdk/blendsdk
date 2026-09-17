> **Package**: `blendsdk/react`

# react Core Concepts

---

## GlobalLoader

### What It Is

`GlobalLoader` is a full-screen overlay component designed to enhance user experience during loading states in BlendSDK applications. It provides a customizable spinner and optional text to inform users about ongoing processes.

### How It Works

The `GlobalLoaderProvider` component encapsulates the application and manages the loading state. It exposes context functions that allow any child component to show or hide the loading overlay and update the accompanying message. Configuration options can be provided to customize the appearance of the loader, including colors, sizes, and text rendering.

### Complete Example

```typescript
import { GlobalLoaderProvider, useGlobalLoader } from 'blendsdk/react';

function App() {
  return (
    <GlobalLoaderProvider config={{ spinnerColor: '#25b09b' }}>
      <MyComponent />
    </GlobalLoaderProvider>
  );
}

function MyComponent() {
  const { showLoader, setText } = useGlobalLoader();

  const handleLoadData = async () => {
    setText("Loading...");
    showLoader(true);
    await fetchData();
    showLoader(false);
  };

  return <button onClick={handleLoadData}>Load Data</button>;
}
```

### Key Methods/Properties Table

| Name         | Type/Signature                         | Description                                           |
|--------------|----------------------------------------|-------------------------------------------------------|
| `showLoader` | `(visible: boolean) => void`          | Show or hide the loader overlay.                      |
| `setText`    | `(text: string | null) => void`      | Set the message displayed below the spinner.         |
| `visible`    | `boolean`                              | Current visibility state of the loader.               |

---

## I18n

### What It Is

The I18n module provides internationalization support for BlendSDK applications. It allows for dynamic loading of translations for different locales and facilitates language switching within the application.

### How It Works

The `I18nProvider` wraps the application and loads translations on mount. The translations can be accessed using the `useTranslations` hook, which provides a `t` function for translating keys dynamically. It supports a loader function that fetches translations and allows changing locales with automatic re-fetching of the relevant translations.

### Complete Example

```typescript
import { GlobalLoaderProvider, I18nProvider, useTranslations } from 'blendsdk/react';

const fetchTranslations = async (locale: string) => {
  const res = await fetch(`/api/translations/${locale}`);
  return res.json();
};

function App() {
  return (
    <GlobalLoaderProvider>
      <I18nProvider loader={fetchTranslations} defaultLocale="en">
        <MyComponent />
      </I18nProvider>
    </GlobalLoaderProvider>
  );
}

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

### Key Methods/Properties Table

| Name         | Type/Signature                         | Description                                           |
|--------------|----------------------------------------|-------------------------------------------------------|
| `t`          | `(key: string, params?: Record<string, unknown>) => string` | Translation function for fetching localized strings.  |
| `locale`     | `string`                              | Current active locale.                                |
| `setLocale`  | `(locale: string) => void`            | Function to switch to a different locale.            |
| `ready`      | `boolean`                              | Indicates if translations have been loaded.          |

---

## Authentication

### What It Is

The authentication module provides components and hooks for managing user sessions and authorization in BlendSDK applications. It simplifies the implementation of authentication flows and protects routes based on user permissions.

### How It Works

The `AuthProvider` component manages the authentication state and provides context to the rest of the application. The `useAuth` hook allows components to access user information, login/logout functions, and loading state. Additionally, the `RequireAccess` and `Can` components are used to manage access control based on user permissions.

### Complete Example

```typescript
import { AuthProvider, useAuth } from 'blendsdk/react';

const authConfig = {
  basePath: '/api/auth',
  loginPath: '/login',
  notAuthorizedPath: '/not-authorized',
};

function App() {
  return (
    <AuthProvider config={authConfig}>
      <MyComponent />
    </AuthProvider>
  );
}

function MyComponent() {
  const { user, isAuthenticated, login, logout } = useAuth();

  if (!isAuthenticated) {
    return <button onClick={() => login()}>Sign In</button>;
  }

  return <button onClick={() => logout()}>Sign Out ({user?.sub})</button>;
}
```

### Key Methods/Properties Table

| Name         | Type/Signature                         | Description                                           |
|--------------|----------------------------------------|-------------------------------------------------------|
| `user`       | `AuthUser | null`                      | Current authenticated user, or null if not authenticated. |
| `isAuthenticated` | `boolean`                        | Whether the user is currently authenticated.         |
| `isLoading`  | `boolean`                              | Whether the initial session check is in progress.    |
| `login`      | `(returnTo?: string) => void`         | Redirect to the login endpoint with an optional return path. |
| `logout`     | `() => Promise<void>`                  | Sign out the user and clear local state.             |
| `refresh`    | `() => Promise<boolean>`               | Manually refresh the session.                         |

---

## Summary

The `blendsdk/react` package provides powerful tools for managing global loading states, internationalization, and authentication in BlendSDK applications. Each core concept is designed with a clear API and strong TypeScript support to ensure type safety and facilitate developer experience. 

For more details on using `blendsdk/react`, please refer to related concepts and usage guides in the documentation.

---

# react Basic Usage

---

## Installation

To install the `blendsdk/react` package, run the following command:

```bash
npm install blendsdk/react
```
or, using Yarn:

```bash
yarn add blendsdk/react
```

---

## Quick Start

Here’s how to get a basic BlendSDK application running with a global loader:

```typescript
import { GlobalLoaderProvider, useGlobalLoader } from 'blendsdk/react';

function App() {
  return (
    <GlobalLoaderProvider>
      <MyComponent />
    </GlobalLoaderProvider>
  );
}

function MyComponent() {
  const { showLoader, setText } = useGlobalLoader();

  const handleLoadData = async () => {
    setText("Loading data...");
    showLoader(true);
    await fetchData();
    showLoader(false);
  };

  return <button onClick={handleLoadData}>Load Data</button>;
}
```

---

## Fundamentals

### GlobalLoader

The GlobalLoader provides a full-screen loading overlay to improve the user experience during asynchronous operations.

#### Complete Example

```typescript
import { GlobalLoaderProvider, useGlobalLoader } from 'blendsdk/react';

function App() {
  return (
    <GlobalLoaderProvider>
      <MyComponent />
    </GlobalLoaderProvider>
  );
}

function MyComponent() {
  const { showLoader, setText } = useGlobalLoader();

  const handleLoadData = async () => {
    setText("Loading…");
    showLoader(true);
    await fetchData();
    showLoader(false);
  };

  return <button onClick={handleLoadData}>Load Data</button>;
}
```

### I18n

The I18n module allows for internationalization in your application, enabling support for multiple languages.

#### Complete Example

```typescript
import { GlobalLoaderProvider, I18nProvider, useTranslations } from 'blendsdk/react';

const fetchTranslations = async (locale: string) => {
  const response = await fetch(`/api/translations/${locale}`);
  return response.json();
};

function App() {
  return (
    <GlobalLoaderProvider>
      <I18nProvider loader={fetchTranslations} defaultLocale="en">
        <MyComponent />
      </I18nProvider>
    </GlobalLoaderProvider>
  );
}

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

### Authentication

The Authentication module simplifies user session management and authorization logic.

#### Complete Example

```typescript
import { AuthProvider, useAuth } from 'blendsdk/react';

const authConfig = {
  basePath: '/api/auth',
  loginPath: '/login',
  notAuthorizedPath: '/not-authorized',
};

function App() {
  return (
    <AuthProvider config={authConfig}>
      <MyComponent />
    </AuthProvider>
  );
}

function MyComponent() {
  const { user, isAuthenticated, login, logout } = useAuth();

  if (!isAuthenticated) {
    return <button onClick={() => login()}>Sign In</button>;
  }

  return <button onClick={() => logout()}>Sign Out ({user?.sub})</button>;
}
```

---

## Configuration

Here are common configuration options for the components in `blendsdk/react`.

### GlobalLoaderProvider Configuration Options

| Name           | Type                  | Default       | Description                                           |
|----------------|-----------------------|---------------|-------------------------------------------------------|
| `spinnerColor` | `string`              | `#888888`     | CSS color for the spinner arc.                        |
| `spinnerWidth` | `number`              | `3`           | Spinner arc width in pixels.                          |
| `backgroundColor` | `string`          | `#fafafa`     | Background color of the full-screen overlay.         |
| `spinnerSize`  | `number`              | `50`          | Spinner diameter in pixels.                          |
| `textColor`    | `string`              | `#888888`     | CSS color for the text below the spinner.            |
| `zIndex`       | `number`              | `999999`      | CSS z-index for the overlay.                          |

### Authentication Configuration

| Name                   | Type                     | Default       | Description                                           |
|------------------------|--------------------------|---------------|-------------------------------------------------------|
| `basePath`             | `string`                 | Required      | Base path for all auth endpoints (e.g., `/api/auth`). |
| `loginPath`            | `string`                 | `/login`      | Path for the login page.                             |
| `notAuthorizedPath`    | `string`                 | `/not-authorized` | Path shown to users without required grants.     |
| `defaultReturnTo`      | `string`                 | `/`           | Path to redirect to after login.                     |
| `autoRefresh`          | `boolean`                | `true`        | Enable automatic token refresh.                      |
| `refreshLeadTime`      | `number`                 | `60`          | Seconds before expiry to trigger refresh.            |

---

## Error Handling

When using `blendsdk/react`, you can implement error handling in your components using try/catch blocks. Here’s how you can handle errors when using the hooks:

### Example with Error Handling

```typescript
import { AuthProvider, useAuth } from 'blendsdk/react';

const authConfig = {
  basePath: '/api/auth',
  loginPath: '/login',
  notAuthorizedPath: '/not-authorized',
};

function App() {
  return (
    <AuthProvider config={authConfig}>
      <MyComponent />
    </AuthProvider>
  );
}

async function handleLogin() {
  try {
    await login();
  } catch (error) {
    console.error("Failed to log in:", error);
  }
}

function MyComponent() {
  const { isAuthenticated, login, logout } = useAuth();

  if (!isAuthenticated) {
    return <button onClick={handleLogin}>Sign In</button>;
  }

  return <button onClick={logout}>Sign Out</button>;
}
```

By following these examples, you can get started with the `blendsdk/react` package effectively, utilizing its features for global loading, internationalization, and authentication within your BlendSDK applications.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
