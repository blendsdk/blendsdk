# System Architecture

> **Package**: `@blendsdk/webafx`
> **Back to**: [README](../README.md)

## Overview

WebAFX is a structured Express.js framework that provides dependency injection, plugin architecture, controller-based routing, and production-ready middleware. This document explains the system architecture, component relationships, and request lifecycle.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      WebApplication                          │
│                                                              │
│  ┌──────────────────┐  ┌────────────────┐  ┌─────────────┐ │
│  │ ApplicationSettings│  │ PluginRegistry │  │ Controller  │ │
│  │ (Zod-validated)   │  │ (priority-     │  │  Registry   │ │
│  │                    │  │  ordered)      │  │             │ │
│  └──────────────────┘  └────────────────┘  └─────────────┘ │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              ServiceRegistry (owned)                   │   │
│  │  ┌──────────────────┐  ┌──────────────────────────┐  │   │
│  │  │   definitions    │  │      singletons          │  │   │
│  │  │  (blueprints)    │  │  (cached instances)      │  │   │
│  │  └──────────────────┘  └──────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         Express Application + HTTP Server              │   │
│  └──────────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────┤
│  Middleware Chain (in order):                                 │
│                                                              │
│  1. Trust Proxy          7. Security Headers (Helmet)        │
│  2. CORS                 8. Service Container (per-request)  │
│  3. Cookie Parser        9. Plugin Middleware                │
│  4. JSON Body Parser    10. Controller Routes                │
│  5. URL Body Parser     11. Health Check (/health)           │
│  6. Request ID + ALS    12. 404 Handler                      │
│                         13. Error Handler                    │
└──────────────────────────────────────────────────────────────┘
```

## Component Relationships

```
WebApplication
├── owns → ServiceRegistry { definitions, singletons }
├── owns → ApplicationSettings (Zod-validated config)
├── owns → PluginRegistry (priority-ordered plugins)
├── owns → ControllerRegistry (path → Controller mappings)
├── owns → ConsoleLogger (app-level logger)
├── owns → Express app + HTTP Server
└── creates → ServiceContainer (per-request, references shared registry)

ServiceContainer (per-request)
├── references → ServiceRegistry (shared, owned by WebApplication)
├── resolves → Singleton services (created once, cached in registry)
├── resolves → Per-request services (created per request with req/res/next)
├── provides → getUser(), getParams(), getInput(), get(), set()
└── attached to → req.services

BaseController
├── receives → ApplicationSettings (via constructor)
├── receives → ServiceContainer (app-level, via constructor)
├── defines → routes() → RouteDefinition[]
└── provides → ok(), created(), paginated(), noContent()

PluginDefinition
├── receives → { app: WebApplication, express: Express, logger: Logger }
└── returns → Plugin { health(), shutdown() }
```

## Request Lifecycle

Detailed flow of an HTTP request through WebAFX:

```
Client sends HTTP request
         │
         ▼
    ┌─────────┐
    │ Express  │
    └────┬────┘
         │
    ┌────▼─────────────────────┐
    │ 1. Trust Proxy           │  → Set req.ip from X-Forwarded-For
    │ 2. CORS                  │  → Handle preflight, set headers
    │ 3. Cookie Parser         │  → Parse cookies into req.cookies
    │ 4. JSON Body Parser      │  → Parse JSON body into req.body
    │ 5. URL Body Parser       │  → Parse form data into req.body
    │ 6. Request ID Middleware │  → Generate/validate UUID
    │    + AsyncLocalStorage    │  → Create request context { requestId, startTime }
    │ 7. Request Timing        │  → Log duration on response finish
    │ 8. Helmet                │  → Set security headers
    └────┬─────────────────────┘
         │
    ┌────▼─────────────────────┐
    │ 9. Service Container     │  → Create per-request ServiceContainer
    │    Middleware             │     with shared ServiceRegistry
    └────┬─────────────────────┘
         │
    ┌────▼─────────────────────┐
    │ 10. Plugin Middleware     │  → Run in priority order
    │     (auth, metrics, etc) │     e.g., JWT extraction → req.services.set('user', payload)
    └────┬─────────────────────┘
         │
    ┌────▼─────────────────────┐
    │ 11. Route Matching       │  → Express router finds matching route
    └────┬─────────────────────┘
         │
    ┌────▼─────────────────────┐
    │ 12. Route Middleware      │  → Per-route middleware (rate limit, etc.)
    └────┬─────────────────────┘
         │
    ┌────▼─────────────────────┐
    │ 13. wrapRouteHandler()   │
    │  a. Authentication       │  → If .secure(): check user service exists → 401
    │  b. Authorization        │  → If .authorize(fn): call fn(req, user) → 403
    │  c. Merge params         │  → Combine req.params + req.query + req.body
    │  d. Validation           │  → If .validate(schema): Zod parse → 422
    │  e. Store params         │  → req.services.set('request-params', validated)
    │  f. Store input          │  → req.services.set('request-input', { params, query, body })
    │  g. Call handler         │  → controller.handler(req, res, next)
    └────┬─────────────────────┘
         │
    ┌────▼─────────────────────┐
    │ 14. Controller Handler   │  → Business logic, response
    └────┬─────────────────────┘
         │
    ┌────▼─────────────────────┐  ← Only if error thrown
    │ 15. Error Handler        │  → Format ApiError → StandardErrorResponse
    │     Middleware            │     or unknown error → 500
    └────┬─────────────────────┘
         │
         ▼
    Response sent to client
```

## Startup Sequence

```
new WebApplication(config)
         │
         ▼
await app.start()
         │
    ┌────▼─────────────────────┐
    │ 1. loadConfiguration()   │  → Load .env.js, .env.local.js
    │ 2. runHooks('beforeStart')│  → User-defined pre-start hooks
    │ 3. setupCoreMiddleware()  │  → CORS, body parsers, request ID, Helmet
    │ 4. setupServiceContainer()│  → Per-request container middleware
    │ 5. setupPlugins()         │  → Install plugins in priority order
    │ 6. setupControllers()     │  → Register all controller routes
    │ 7. setupHealth()          │  → GET /health endpoint
    │ 8. setup404Handler()      │  → Catch-all for unmatched routes
    │ 9. setupErrorHandling()   │  → Error formatter middleware
    └────┬─────────────────────┘
         │
    ┌────▼─────────────────────┐
    │ 10. expressApp.listen()   │  → Start HTTP server
    │ 11. setupSignalHandlers() │  → SIGTERM, SIGINT handlers
    │ 12. runHooks('afterStart')│  → User-defined post-start hooks
    └────┬─────────────────────┘
         │
         ▼
    Server running, return shutdown function
```

## Shutdown Sequence

```
SIGTERM/SIGINT received (or manual shutdown() call)
         │
    ┌────▼──────────────────────────┐
    │ 1. runHooks('beforeShutdown') │
    │ 2. server.close()             │  → Stop accepting new connections
    │ 3. Wait for in-flight requests│  → With SHUTDOWN_TIMEOUT
    │ 4. services.disposeAll()      │  → Dispose singletons (parallel)
    │ 5. plugins.shutdown()         │  → Shutdown plugins (sequential)
    │ 6. runHooks('afterShutdown')  │
    │ 7. cleanupSignalHandlers()    │  → Remove process listeners
    └───────────────────────────────┘
```

## Service Registry Architecture

The service registry ensures isolation between WebApplication instances:

```
WebApplication Instance A              WebApplication Instance B
┌──────────────────────┐              ┌──────────────────────┐
│ ServiceRegistry A     │              │ ServiceRegistry B     │
│ ├─ definitions: {...} │              │ ├─ definitions: {...} │
│ └─ singletons: {...}  │              │ └─ singletons: {...}  │
└──────────┬───────────┘              └──────────┬───────────┘
           │                                      │
     ┌─────┴─────┐                          ┌─────┴─────┐
     │            │                          │            │
  Request 1   Request 2                  Request 3   Request 4
  Container   Container                  Container   Container
  (refs A)    (refs A)                   (refs B)    (refs B)
```

- Each `WebApplication` owns one `ServiceRegistry`
- Per-request `ServiceContainer` instances reference the shared registry
- Singletons are cached in the registry, shared across all requests
- Per-request services are created fresh for each request
- No global state — complete isolation for testing

## File Structure

```
packages/webafx/src/
├── index.ts                          # Package entry — re-exports all
├── application/
│   ├── index.ts                      # Application module exports
│   ├── web-application.ts            # Main WebApplication class
│   ├── application-settings.ts       # Configuration management
│   ├── base-controller.ts            # Controller base class
│   ├── route-builder.ts              # Fluent route definition API
│   ├── controller-registry.ts        # Controller registration
│   ├── service-container.ts          # DI container
│   ├── plugin.ts                     # Plugin interfaces & registry
│   ├── console-logger.ts             # Human-readable logger
│   ├── structured-logger.ts          # JSON logger for production
│   ├── rate-limiter.ts               # Rate limiting middleware
│   ├── request-id-middleware.ts       # UUID request ID + ALS
│   ├── request-context.ts            # AsyncLocalStorage context
│   ├── error-handler-middleware.ts    # Error formatting middleware
│   ├── services.ts                   # Deprecated utility
│   └── type.ts                       # Express augmentation + Logger interface
└── errors/
    ├── index.ts                      # Error module exports
    ├── api-error.ts                  # Base ApiError class
    ├── http-errors.ts                # Typed HTTP error classes
    └── types.ts                      # Error response interfaces
```

---

**Back to**: [README](../README.md) | **Prev**: [Testing](./TESTING.md)
