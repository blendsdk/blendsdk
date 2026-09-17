---
name: blendsdk
description: Use when building, extending, or debugging a BlendSDK TypeScript application (webafx, webafx-authz, authz, dbcore, postgresql, expression, blendscript, cmdline, codegen, i18n, react, or WebAFX plugins). Covers installation and scaffolding, public subpath imports, APIs, end-to-end patterns, and troubleshooting.
license: MIT
compatibility: Requires Node.js >= 22 and TypeScript >= 5.6; examples import the published `blendsdk` package through public subpaths.
metadata:
  author: TrueSoftware B.V.
---

# BlendSDK

BlendSDK is an enterprise-grade TypeScript SDK for web applications, database access,
caching, pub/sub, email, internationalization, code generation, and React front ends. It is
published as one umbrella package, `blendsdk`, and each capability is imported through a
public subpath such as `blendsdk/webafx` or `blendsdk/postgresql`.

Read this file first, then load only the references a task needs. Details live under
`references/`; the routing map is in `references/index.md`.

## Hard rules

1. **Import from public subpaths only.** Every import uses `blendsdk/<subpath>` (for example
   `blendsdk/webafx`). The monorepo's internal workspace package names are private and do not
   resolve for consumers.
2. **Never invent an API.** Verify every signature, option, and type name against
   `references/packages/<pkg>/api.md` before using it.
3. **Check the installed version first.** Run `npm ls blendsdk` (or read `package.json`) and
   confirm the version before assuming a signature. The references describe the current
   published line.
4. **Examples must be complete and typed.** Prefer the verified examples in the references
   over free-hand code. Keep TypeScript strict-mode types explicit.
5. **Use one import per subpath.** Do not deep-import internal file paths; only the documented
   subpaths are part of the public contract.

## Task routing

Start here, then open the listed reference.

| Task | Read |
|------|------|
| REST/CRUD API | `references/packages/webafx/overview.md`, `references/patterns/01-web-api-crud.md` |
| Authentication / JWT | `references/packages/webafx-auth/overview.md`, `references/patterns/02-authentication-jwt.md` |
| Authorization / roles & permissions | `references/packages/authz/overview.md`, `references/packages/webafx-authz/overview.md`, `references/packages/react/overview.md` |
| Caching / pub-sub | `references/packages/webafx-cache/overview.md`, `references/patterns/03-caching-patterns.md` |
| Database queries | `references/packages/postgresql/overview.md`, `references/packages/expression/overview.md`, `references/patterns/04-database-queries.md` |
| Email | `references/packages/webafx-mailer/overview.md`, `references/patterns/07-email-sending.md` |
| Internationalization | `references/packages/i18n/overview.md`, `references/packages/webafx-i18n/overview.md`, `references/patterns/08-internationalization.md` |
| Structured logging | `references/packages/webafx-pino/overview.md` |
| Code generation | `references/packages/codegen/overview.md`, `references/patterns/06-code-generation.md` |
| Typed API client | `references/packages/api-client/overview.md`, `references/packages/codegen/overview.md`, `references/patterns/10-client-sdk-generation.md` |
| CLI tools | `references/packages/cmdline/overview.md` |
| Business rules / expressions | `references/packages/blendscript/overview.md`, `references/packages/expression/overview.md` |
| React front end | `references/packages/react/overview.md` |
| Testing | `references/patterns/09-testing-patterns.md` |
| Plugins | `references/patterns/05-plugin-development.md` |
| Project setup / Docker / deploy | `references/guides/installation.md`, `references/guides/docker-setup.md`, `references/guides/production-deployment.md` |

The generated package index is `references/index.md`.

## Package map

| Package | Import | Description | Reference |
|---------|--------|-------------|-----------|
| stdlib | `blendsdk/stdlib` | Shared utility functions for TypeScript | `references/packages/stdlib/overview.md` |
| cmdline | `blendsdk/cmdline` | Command-line argument parser and option interpreter | `references/packages/cmdline/overview.md` |
| blendscript | `blendsdk/blendscript` | Small, safe expression language for business rules | `references/packages/blendscript/overview.md` |
| expression | `blendsdk/expression` | Type-safe SQL WHERE-clause builder with a fluent API | `references/packages/expression/overview.md` |
| dbcore | `blendsdk/dbcore` | Database abstractions and statement builders | `references/packages/dbcore/overview.md` |
| postgresql | `blendsdk/postgresql` | PostgreSQL connection and query implementation | `references/packages/postgresql/overview.md` |
| webafx | `blendsdk/webafx` | Web application framework built on Express | `references/packages/webafx/overview.md` |
| webafx-pino | `blendsdk/webafx-pino` | Structured Pino logging plugin for WebAFX | `references/packages/webafx-pino/overview.md` |
| webafx-cache | `blendsdk/webafx-cache` | Redis and in-memory caching and pub/sub plugin | `references/packages/webafx-cache/overview.md` |
| webafx-mailer | `blendsdk/webafx-mailer` | SMTP and in-memory email plugin | `references/packages/webafx-mailer/overview.md` |
| webafx-mailer-azure | `blendsdk/webafx-mailer-azure` | Microsoft Graph email provider for the mailer | `references/packages/webafx-mailer-azure/overview.md` |
| webafx-auth | `blendsdk/webafx-auth` | JWT, OAuth2, OIDC, and multi-tenant auth plugin | `references/packages/webafx-auth/overview.md` |
| authz | `blendsdk/authz` | Provider-agnostic roles, permissions, evaluation, and claim translation | `references/packages/authz/overview.md` |
| webafx-authz | `blendsdk/webafx-authz` | WebAFX route guards and provider claim translation glue | `references/packages/webafx-authz/overview.md` |
| i18n | `blendsdk/i18n` | Runtime-agnostic internationalization library | `references/packages/i18n/overview.md` |
| webafx-i18n | `blendsdk/webafx-i18n` | WebAFX i18n plugin with multi-source loading | `references/packages/webafx-i18n/overview.md` |
| codegen | `blendsdk/codegen` | Schema-driven type and code generation | `references/packages/codegen/overview.md` |
| api-client | `blendsdk/api-client` | Typed HTTP client runtime for generated API clients | `references/packages/api-client/overview.md` |
| react | `blendsdk/react` | React components and hooks for BlendSDK apps | `references/packages/react/overview.md` |

The `i18n` package also exposes a Node entry point, imported as `blendsdk/i18n-node`.

## Workflows

- **API service**: scaffold (below), register services with `dispose`, add controllers, then
  wire auth, caching, logging, and mail as plugins. See `references/patterns/01-web-api-crud.md`.
- **Database-backed feature**: define an expression, run it through the PostgreSQL adapter,
  and dispose the connection pool on shutdown. See `references/patterns/04-database-queries.md`.
- **Scheduled/CLI tooling**: parse arguments with `cmdline`, implement steps as services, and
  generate types with `codegen`. See `references/patterns/06-code-generation.md`.
- **Internationalized UI**: load catalogs through `i18n`, expose them to WebAFX requests with
  the `webafx-i18n` plugin, and render with `react`. See `references/patterns/08-internationalization.md`.
- **Typed client for an API**: annotate controller routes with `.openapi()`, declare a
  `blendsdk.api.ts` contract, then run `blendsdk api generate` and consume the typed client in
  the browser or a Node M2M job. See `references/patterns/10-client-sdk-generation.md`.

## Scaffolding

Project templates live in `assets/templates/`. Each is a complete starting point and uses the
placeholder `{{PROJECT_NAME}}`, which you replace with the target project name.

| Template | Use when |
|----------|----------|
| `assets/templates/01-minimal-api.md` | A single-controller API with validation and health checks |
| `assets/templates/02-full-api.md` | A full service with database, auth, caching, mail, and logging |
| `assets/templates/03-api-with-codegen.md` | A service that generates types from a database schema |
| `assets/templates/04-microservice.md` | A service-oriented project with shared conventions |
| `assets/templates/05-production-docker.md` | A containerized production deployment |
| `assets/templates/06-api-with-client-sdk.md` | An API plus a generated typed client that is checked in CI |

## Architecture

- `references/architecture.md` — monorepo layout, project structure, and design patterns.
- `references/dependency-graph.md` — generated package dependency graph.
