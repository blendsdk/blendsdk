# Static Files & SPA

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

The `staticFilesPlugin()` provides typed, declarative static file serving and SPA (Single Page Application) fallback support as a WebAFX plugin. It wraps Express's built-in `express.static()` middleware with a clean configuration interface and optional client-side routing support.

**Key features**:
- ✅ Serve static files from any directory
- ✅ SPA fallback — serve `index.html` for client-side routes (React, Vue, Angular)
- ✅ URL prefix mounting — serve at `/`, `/static`, `/assets`, etc.
- ✅ Cache control — `maxAge`, `immutable` for production builds
- ✅ Multiple instances — serve different directories at different prefixes
- ✅ Path validation — fails fast if directory doesn't exist
- ✅ Zero dependencies — uses Express's built-in static middleware

## Quick Start

```typescript
import { WebApplication, staticFilesPlugin } from '@blendsdk/webafx';

const app = new WebApplication({ PORT: 3000 });

// Serve files from ./public
app.use(staticFilesPlugin({ root: './public' }));

await app.start();
// GET /image.png → ./public/image.png
// GET /css/style.css → ./public/css/style.css
```

## SPA Mode (React, Vue, Angular)

Enable `spa: true` to serve `index.html` for unmatched client-side routes. This lets frameworks like React Router handle navigation on the client.

```typescript
import { WebApplication, staticFilesPlugin, BaseController } from '@blendsdk/webafx';

class ApiController extends BaseController {
    routes() {
        return [
            this.route().get('/users').handle(this.getUsers),
        ];
    }
    async getUsers(req, res) {
        res.json({ users: [{ id: 1, name: 'Alice' }] });
    }
}

const app = new WebApplication({ PORT: 3000 });

// Serve React build with SPA fallback
app.use(staticFilesPlugin({
    root: './client/build',
    spa: true,
}));

// API routes still work normally
app.registerController('/api', ApiController);

await app.start();
```

**How requests are handled**:

| Request | Result |
|---------|--------|
| `GET /api/users` | → `{ users: [...] }` (API route) |
| `GET /` | → `./client/build/index.html` (index) |
| `GET /about` | → `./client/build/index.html` (SPA fallback) |
| `GET /settings/profile` | → `./client/build/index.html` (SPA fallback) |
| `GET /static/js/main.abc123.js` | → actual file (bundled JS) |
| `GET /missing.css` | → 404 (file extension = real file, not a route) |
| `POST /api/users` | → API route (non-GET skips SPA) |

### SPA Fallback Rules

The SPA fallback middleware applies three guards to decide whether to serve `index.html`:

1. **Method guard** — Only GET requests. POST, PUT, DELETE always pass through to routes.
2. **File extension guard** — Paths with extensions (`.css`, `.js`, `.png`) are treated as missing files, not client routes.
3. **Accept header guard** — Only serves HTML to clients that accept `text/html`. JSON API requests (`Accept: application/json`) pass through normally.

## Configuration Reference

```typescript
interface StaticFilesConfig {
    root: string;                           // Directory to serve (required)
    prefix?: string;                        // URL prefix (default: '/')
    maxAge?: string | number;               // Cache-Control max-age (default: 0)
    immutable?: boolean;                    // Cache-Control immutable (default: false)
    dotfiles?: 'ignore' | 'allow' | 'deny'; // Dotfile handling (default: 'ignore')
    index?: string | false;                 // Index file (default: 'index.html')
    etag?: boolean;                         // ETag header (default: true)
    lastModified?: boolean;                 // Last-Modified header (default: true)
    spa?: boolean;                          // SPA fallback mode (default: false)
    priority?: number;                      // Plugin priority (default: 20)
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `root` | `string` | *required* | Directory to serve files from. Resolved relative to `process.cwd()`. |
| `prefix` | `string` | `'/'` | URL prefix to mount at. |
| `maxAge` | `string \| number` | `0` | Cache-Control max-age. Accepts `'1d'`, `'1h'`, `86400000`. |
| `immutable` | `boolean` | `false` | Add `immutable` to Cache-Control. Use with hashed filenames. |
| `dotfiles` | `string` | `'ignore'` | How to handle dotfiles: `'ignore'` (404), `'allow'`, or `'deny'` (403). |
| `index` | `string \| false` | `'index.html'` | Directory index file. `false` disables it. |
| `etag` | `boolean` | `true` | Generate ETag headers. |
| `lastModified` | `boolean` | `true` | Set Last-Modified header. |
| `spa` | `boolean` | `false` | Enable SPA fallback (serve index.html for unmatched routes). |
| `priority` | `number` | `20` | Plugin installation priority. Lower = installs first. |

## Production Setup

### Hashed Assets with Permanent Caching

Modern build tools (Vite, webpack, Create React App) generate hashed filenames like `main.abc123.js`. These can be cached forever because the hash changes when content changes.

```typescript
const app = new WebApplication({ PORT: 3000 });

// SPA root — short cache (HTML may change on deploy)
app.use(staticFilesPlugin({
    root: './client/build',
    spa: true,
    maxAge: '10m',
}));

// Hashed assets — permanent cache
app.use(staticFilesPlugin({
    root: './client/build/static',
    prefix: '/static',
    maxAge: '1y',
    immutable: true,
}));
```

### Multiple Static Directories

Serve different content at different URL paths:

```typescript
const app = new WebApplication({ PORT: 3000 });

// Public files at root
app.use(staticFilesPlugin({ root: './public' }));

// User uploads at /uploads
app.use(staticFilesPlugin({ root: './uploads', prefix: '/uploads' }));

// Documentation site at /docs with its own SPA routing
app.use(staticFilesPlugin({
    root: './docs-site/build',
    prefix: '/docs',
    spa: true,
}));
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Root directory doesn't exist | Throws during `app.start()` — fails fast with clear message |
| File not found (no SPA) | Falls through to 404 handler |
| File not found (SPA, has extension) | Falls through to 404 handler |
| File not found (SPA, no extension) | Serves `index.html` via SPA fallback |
| `index.html` missing in SPA mode | Express sendFile error → error handler |
| Dotfile requested | Controlled by `dotfiles` option (default: ignored = 404) |

## Plugin Details

The plugin integrates with WebAFX's plugin system:

- **Name**: `'static-files'` (or `'static-files:/prefix'` when a prefix is set)
- **Priority**: 20 (installs with other plugins, before controllers and 404 handler)
- **Health check**: None (static serving is stateless)
- **Shutdown**: None (no resources to clean up)

---

**Back to**: [README](../README.md) | **See also**: [Plugins](./PLUGINS.md) | [Middleware](./MIDDLEWARE.md)
