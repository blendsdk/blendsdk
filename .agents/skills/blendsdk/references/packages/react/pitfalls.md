> **Package**: `blendsdk/react`

# react Best Practices

---

## Do / Don't Pairs

### 1. Async/Await Usage

❌ **Wrong:**
```typescript
import { useAuth } from 'blendsdk/react';

async function handleLogin() {
    login();
}
```

✅ **Correct:**
```typescript
import { useAuth } from 'blendsdk/react';

async function handleLogin() {
    try {
        await login();
    } catch (error) {
        console.error("Login failed:", error);
    }
}
```
**Why?** Using `await` ensures that the function waits for the login process to complete, allowing for proper error handling and UX management.

---

### 2. Context Accessibility

❌ **Wrong:**
```typescript
import { useTranslations } from 'blendsdk/react';

const translations = useTranslations();
```

✅ **Correct:**
```typescript
import { useTranslations } from 'blendsdk/react';

function MyComponent() {
    const { t } = useTranslations();
    return <div>{t('welcome.message')}</div>;
}
```
**Why?** Hooks must be called inside a functional component or another hook to ensure proper context is provided. Calling it outside can lead to undefined behavior.

---

### 3. Loading State Management

❌ **Wrong:**
```typescript
import { useGlobalLoader } from 'blendsdk/react';

function MyComponent() {
    const { showLoader } = useGlobalLoader();
    showLoader(true); // Immediately shows loader
}
```

✅ **Correct:**
```typescript
import { useGlobalLoader } from 'blendsdk/react';

function MyComponent() {
    const { showLoader, setText } = useGlobalLoader();

    const loadData = async () => {
        setText("Loading...");
        showLoader(true);
        await fetchData();
        showLoader(false);
    };

    return <button onClick={loadData}>Load Data</button>;
}
```
**Why?** The loading state must be controlled in response to async operations to provide feedback during data fetching, ensuring a smooth UX.

---

## Anti-Patterns

### 1. Direct State Mutation

**Problematic Code:**
```typescript
import { useAuth } from 'blendsdk/react';

function MyComponent() {
    const { user } = useAuth();
    user.sub = "new value"; // Directly mutating context state
}
```
**Description:** Directly mutating state managed by context can lead to unexpected state updates and break the application reactivity. Always use the provided functions.

### 2. Invalid Dependency Arrays

**Problematic Code:**
```typescript
import { useEffect } from 'react';
import { useGlobalLoader } from 'blendsdk/react';

function MyComponent() {
    const { showLoader } = useGlobalLoader();
    
    useEffect(() => {
        showLoader(true);
    }); // Missing dependency array
}
```
**Description:** Omitting the dependency array in `useEffect` can lead to infinite loops. Always provide an empty array or specific dependencies to prevent uncontrolled renders.

---

## Performance Tips

### 1. Memoization

Use `React.useMemo` to memoize expensive calculations based on dependencies when rendering components that consume context values.

```typescript
import { useMemo } from 'react';
import { useTranslations } from 'blendsdk/react';

function MyComponent() {
    const { t } = useTranslations();

    const renderedText = useMemo(() => t('welcome.header'), [t]);

    return <h1>{renderedText}</h1>;
}
```
**Reasoning:** Memoization minimizes unnecessary calculations on every render, optimizing performance and improving the responsiveness of your application.

---

### 2. Lazy Loading Components

Utilize `React.lazy` and `Suspense` to load components only when they are needed. This reduces initial bundle size and improves load times.

```typescript
import { Suspense, lazy } from 'react';

const LazyComponent = lazy(() => import('./LazyComponent'));

function App() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <LazyComponent />
        </Suspense>
    );
}
```
**Reasoning:** Loading components only when required decreases the time taken to render the main application interface, offering a smoother user experience.

---

## Security Considerations

### 1. Avoid Exposing Sensitive Data

Ensure that no sensitive information (such as tokens or sensitive user details) is directly placed in the client code or transmitted without proper validation.

### 2. Implement Proper Authorization Checks

Always validate user authorization both on the client and server side. Relying solely on client-side checks can lead to security vulnerabilities.

**Example of Secure Authorization:**
```typescript
import { RequireAccess } from 'blendsdk/react';

function ProtectedComponent() {
    return (
        <RequireAccess requirement={{ permissions: ['admin'] }}>
            <div>This is protected content.</div>
        </RequireAccess>
    );
}
```
**Reasoning:** Confirming permissions server-side prevents unauthorized access and maintains application security integrity.

---

---

# react Testing Patterns

---

## Test Setup

When setting up tests for `blendsdk/react`, you need to import the necessary testing tools and the components you wish to test. Vitest, along with Testing Library for React, is the preferred choice for testing.

### Required Imports

```typescript
import { render, screen } from '@testing-library/react';
import { GlobalLoaderProvider } from 'blendsdk/react'; // Wrap components that use GlobalLoaderProvider
import { AuthProvider } from 'blendsdk/react'; // For testing authentication components
import { I18nProvider } from 'blendsdk/react'; // For testing internationalization
```

### Test Framework Configuration

Ensure your `vitest.config.ts` is set up to work with React and TypeScript. A basic configuration should include the following:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
    },
  },
});
```

---

## Unit Testing

When unit testing components from `blendsdk/react`, it is essential to render them within their provider contexts where necessary.

### Example: Testing GlobalLoader

```typescript
import { render, screen } from '@testing-library/react';
import { GlobalLoaderProvider, useGlobalLoader } from 'blendsdk/react';

function TestComponent() {
  const { showLoader, setText } = useGlobalLoader();

  const handleLoad = () => {
    setText("Loading...");
    showLoader(true);
  };

  return <button onClick={handleLoad}>Load Data</button>;
}

test('displays loading message when button clicked', async () => {
  render(
    <GlobalLoaderProvider>
      <TestComponent />
    </GlobalLoaderProvider>
  );

  const button = screen.getByRole('button', { name: /load data/i });
  await userEvent.click(button);
  
  expect(screen.getByText(/loading.../i)).toBeInTheDocument();
});
```

### Example: Testing AuthProvider

```typescript
import { render, screen } from '@testing-library/react';
import { AuthProvider, useAuth } from 'blendsdk/react';

function TestAuthComponent() {
  const { login } = useAuth();

  return <button onClick={login}>Sign In</button>;
}

test('calls login function when button is clicked', () => {
  const mockLogin = jest.fn();
  
  render(
    <AuthProvider config={{ basePath: '/' }}>
      <TestAuthComponent />
    </AuthProvider>
  );

  const button = screen.getByRole('button', { name: /sign in/i });
  button.onclick = mockLogin;

  userEvent.click(button);
  
  expect(mockLogin).toHaveBeenCalled();
});
```

---

## Integration Testing

Integration tests evaluate how various components of your application interact with each other, particularly their context providers.

### Example: Full App Test with I18nProvider

```typescript
import { render, screen } from '@testing-library/react';
import { I18nProvider, GlobalLoaderProvider } from 'blendsdk/react';

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

test('renders greeting in default language', () => {
  render(<App />);
  
  expect(screen.getByText(/welcome/i)).toBeInTheDocument();
});
```

---

## Mocking & Stubbing

When testing, you may want to mock or stub components or hooks from the `blendsdk/react` package to isolate tests and avoid making real API calls.

### Mocking useAuth

```typescript
jest.mock('blendsdk/react', () => ({
  useAuth: jest.fn(),
}));

test('renders sign-in button when unauthenticated', () => {
  (useAuth as jest.Mock).mockReturnValue({
    user: null,
    login: jest.fn(),
  });
  
  render(
    <AuthProvider config={{ basePath: '/' }}>
      <TestAuthComponent />
    </AuthProvider>
  );

  expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
});
```

### Mocking useTranslations

```typescript
jest.mock('blendsdk/react', () => ({
  useTranslations: jest.fn(),
}));

test('shows translated text', () => {
  (useTranslations as jest.Mock).mockReturnValue({
    t: (key: string) => {
      if (key === 'welcome.header') return 'Welcome';
      return key;
    },
  });

  render(<MyComponent />);
  
  expect(screen.getByText(/welcome/i)).toBeInTheDocument();
});
```

---

## Test Patterns by Feature

### GlobalLoader

- **Test If Loader Shows When Invoked**
  - Render a component within `GlobalLoaderProvider` and invoke the loading function.
  - Verify the loading text is displayed.

### Authentication

- **Test Login Functionality**
  - Render an `AuthProvider` with a mocked login function.
  - Simulate user clicking login and check function is called.

### Internationalization

- **Test Translation Loading**
  - Render with `I18nProvider` and verify translations based on keys.

---

## Conclusion

Testing in the `blendsdk/react` package is streamlined using Vitest combined with Testing Library for React. Focus on context and hooks while ensuring you provide necessary providers during your tests. Mocking and integration tests help validate the interactions between components and their dependencies effectively. Always wrap components needing context in their respective providers for accurate tests.

---

# react Troubleshooting

---

## Common Errors

### Authentication Errors

#### Error: `useAuth() must be used within an <AuthProvider>.`
- **Cause**: This occurs when the `useAuth` hook is called in a component that is not wrapped with the `AuthProvider`.
- **Fix**: Ensure your application structure wraps components needing authentication logic within `AuthProvider`.

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
    const { user, isAuthenticated } = useAuth();
    return isAuthenticated ? <div>Welcome, {user?.sub}</div> : <p>Please log in.</p>;
}
```

---

### Global Loader Errors

#### Error: `useGlobalLoader() must be used within a <GlobalLoaderProvider>.`
- **Cause**: This error occurs when the `useGlobalLoader` hook is invoked in a component not wrapped by a `GlobalLoaderProvider`.
- **Fix**: Make sure to wrap your component tree with the `GlobalLoaderProvider`.

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
    const { showLoader } = useGlobalLoader();
    
    const handleClick = async () => {
        showLoader(true);
        await fetchData();
        showLoader(false);
    };

    return <button onClick={handleClick}>Load Data</button>;
}
```

---

### Internationalization Errors

#### Error: `useTranslations() must be used within an <I18nProvider>.`
- **Cause**: This happens when `useTranslations` is invoked outside of an `I18nProvider`.
- **Fix**: Ensure that your components that need translations are inside the `I18nProvider`.

```typescript
import { I18nProvider, useTranslations } from 'blendsdk/react';

const fetchTranslations = async (locale: string) => {
    const res = await fetch(`/api/translations/${locale}`);
    return res.json();
};

function App() {
    return (
        <I18nProvider loader={fetchTranslations} defaultLocale="en">
            <MyComponent />
        </I18nProvider>
    );
}

function MyComponent() {
    const { t } = useTranslations();
    return <h1>{t('welcome.header')}</h1>;
}
```

---

### Common TypeScript Compilation Errors

#### Error: `Cannot find module 'blendsdk/react' or its corresponding type declarations.`
- **Cause**: This indicates that TypeScript cannot find the package in your `node_modules`, which may happen if it's not installed or if TypeScript is not configured properly.
- **Fix**: Ensure that `blendsdk/react` is installed. Run:

```bash
npm install blendsdk/react
```

Also, confirm that your TypeScript configuration (`tsconfig.json`) includes `"node_modules/@types"` in the `typeRoots`.

---

## Debugging Strategies

### Checking Context Availability
1. Ensure that you are importing `useAuth`, `useGlobalLoader`, or `useTranslations` as needed.
2. Confirm your components are wrapped within their respective providers (`AuthProvider`, `GlobalLoaderProvider`, `I18nProvider`).
3. If using custom hooks, check if they properly access context.

### Troubleshooting Missing Translations
1. Verify that the translation loader function is properly fetching the translations from the correct endpoint.
2. Check the network tab in your browser to ensure the fetch requests are successful and returning the expected data.
3. Log the translation keys and their outputs to ensure they return expected results.

### General Error Handling Practice
1. Wrap asynchronous operations with `try/catch` to log errors effectively and handle user notifications.
2. Utilize logging frameworks or console logs to gain insight into state changes or errors during the component lifecycle.

---

## Known Pitfalls

### Not Handling Asynchronous Code Properly
- When using async functions, always await their resolution. Forgetting to use `await` may lead to unexpected behavior.

### Improperly Configuring Providers
- Make sure to pass the required configuration props to the providers. E.g., the `AuthProvider` must receive a valid config object; otherwise, it may lead to undefined behavior.

### Assuming Context Will Automatically Update
- Hooks like `useAuth` or `useGlobalLoader` do not trigger updates unless their respective context providers state changes. Ensure to manage state updates correctly.

### Avoiding Side Effects in Render Cycles
- Do not invoke side effects, such as network requests directly in render methods. Use `useEffect` to manage such operations to avoid unwanted re-renders.

By following these guidelines and examples, you can effectively troubleshoot and resolve common issues that may arise while using the `blendsdk/react` package.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
