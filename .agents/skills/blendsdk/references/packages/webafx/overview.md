> **Package**: `blendsdk/webafx`

# webafx Overview

---

## What It Is

`blendsdk/webafx` is the web application framework of the BlendSDK suite: a structured, opinionated layer over Express 5 for building HTTP APIs and web backends with TypeScript. It replaces hand-wired Express middleware and ad-hoc project layout with first-class abstractions — controllers with a fluent route builder, a dependency-injection container, a priority-ordered plugin system, Zod-based request validation, typed HTTP errors with standardized JSON envelopes, built-in security middleware, and a fully managed application lifecycle (configuration loading → middleware setup → startup → graceful shutdown). A single `WebApplication` instance owns its Express app, HTTP server, configuration, service registry, plugin registry, and controller registry; there is no global state, so multiple applications can run — or be tested — in complete isolation. The package is ESM-only and requires Node.js 22 or later.

---

## Key Features

- **Managed lifecycle** — `app.start()` boots the server and returns a `shutdown()` function. SIGTERM/SIGINT are wired automatically with connection draining, service disposal, plugin shutdown, and lifecycle hooks (`beforeStart`, `afterStart`, `beforeShutdown`, `afterShutdown`).
- **Controller-based routing** — Extend `BaseController` and declare routes with the fluent `RouteBuilder`: `.get()`, `.post()`, `.put()`, `.patch()`, `.delete()`, `.middleware()`, `.secure()`, `.authorize()`, `.validate()`, `.openapi()`, `.handle()`.
- **Zod request validation** — Merged `params` + `query` + `body` is validated before the handler runs; failures produce a structured `422 ValidationError` with field-level details.
- **Dependency injection** — `ServiceContainer` supports `singleton` and `per-request` lifecycles, declared dependencies with ordering and cycle detection, typed `get<T>()` resolution, and `dispose` hooks invoked on shutdown.
- **Authentication & authorization** — `.secure()` / `.authenticated()` guards resolve a principal service (default `'user'`, or any custom principal such as `'client'`); `.authorize(fn)` runs per-route checks against the resolved principal.
- **Plugin system** — `app.use()` registers plugins with `priority`, a `factory({ app, express, logger })`, optional `health` and `shutdown` hooks, and a `terminal` phase for catch-all middleware (e.g., SPA fallback) that must not shadow controller routes.
- **Security defaults** — Helmet security headers, `X-Powered-By` removal, configurable CORS (static list or dynamic origin callback), UUID request IDs via `X-Request-ID`, and an in-memory rate limiter emitting `X-RateLimit-*` headers.
- **Standard response envelopes** — `this.ok()`, `this.created()`, `this.paginated()`, `this.noContent()` for success; typed errors (`BadRequestError`, `NotFoundError`, `ConflictError`, …) rendered as a uniform `StandardErrorResponse`.
- **Observability** — `ConsoleLogger` and JSON `StructuredLogger` behind a common `Logger` interface, four log levels (`ERROR | WARN | INFO | DEBUG`), request timing logs, and `AsyncLocalStorage`-based request context via `getRequestId()` / `getRequestContext()`.
- **Configuration** — Zod-validated `ApplicationSettings` with `.env.js` / `.env.local.js` loading, typed `get<T>()`, `getAll()`, `isProduction()`, and passthrough support for custom properties.
- **Static files & SPA** — `staticFilesPlugin()` serves directories at any URL prefix with cache control, dotfile policies, and optional SPA fallback for client-side routing frameworks.
- **Health checks** — The built-in `GET /health` endpoint aggregates plugin health results.

---

## When To Use

- **Structured REST APIs** — You want Express, but with enforced structure: controllers, dependency injection, validation, error conventions, and plugin extensibility instead of ad-hoc middleware wiring.
- **Production hardening out of the box** — You need security headers, CORS, rate limiting, request tracing, and graceful shutdown as built-in defaults rather than a hand-assembled stack.
- **Multiple caller types** — Your API serves more than one kind of client (e.g., browser sessions and machine clients) and needs per-route principal selection.
- **Plugin-driven architectures** — Cross-cutting concerns (auth, caching, metrics, logging, static hosting) should be packaged as reusable, priority-ordered plugins with health checks and ordered shutdown.
- **SPA + API in one process** — You host a React/Vue/Angular build and its API from a single server, with SPA fallback that never shadows API or health routes.
- **Testability-first teams** — Per-application registries and zero global state make parallel testing straightforward; `app.express` plugs directly into supertest.
- **BlendSDK ecosystems** — You plan to generate OpenAPI specs with `blendsdk/codegen` from route metadata, or consume other `blendsdk/*` packages.

**Constraints**: Node.js >= 22.0.0 and ESM only (no CommonJS consumption). For minimal scripts or non-Express stacks, plain Express or another framework may be a lighter fit.

---

## Architecture

### Core Components

| Component | Responsibility |
|-----------|----------------|
| `WebApplication` | Owns settings, registries, Express app, HTTP server, and lifecycle hooks; `start()` returns a shutdown function. |
| `ApplicationSettings` | Zod-validated configuration loaded from constructor config and `.env.js` / `.env.local.js` files; defaults to `ENV_MODE: 'production'` (secure by default). |
| `BaseController` + `RouteBuilder` | Controllers implement `routes(): RouteDefinition[]`; the builder produces typed route definitions. |
| `ServiceContainer` / `ServiceRegistry` | Dependency injection; the registry is owned by the application, a container is created per request and attached to `req.services`. |
| `PluginRegistry` | Installs plugins in priority order and collects `health`, `shutdown`, and `terminal` hooks. |
| `ControllerRegistry` | Maps base paths to controller classes and mounts their routes. |

### Request Pipeline

```text
HTTP request
     │
     ▼
Core middleware     trust proxy · CORS · cookies · body parsers ·
                    request ID + AsyncLocalStorage · timing · Helmet
     │
     ▼
Service container   per-request ServiceContainer attached as req.services
     │
     ▼
Plugin middleware   installed in priority order (lower priority first)
     │
     ▼
Route handling      route middleware → .secure() → .authorize() →
                    .validate() → handler
     │
     ▼
GET /health         aggregates plugin health checks
     │
     ▼
Plugin terminals    catch-all middleware AFTER controllers, BEFORE 404
                    (e.g., SPA index.html fallback)
     │
     ▼
404 handler  →  Error handler (ApiError → StandardErrorResponse,
                unknown errors → 500)
```

### Design Patterns

| Pattern | Where It Appears |
|---------|------------------|
| **Builder** | `RouteBuilder` — fluent chain from HTTP method to `handle()`. |
| **Template Method** | `BaseController.routes()` — abstract method every controller implements. |
| **Factory** | Plugin `factory({ app, express, logger })`, service factories, `staticFilesPlugin(config)`. |
| **Registry** | `ControllerRegistry`, `PluginRegistry`, `ServiceRegistry` — each owned by one application instance (no global state). |
| **Dependency Injection** | `ServiceContainer` — resolves singletons and per-request services, orders declared dependencies, detects cycles, disposes on shutdown. |
| **Strategy** | `Logger` implementations (`ConsoleLogger`, `StructuredLogger`, custom via `app.setLogger()`), CORS `origin` callbacks, rate limiter `keyExtractor`. |
| **Observer / Hooks** | `app.on('beforeStart' | 'afterStart' | 'beforeShutdown' | 'afterShutdown', fn)` with async hook support and chaining. |
| **Middleware Chain** | Express composition with a fixed, documented order; plugins, routes, and terminals inject at defined phases. |

---

## Dependencies

### Runtime Dependencies

| Package | Version | Kind | Purpose |
|---------|---------|------|---------|
| `express` | `^5.2.1` / peer `^5.0.0` | runtime + peer | HTTP server, routing, middleware composition |
| `zod` | `^4.4.3` / peer `^4.0.0` | runtime + peer | Config schema validation and route request validation |
| `cookie-parser` | `^1.4.7` | runtime | Cookie parsing middleware |
| `cors` | `^2.8.6` | runtime | CORS middleware |
| `helmet` | `^8.3.0` | runtime | Security headers middleware |

**Peer dependencies**: `express ^5.0.0` and `zod ^4.0.0` must be installed by the consuming application so a single Express/Zod instance is shared with WebAFX.

**Platform**: Node.js >= 22.0.0; ESM-only (`"type": "module"`). Internally `private: true` — distributed via the `blendsdk` umbrella package or workspace resolution.

### What Depends On It

- **`blendsdk/codegen`** — generates OpenAPI specifications from the `.openapi()` route metadata. WebAFX carries only the metadata; generation logic lives in codegen.
- **`blendsdk` umbrella package** — re-exports webafx alongside the rest of the SDK.
- **Logger/observability plugins** (e.g., `webafx-pino`) — replace the default logger at runtime via `app.setLogger()`.
- **Applications and the monorepo playground demo app** — consumed as the HTTP framework layer.

---

## Minimum Example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class GreetingController extends BaseController {
  routes() {
    return [
      this.route()
        .get('/greeting')
        .handle(async (_req: Request, res: Response) => {
          this.ok(res, { message: 'Hello from WebAFX' });
        }),
    ];
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api', GreetingController);

// start() boots the HTTP server and returns the shutdown function
const shutdown = await app.start();
// GET http://localhost:3000/api/greeting
//   → { "success": true, "data": { "message": "Hello from WebAFX" } }
// GET http://localhost:3000/health
//   → { "health": true, "timestamp": ... }
// Graceful shutdown runs automatically on SIGTERM/SIGINT; call shutdown() to stop programmatically.
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
