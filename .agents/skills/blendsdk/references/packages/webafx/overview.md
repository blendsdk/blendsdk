> **Package**: `blendsdk/webafx`

# webafx Overview

## What It Is

`blendsdk/webafx` (WebAFX) is a production-oriented web application framework built on Express 5 for the BlendSDK ecosystem. It adds opinionated structure on top of Express without hiding it: a `WebApplication` class that orchestrates the entire server lifecycle, controller-based routing with a fluent `RouteBuilder`, dependency injection with singleton and per-request service lifecycles, a priority-ordered plugin system, Zod-based configuration and request validation, standardized JSON success/error envelopes, built-in security middleware (Helmet headers, CORS, CSRF, rate limiting, UUID request IDs), structured logging, and graceful shutdown with connection draining. WebAFX is ESM-only, written in strict TypeScript for Node.js >= 22, and is consumed as part of the `blendsdk` umbrella package rather than installed as a standalone scoped package.

---

## Key Features

- **Full application lifecycle** — `new WebApplication(config)` followed by `await app.start()` handles configuration loading, core middleware, plugin installation, controller registration, the `/health` endpoint, 404 and error handling, and returns a `shutdown()` function. SIGTERM/SIGINT trigger graceful shutdown with connection draining and a configurable timeout.
- **Controller-based routing** — Extend `BaseController`, implement `routes()`, and define endpoints with the fluent `RouteBuilder`: `get/post/put/patch/delete` → `secure()` → `authorize()` → `middleware()` → `validate()` → `openapi()` → `handle()`. Response helpers (`ok`, `created`, `paginated`, `noContent`) keep responses consistent.
- **Dependency injection** — `ServiceContainer` supports two lifecycles: `singleton` (created once, shared across requests, optionally disposable) and `per-request` (created fresh with `req`/`res`/`next`). Services declare `dependencies`, circular dependencies are detected at resolution time, and `dispose()` callbacks run during shutdown. Each `WebApplication` owns its own registry — no global state, safe for parallel test apps.
- **Plugin system** — `PluginDefinition` objects install in ascending `priority` order, can add middleware, register services, and return a `Plugin` with `health()` (aggregated into `GET /health`) and `shutdown()` hooks. An optional `terminal()` hook mounts catch-all middleware *after* controllers so fallbacks never shadow routes.
- **Zod request validation** — `.validate(schema)` parses merged `params` + `query` + `body` before the handler runs; failures become `422 VALIDATION_ERROR` responses with field-level details. Handlers can read merged data via `req.services.getParams()` or separated sources via `req.services.getInput()`.
- **Standardized responses and typed errors** — A single `StandardErrorResponse` envelope (`code`, `message`, `statusCode`, `timestamp`, `requestId`, `path`, optional `details`/`stack`) plus nine HTTP error classes from `BadRequestError` (400) to `ServiceUnavailableError` (503), all extending `ApiError`.
- **Security** — Helmet security headers, configurable CORS (string, array, or callback origin), CSRF middleware and plugin with constant-time token comparison, in-memory rate limiting with `X-RateLimit-*` headers, and UUID request IDs (validated against upstream values) propagated through `AsyncLocalStorage`.
- **Logging** — `ConsoleLogger` (human-readable) and `StructuredLogger` (JSON for log aggregation), both implementing the async `Logger` interface; `app.setLogger()` lets logger plugins replace the default.
- **Static files and SPA hosting** — `staticFilesPlugin()` wraps `express.static` with typed options (`root`, `prefix`, `maxAge`, `immutable`, `dotfiles`, `spa`) and serves `index.html` for unmatched client-side routes without swallowing API routes or `/health`.
- **Configuration and lifecycle hooks** — Zod-validated `ApplicationConfig` (`PORT`, `ENV_MODE`, `LOG_LEVEL`, `DEBUG`, `TRUST_PROXY`, `BODY_LIMIT`, `SHUTDOWN_TIMEOUT`, `CORS` plus passthrough custom properties), loaded from the constructor and `.env.js` / `.env.local.js` files, with `beforeStart`, `afterStart`, `beforeShutdown`, and `afterShutdown` hooks.
- **OpenAPI metadata** — Routes opt in to `.openapi({...})` metadata (summary, tags, path params, responses, response envelope). WebAFX stores pure data only; spec generation happens in `blendsdk/codegen`.

---

## When To Use

Choose WebAFX when you are building a Node.js/TypeScript server and want Express with structure:

- **REST/JSON APIs** that need controllers, request validation, consistent response envelopes, and typed errors without hand-rolling boilerplate.
- **Applications with real service lifecycles** — a database pool as a `singleton` with `dispose`, per-request auth context as `per-request` services, dependencies resolved by the container.
- **Multi-credential systems** — routes choose which service holds the authenticated principal: `secure()` uses the default `user` service, while `secure('client')` authenticates machine clients against a different one.
- **Production deployments** that expect security headers, CORS, CSRF protection, rate limiting, request correlation IDs, health checks, and connection-draining shutdown out of the box.
- **Extensible platforms** — package auth, caching, metrics, or static hosting as plugins with deterministic install order and cleanup semantics.
- **Single-process SPA + API hosting** — serve a React/Vue/Angular build and API routes from the same application.

Prefer plain Express (or another framework) when:

- You only need one or two trivial routes and the structure costs more than it saves.
- You are not using Express or Zod — WebAFX requires both.
- You need non-ESM module systems — WebAFX is ESM-only and targets Node.js >= 22.

---

## Architecture

WebAFX is a facade over Express: `WebApplication` owns every registry and wires them together, while `app.express` remains available as an escape hatch to the underlying Express instance.

```
WebApplication  (one instance per application; owns all registries)
│
├── ApplicationSettings   Zod-validated config; constructor + .env.js / .env.local.js
├── ServiceRegistry       { definitions, singletons } ─── shared by every request
├── PluginRegistry        priority-ordered plugin definitions + terminal hooks
├── ControllerRegistry    basePath → Controller class
├── Logger                ConsoleLogger by default; replaceable via setLogger()
└── Express app + HTTP server

Request ──▶ [trust proxy] ──▶ [CORS] ──▶ [cookie parser] ──▶ [body parsers]
         ──▶ [request ID + AsyncLocalStorage] ──▶ [request timing] ──▶ [Helmet]
         ──▶ [per-request ServiceContainer → req.services]
         ──▶ [plugin middleware, priority asc] ──▶ [controller routes]
         ──▶ [/health] ──▶ [plugin terminal phase (catch-all, e.g. SPA fallback)]
         ──▶ [404 handler] ──▶ [error handler]

Route wrapper pipeline (per matched route):
  [route middleware] ──▶ [authentication: secure() → 401]
  ──▶ [authorization: authorize() → 403] ──▶ [validation: Zod → 422]
  ──▶ [store request-params / request-input] ──▶ [handler]
  ──▶ (any throw) ──▶ [error handler] ──▶ StandardErrorResponse
```

Startup order inside `app.start()`:

1. Load `.env.js` and `.env.local.js` configuration
2. Run `beforeStart` hooks
3. Core middleware (trust proxy, CORS, cookie parser, body parsers, request ID, timing, Helmet)
4. Per-request `ServiceContainer` middleware (attaches `req.services`)
5. Install plugins in priority order
6. Register controller routes
7. Register `GET /health`
8. Run plugin terminal hooks (catch-all middleware, e.g. SPA fallback)
9. Register the 404 handler and error handler
10. Listen on the port, install SIGTERM/SIGINT handlers, run `afterStart` hooks

Key design patterns:

| Pattern | Where it appears |
|---------|------------------|
| Registry | `ControllerRegistry`, `PluginRegistry`, `ServiceRegistry` |
| Builder | `RouteBuilder` fluent route DSL |
| Factory | `ServiceDefinition.factory`, `PluginDefinition.factory` |
| Template method | `BaseController.routes()` abstract contract |
| Dependency injection / service locator | `ServiceContainer` resolved per request via `req.services` |
| Strategy | `Logger` implementations (Console/Structured), CORS `origin` callback |
| Chain of responsibility | Express middleware, plugin pipeline, terminal phase |
| Adapter / facade | `WebApplication` over Express; `app.express` escape hatch |

---

## Dependencies

Runtime dependencies (resolved by the umbrella package):

| Package | Version | Purpose |
|---------|---------|---------|
| `express` | `^5.2.1` | The HTTP framework WebAFX is built on |
| `zod` | `^4.4.3` | Configuration schema and request validation |
| `cors` | `^2.8.6` | CORS middleware |
| `cookie-parser` | `^1.4.7` | Cookie parsing |
| `helmet` | `^8.3.0` | Security headers |

Peer dependencies (the application must provide them):

| Package | Version range |
|---------|---------------|
| `express` | `^5.0.0` |
| `zod` | `^4.4.3` |

Install the umbrella package together with the peer dependencies:

```bash
npm install blendsdk express zod
```

- **BlendSDK packages**: WebAFX depends on no other `blendsdk/*` package at runtime.
- **What depends on it**:
  - `blendsdk/codegen` — consumes the `.openapi()` route metadata that WebAFX records; spec generation logic lives entirely in codegen.
  - Logger plugins (for example `webafx-pino`) — plug in by calling `app.setLogger()` from a plugin factory.
  - Applications built on the BlendSDK stack, such as the playground demo app.
- **Environment**: Node.js >= 22.0.0, ESM only (`"type": "module"`). Development and testing use TypeScript, Vitest, and supertest.

---

## Minimum Example

```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import type { Request, Response } from 'express';

class HelloController extends BaseController {
  routes() {
    return [this.route().get('/').handle(this.hello)];
  }

  private async hello(_req: Request, res: Response): Promise<void> {
    this.ok(res, { message: 'Hello, World!' });
  }
}

const app = new WebApplication({ PORT: 3000, ENV_MODE: 'development' });
app.registerController('/api/hello', HelloController);

const shutdown = await app.start(); // Server listening on http://localhost:3000
// GET /api/hello → 200 { "success": true, "data": { "message": "Hello, World!" } }
// await shutdown(); stops the server gracefully — SIGTERM/SIGINT do this automatically
```

`app.start()` begins listening and returns a `shutdown()` function that drains connections, disposes singleton services, and shuts down plugins. The response body follows the standard success envelope `{ success: true, data: ... }` used by every `BaseController` response helper.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
