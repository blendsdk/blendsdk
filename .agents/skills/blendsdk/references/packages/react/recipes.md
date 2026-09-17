> **Package**: `blendsdk/react`

# react Advanced Patterns

---

## Authentication with Global Loader

### When to Use It

This pattern combines the `AuthProvider` for managing authentication and the `GlobalLoaderProvider` for displaying a loading indicator while authentication checks are being processed. It is particularly valuable in applications where immediate feedback is necessary during user actions related to authentication, such as login or logout, to enhance the user experience.

### Complete Real-World Code Example

```typescript
import { useEffect } from 'react';
import { GlobalLoaderProvider, useGlobalLoader, AuthProvider, useAuth } from 'blendsdk/react';

const authConfig = {
  basePath: '/api/auth',
  loginPath: '/login',
  notAuthorizedPath: '/not-authorized',
};

function App() {
  return (
    <GlobalLoaderProvider>
      <AuthProvider config={authConfig}>
        <AuthComponent />
      </AuthProvider>
    </GlobalLoaderProvider>
  );
}

function AuthComponent() {
  const { showLoader, setText } = useGlobalLoader();
  const { user, isLoading, login, logout } = useAuth();

  useEffect(() => {
    if (isLoading) {
      setText("Checking authentication...");
      showLoader(true);
    } else {
      showLoader(false);
    }
  }, [isLoading, setText, showLoader]);

  const handleLogin = async () => {
    try {
      setText("Logging in...");
      showLoader(true);
      await login();
    } catch (error) {
      console.error("Login failed:", error);
    } finally {
      showLoader(false);
    }
  };

  if (user) {
    return (
      <div>
        <p>Welcome, {user.sub}!</p>
        <button onClick={logout}>Sign Out</button>
      </div>
    );
  }

  return <button onClick={handleLogin}>Sign In</button>;
}
```

### Explanation of Why This Pattern Is Valuable

Utilizing both `GlobalLoader` and authentication management ensures that users receive immediate feedback regarding the authentication process. This builds trust and enhances UI responsiveness. The loading state helps prevent multiple login attempts while a request is pending.

### Caveats or Performance Considerations

Ensure that your application handles loading states efficiently. Too many loading indicators can lead to a poor user experience. It is also crucial to manage the loading text appropriately to reflect the exact state of the authentication process.

---

## Internationalization with Loading State

### When to Use It

This pattern is useful when developing applications that require translations to be loaded dynamically based on user actions, along with providing feedback during the loading state. It effectively combines `I18nProvider` for translations with `GlobalLoaderProvider` to manage user experience while data is being fetched.

### Complete Real-World Code Example

```typescript
import { GlobalLoaderProvider, I18nProvider, useTranslations, useGlobalLoader } from 'blendsdk/react';

const fetchTranslations = async (locale: string) => {
  const response = await fetch(`/api/translations/${locale}`);
  return response.json();
};

function App() {
  return (
    <GlobalLoaderProvider>
      <I18nProvider loader={fetchTranslations} defaultLocale="en">
        <TranslationComponent />
      </I18nProvider>
    </GlobalLoaderProvider>
  );
}

function TranslationComponent() {
  const { t, setLocale, ready } = useTranslations();
  const { showLoader, setText } = useGlobalLoader();

  const handleLocaleChange = async (locale: string) => {
    setText("Loading translations...");
    showLoader(true);
    await setLocale(locale);
    showLoader(false);
  };

  return ready ? (
    <div>
      <h1>{t('welcome.header')}</h1>
      <button onClick={() => handleLocaleChange('es')}>{t('language.switch')}</button>
    </div>
  ) : (
    <p>Loading translations...</p>
  );
}
```

### Explanation of Why This Pattern Is Valuable

This pattern enhances the user experience by providing immediate feedback while translations are loading. It ensures that users know the system is actively fetching the required data, which can appreciate context while navigating the application.

### Caveats or Performance Considerations

Fetching translations can affect application performance if the loading time is substantial. Use efficient caching mechanisms or local storage to minimize the need for repeated network calls when switching locales. Consider handling errors gracefully during translation fetching to maintain good UX.

---

## Access Control with Authorization and Global Loading

### When to Use It

This pattern is effective when implementing route protection or component-level access control based on user permissions while leveraging loading states via the `GlobalLoader`. It combines `RequireAccess` for access control and `GlobalLoaderProvider` to show loading states during verification.

### Complete Real-World Code Example

```typescript
import { GlobalLoaderProvider, AuthProvider, RequireAccess, useAuth, useGlobalLoader } from 'blendsdk/react';

const authConfig = {
  basePath: '/api/auth',
  loginPath: '/login',
  notAuthorizedPath: '/not-authorized',
};

function App() {
  return (
    <GlobalLoaderProvider>
      <AuthProvider config={authConfig}>
        <ProtectedComponent />
      </AuthProvider>
    </GlobalLoaderProvider>
  );
}

function ProtectedComponent() {
  const { showLoader, setText } = useGlobalLoader();
  const { isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) {
      setText("Loading your permissions...");
      showLoader(true);
    } else {
      showLoader(false);
    }
  }, [isLoading, setText, showLoader]);

  return (
    <RequireAccess requirement={{ permissions: ['admin'] }}>
      <div>
        <h1>Admin Panel</h1>
        <p>Welcome to the admin panel!</p>
      </div>
    </RequireAccess>
  );
}
```

### Explanation of Why This Pattern Is Valuable

By integrating access control with a loading state, users are kept informed during authentication and permission checks, enhancing the application's transparency and reliability. It also prevents unauthorized users from accessing protected content while the application verifies their permissions.

### Caveats or Performance Considerations

Access control checks can be time-consuming, leading to potential delays in loading states. Optimize performance by ensuring that permission checks are efficient and consider utilizing local authentication states where applicable to minimize server requests.

---

# react Common Scenarios

---

## How do I display a global loading indicator?

You can use the `GlobalLoaderProvider` to wrap your application, allowing you to display a loading indicator throughout your app. The `useGlobalLoader` hook provides functions to control the visibility of the loading overlay.

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
    setText("Loading...");
    showLoader(true);
    await fetchData();
    showLoader(false);
  };

  return <button onClick={handleLoadData}>Load Data</button>;
}
```

---

## How do I use translations in my React components?

You can implement translations by wrapping your application in `I18nProvider` and using the `useTranslations` hook to access the translation function and the current locale.

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

---

## How do I implement authentication in my app?

You can use the `AuthProvider` to manage user authentication and utilize the `useAuth` hook to access the authentication state and actions like login and logout.

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

## How do I handle errors during login?

When logging in, it's essential to catch errors for better user experience. Wrap your login logic in a try/catch block.

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

---

## How do I show a loading indicator during data fetching?

You can use the `showLoader` method from `useGlobalLoader` to manage the loading state during asynchronous actions such as data fetching.

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

  const fetchData = async () => {
    setText("Loading data...");
    showLoader(true);
    await fetch('/api/data');
    showLoader(false);
  };

  return <button onClick={fetchData}>Fetch Data</button>;
}
```

---

## How do I protect routes based on user permissions?

You can use the `RequireAccess` component along with `AuthProvider` to protect routes by checking user permissions.

```typescript
import { GlobalLoaderProvider, AuthProvider, RequireAccess } from 'blendsdk/react';

const authConfig = {
  basePath: '/api/auth',
  loginPath: '/login',
  notAuthorizedPath: '/not-authorized',
};

function App() {
  return (
    <GlobalLoaderProvider>
      <AuthProvider config={authConfig}>
        <ProtectedComponent />
      </AuthProvider>
    </GlobalLoaderProvider>
  );
}

function ProtectedComponent() {
  return (
    <RequireAccess requirement={{ permissions: ['admin'] }}>
      <div>
        <h1>Admin Panel</h1>
        <p>Welcome to the admin panel!</p>
      </div>
    </RequireAccess>
  );
}
```

---

## How do I use the default loading message with the Global Loader?

You can customize the loading message displayed by using `setText` from `useGlobalLoader`.

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

  const loadData = async () => {
    setText("Please wait, loading data...");
    showLoader(true);
    await fetchData();
    showLoader(false);
  };

  return <button onClick={loadData}>Load Data</button>;
}
```

---

## How do I switch locales for internationalization?

To switch locales, utilize the `setLocale` function from the `useTranslations` hook, enabling dynamic language changes in your application.

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

---

## How do I customize the loading spinner's properties?

You can customize the loading spinner by passing configuration options to the `GlobalLoaderProvider`.

```typescript
import { GlobalLoaderProvider, useGlobalLoader } from 'blendsdk/react';

function App() {
  return (
    <GlobalLoaderProvider
      config={{
        spinnerColor: '#ff0000',
        spinnerSize: 70,
        backgroundColor: 'rgba(255, 255, 255, 0.8)',
      }}
    >
      <MyComponent />
    </GlobalLoaderProvider>
  );
}

function MyComponent() {
  const { showLoader } = useGlobalLoader();

  const handleLoadData = async () => {
    showLoader(true);
    await fetchData();
    showLoader(false);
  };

  return <button onClick={handleLoadData}>Load Data</button>;
}
```

---

# react Examples Library

---

## Global Loader Examples

### Basic Global Loader Usage
This example demonstrates how to implement a simple global loader in an application.
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
// Expected Output: Clicking the button will show the loading overlay with "Loading data..." text.
```

### Customizing Global Loader Styles
You can customize the appearance of the global loader by providing configuration options.
```typescript
import { GlobalLoaderProvider, useGlobalLoader } from 'blendsdk/react';

function App() {
  return (
    <GlobalLoaderProvider config={{ spinnerColor: '#ff0000', spinnerSize: 80 }}>
      <MyComponent />
    </GlobalLoaderProvider>
  );
}

function MyComponent() {
  const { showLoader } = useGlobalLoader();

  const handleLoadData = async () => {
    showLoader(true);
    await fetchData();
    showLoader(false);
  };

  return <button onClick={handleLoadData}>Load Data</button>;
}
// Expected Output: The loader will display a red spinner with a size of 80 pixels.
```

---

## Internationalization (I18n) Examples

### Basic Translations Setup
This example shows how to implement basic internationalization with a translation provider.
```typescript
import { GlobalLoaderProvider, I18nProvider, useTranslations } from 'blendsdk/react';

const fetchTranslations = async (locale: string) => {
  return {
    welcome: { header: 'Welcome' },
    'language.switch': 'Switch Language'
  };
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
  const { t } = useTranslations();

  return <h1>{t('welcome.header')}</h1>;
}
// Expected Output: Renders "Welcome" as the header text.
```

### Changing Locale Dynamically
This example illustrates how to switch locales dynamically based on user actions.
```typescript
import { GlobalLoaderProvider, I18nProvider, useTranslations } from 'blendsdk/react';

const fetchTranslations = async (locale: string) => {
  return {
    welcome: { header: locale === 'en' ? 'Welcome' : 'Bienvenido' },
    'language.switch': 'Switch Language'
  };
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
// Expected Output: Clicking the button will change the header from "Welcome" to "Bienvenido".
```

---

## Authentication Examples

### Basic Authentication Setup
This example shows how to use authentication context in your application.
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
    return <button onClick={login}>Sign In</button>;
  }

  return <div>
    <p>Welcome back, {user?.sub}!</p>
    <button onClick={logout}>Sign Out</button>
  </div>;
}
// Expected Output: Displays a sign-in button if not authenticated, otherwise shows a welcome message.
```

### Protecting Routes
This example demonstrates how to protect routes based on user permissions.
```typescript
import { AuthProvider, RequireAccess } from 'blendsdk/react';

const authConfig = {
  basePath: '/api/auth',
  loginPath: '/login',
  notAuthorizedPath: '/not-authorized',
};

function App() {
  return (
    <AuthProvider config={authConfig}>
      <ProtectedComponent />
    </AuthProvider>
  );
}

function ProtectedComponent() {
  return (
    <RequireAccess requirement={{ permissions: ['admin'] }}>
      <h1>Admin Panel</h1>
      <p>This content is only visible to admins.</p>
    </RequireAccess>
  );
}
// Expected Output: Displays "Admin Panel" content only if the user has 'admin' permissions.
```

---

## Advanced Usage Examples

### Combining Global Loader with Authentication
This example combines the use of a global loader during the authentication process.
```typescript
import { GlobalLoaderProvider, AuthProvider, useAuth, useGlobalLoader } from 'blendsdk/react';

const authConfig = {
  basePath: '/api/auth',
  loginPath: '/login',
  notAuthorizedPath: '/not-authorized',
};

function App() {
  return (
    <GlobalLoaderProvider>
      <AuthProvider config={authConfig}>
        <AuthComponent />
      </AuthProvider>
    </GlobalLoaderProvider>
  );
}

function AuthComponent() {
  const { showLoader, setText } = useGlobalLoader();
  const { login } = useAuth();

  const handleLogin = async () => {
    setText("Logging in...");
    showLoader(true);
    await login();
    showLoader(false);
  };

  return <button onClick={handleLogin}>Sign In</button>;
}
// Expected Output: Shows "Logging in..." while logging in, with the global loader displayed.
```

### Dynamic Content Loading with Loader
This example shows how to display a loading message while fetching data asynchronously.
```typescript
import { GlobalLoaderProvider, useGlobalLoader } from 'blendsdk/react';

function App() {
  return (
    <GlobalLoaderProvider>
      <DataComponent />
    </GlobalLoaderProvider>
  );
}

function DataComponent() {
  const { showLoader, setText } = useGlobalLoader();

  const fetchData = async () => {
    setText("Fetching data...");
    showLoader(true);
    await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate data fetching
    showLoader(false);
  };

  return <button onClick={fetchData}>Fetch Data</button>;
}
// Expected Output: While the button is clicked, the loader shows "Fetching data..." during the simulated fetching process.
```

--- 

*This concludes the examples library for the `blendsdk/react` package. Each example is designed to be self-contained and can be directly copied and pasted into your TypeScript projects to demonstrate the respective functionalities.*

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
