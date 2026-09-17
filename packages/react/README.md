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

## Requirements

- **React**: ^19.0.0
- **TypeScript**: ^5.6.0
- **Node.js**: >= 22.0.0

## License

MIT © TrueSoftware B.V.
