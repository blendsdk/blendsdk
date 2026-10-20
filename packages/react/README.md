# @blendsdk/react

> React component and hook library for BlendSDK applications

## Overview

`@blendsdk/react` provides reusable React components and hooks designed for enterprise BlendSDK applications. Built with React 19+, TypeScript strict mode, and zero runtime dependencies beyond React.

## GlobalLoader

A full-screen overlay with a CSS-only spinner animation, controllable from anywhere in the component tree via a Context + Provider + Hook pattern.

### Features

- 🔄 **CSS-only spinner** — Pure CSS conic-gradient animation, no images or JS animation libraries
- 🎨 **Fully configurable** — Spinner color, background, size, z-index, and custom text component
- 📜 **Optional text message** — Display a message below the spinner with any React component
- 🔒 **Body scroll lock** — Prevents background scrolling while the loader is visible
- 🛡️ **Type-safe** — Full TypeScript types exported for all configuration and hook return values
- 💉 **Runtime CSS injection** — No CSS file imports needed; styles are injected via `<style>` tag
- ⚡ **Zero dependencies** — Only React as a peer dependency

### Quick Start

```tsx
import { GlobalLoaderProvider, useGlobalLoader } from "@blendsdk/react";

// 1. Wrap your application with the provider
function App() {
  return (
    <GlobalLoaderProvider config={{ spinnerColor: "#25b09b" }}>
      <MyPage />
    </GlobalLoaderProvider>
  );
}

// 2. Use the hook anywhere inside the provider
function MyPage() {
  const { showLoader, setText } = useGlobalLoader();

  const handleLoadData = async () => {
    setText("Loading data…");
    showLoader(true);
    await fetchData();
    showLoader(false); // hides overlay and clears text automatically
  };

  return <button onClick={handleLoadData}>Load Data</button>;
}
```

### Configuration

All configuration is optional — sensible defaults are provided.

```tsx
import type { GlobalLoaderConfig } from "@blendsdk/react";

const config: GlobalLoaderConfig = {
  spinnerColor: "#25b09b",       // default: "#e6e6e6"
  backgroundColor: "#ffffff",    // default: "#fafafa"
  spinnerSize: 60,               // default: 50 (pixels)
  zIndex: 100000,                // default: 999999
  textComponent: ({ text }) => ( // default: <p> with color:#666, fontSize:14
    <span style={{ marginTop: 16, fontWeight: "bold" }}>{text}</span>
  ),
};

<GlobalLoaderProvider config={config}>
  <App />
</GlobalLoaderProvider>
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `spinnerColor` | `string` | `"#e6e6e6"` | CSS color for the spinner arc |
| `backgroundColor` | `string` | `"#fafafa"` | Background color of the full-screen overlay |
| `spinnerSize` | `number` | `50` | Spinner diameter in pixels |
| `zIndex` | `number` | `999999` | CSS z-index for the overlay |
| `textComponent` | `(props: { text: string }) => ReactElement` | Built-in `<p>` | Custom render function for the text below the spinner |

> **Note:** Configuration is captured on mount and is NOT reactive. To change config, remount the provider.

### Hook API

```tsx
const { showLoader, setText, visible } = useGlobalLoader();
```

| Property | Type | Description |
|----------|------|-------------|
| `showLoader` | `(visible: boolean) => void` | Show (`true`) or hide (`false`) the overlay. Hiding automatically clears text. |
| `setText` | `(text: string \| null) => void` | Set the message below the spinner. Pass `null` or `""` to clear. |
| `visible` | `boolean` | Current visibility state (read-only). |

### Custom Text Component

The `textComponent` prop lets you use any React component for the text — including FluentUI, Material UI, or your own styled component:

```tsx
import { Text } from "@fluentui/react-components";

<GlobalLoaderProvider
  config={{
    textComponent: ({ text }) => (
      <Text size={400} weight="semibold" style={{ marginTop: 16 }}>
        {text}
      </Text>
    ),
  }}
>
  <App />
</GlobalLoaderProvider>
```

### Error Handling

- **Hook outside provider** — `useGlobalLoader()` throws if called outside a `<GlobalLoaderProvider>`
- **Nested providers** — `<GlobalLoaderProvider>` throws if nested inside another provider

### Exported Types

```typescript
import type {
  GlobalLoaderConfig,
  GlobalLoaderContextValue,
  GlobalLoaderProviderProps,
} from "@blendsdk/react";
```

## I18n (Internationalization)

A React Context + Provider + Hook for loading translations asynchronously, switching locales at runtime, and providing a `t()` function to the entire component tree. Powered by `Translator` from `@blendsdk/i18n`.

### Features

- 🌍 **Async translation loading** — Load translations from any source via a user-supplied `loader` function
- 🔄 **Runtime locale switching** — `setLocale()` triggers automatic re-fetch and updates the entire tree
- 📝 **Interpolation & plurals** — `t('greeting', { name: 'Alice' })` and `t('book', { count: 5 })` via `@blendsdk/i18n`
- ⏳ **GlobalLoader integration** — Shows the full-screen loader overlay during initial load and locale switches
- 🛡️ **Type-safe** — Full TypeScript types exported for all props, hook return values, and loader signature
- 🔒 **Nesting detection** — Throws if `<I18nProvider>` is nested inside another
- 📦 **Missing key handling** — Returns key as-is + optional `onMissingTranslation` callback

### Quick Start

```tsx
import {
  GlobalLoaderProvider,
  I18nProvider,
  useTranslations,
} from "@blendsdk/react";

// 1. Define your translation loader
const loadTranslations = async (locale: string) => {
  const res = await fetch(`/api/translations/${locale}`);
  return res.json(); // { "greeting": "Hello ${name}", "farewell": "Goodbye" }
};

// 2. Wrap your app (I18nProvider must be inside GlobalLoaderProvider)
function App() {
  return (
    <GlobalLoaderProvider>
      <I18nProvider loader={loadTranslations} defaultLocale="en">
        <MyPage />
      </I18nProvider>
    </GlobalLoaderProvider>
  );
}

// 3. Use translations anywhere inside the provider
function MyPage() {
  const { t, locale, setLocale } = useTranslations();

  return (
    <div>
      <h1>{t("greeting", { name: "Alice" })}</h1>
      <p>{t("farewell")}</p>
      <p>Current locale: {locale}</p>
      <button onClick={() => setLocale("nl")}>Switch to Dutch</button>
    </div>
  );
}
```

### Provider Props

```tsx
import type { I18nProviderProps } from "@blendsdk/react";
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `loader` | `(locale: string) => Promise<Record<string, TranslationValue>>` | **(required)** | Async function that loads translations for a given locale |
| `defaultLocale` | `string` | `"en"` | Locale to load on mount |
| `onMissingTranslation` | `(key: string, locale: string) => void` | `undefined` | Called when `t()` encounters an unknown key |
| `children` | `ReactNode` | **(required)** | Application subtree |

### Hook API

```tsx
const { t, locale, setLocale, ready } = useTranslations();
```

| Property | Type | Description |
|----------|------|-------------|
| `t` | `(key: string, params?: Record<string, unknown>) => string` | Translate a key with optional interpolation/plurals. Returns the key as-is if not found. |
| `locale` | `string` | Current active locale |
| `setLocale` | `(locale: string) => void` | Switch locale — triggers re-fetch via loader, shows GlobalLoader during fetch |
| `ready` | `boolean` | `true` after translations have loaded successfully |

### Component Tree

```tsx
<GlobalLoaderProvider>          {/* Required — provides loading overlay */}
  <I18nProvider                 {/* Loads translations, provides t() */}
    loader={loadTranslations}
    defaultLocale="en"
    onMissingTranslation={(key, locale) => console.warn(`Missing: ${key}`)}
  >
    <App />                     {/* useTranslations() available here */}
  </I18nProvider>
</GlobalLoaderProvider>
```

### Error Handling

- **Hook outside provider** — `useTranslations()` throws if called outside an `<I18nProvider>`
- **Nested providers** — `<I18nProvider>` throws if nested inside another `<I18nProvider>`
- **Loader failure on mount** — `ready` stays `false`, error logged to console, `t()` returns keys as-is
- **Loader failure on locale switch** — Previous locale preserved, error logged to console
- **No GlobalLoaderProvider** — Error propagated from `useGlobalLoader()`

### Exported Types

```typescript
import type {
  I18nProviderProps,
  I18nContextValue,
  TranslateFunction,
  TranslationLoader,
} from "@blendsdk/react";
```

---

## Utility Hooks

### `useObjectState`

A local-state hook for object-shaped component state. It keeps one state object per component and
updates individual fields with a partial patch, so a form with many fields does not need one
`useState` per field.

Use it when a component owns a plain object with several related fields. For a single value,
`useState` is simpler. The hook manages local component state only; it is not a store and does not
share state between components.

#### Quick Start

```tsx
import { useObjectState } from "@blendsdk/react";

interface FormState {
  name: string;
  age: number;
}

function ProfileForm() {
  const [state, setState, reset] = useObjectState<FormState>(() => ({
    name: "",
    age: 0,
  }));

  return (
    <form>
      <input
        value={state.name}
        onChange={(event) => setState({ name: event.target.value })}
      />
      <input
        type="number"
        value={state.age}
        onChange={(event) => setState({ age: Number(event.target.value) })}
      />
      <button type="button" onClick={reset}>
        Reset
      </button>
    </form>
  );
}
```

#### Hook API

```tsx
const [state, setState, reset] = useObjectState(create);
```

| Element | Type | Description |
|---------|------|-------------|
| `state` | `T` | Current state object |
| `setState` | `(update: Partial<T> \| ((previous: T) => Partial<T>)) => void` | Shallow-merges a partial patch into the latest state. The callback form receives the latest state |
| `reset` | `() => void` | Calls the original factory again and stores a fresh object |

#### Behavior

- **Lazy initialization** — the factory runs on mount, not on every render.
- **Shallow merge** — unchanged fields are preserved; nested objects are replaced, not deep-merged.
- **Stable callbacks** — `setState` and `reset` keep the same identity across renders.
- **Fresh reset** — `reset` builds a new object from the factory; it does not reuse the initial reference.
- **Plain objects only** — arrays, class instances, and function values are outside the contract and are not runtime-guarded.
- **No key deletion** — setting a field to `undefined` leaves the key present.
- **Pure factory** — React may call the factory twice in development StrictMode, and `reset` calls it again.
- **New object per call** — the factory must return a new plain object on every call; the hook stores that object as-is. A factory that returns a shared object makes the reset baseline mutable.
- **Mount-time reset** — reset keeps using the factory captured on mount, even if a later render passes a different function.

#### Migrating from v3

The v3 setter and reset were recreated on every render. The v5 callbacks are stable. If a callback
listed `setState` in its dependency array but read `state` without listing the fields it reads, add
those fields to the dependency array or use the functional updater:

```tsx
setState((previous) => ({ age: previous.age + 1 }));
```

Do not rely on the setter changing identity to trigger effects or callbacks.

#### Exported Types

```typescript
import type {
  ObjectStateReset,
  ObjectStateSetter,
  UseObjectStateResult,
} from "@blendsdk/react";
```

---

## Requirements

- **React**: ^19.0.0
- **TypeScript**: ^5.6.0
- **Node.js**: >= 22.0.0

## License

MIT © TrueSoftware B.V.
