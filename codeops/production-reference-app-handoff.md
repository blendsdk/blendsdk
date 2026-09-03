# Production Reference Application — Worktree Hand-off

> **Status**: Discovery hand-off; requirements and implementation plan have not been approved
> **Repository**: `TrueSoftwareNL/blendsdk`
> **GitHub issue**: [#102 — feat: build a production reference application](https://github.com/TrueSoftwareNL/blendsdk/issues/102)
> **Integration branch**: `v5`
> **Baseline commit**: `42ccdd63802e4c2f424ec3dbc406a6d423813751`
> **Prepared**: 2026-08-30

## 1. Purpose of this hand-off

This document transfers the investigation and proposed direction for BlendSDK's highest-priority
framework initiative: a production reference application that proves the public SDK works as one
cohesive framework.

It is deliberately not a requirements document or implementation plan. The previous session was
about to begin CodeOps requirements discovery when the worktree hand-off was requested. No feature
name, behavioral scope, acceptance criteria, or architecture choice passed the Zero-Ambiguity Gate.
The next session must therefore treat the recommendations below as informed proposals, not as
authorized decisions.

## 2. Handoff state

| Item                                  | State                                                     |
| ------------------------------------- | --------------------------------------------------------- |
| Working name                          | `production-reference-app` — proposed, not user-confirmed |
| CodeOps feature directory             | Not created                                               |
| Requirements documents                | Not created                                               |
| Ambiguity register                    | Not created                                               |
| Implementation plan                   | Not created                                               |
| Application code                      | Not changed                                               |
| Tests                                 | Not changed or run for this initiative                    |
| GitHub backlog before this hand-off   | No matching open or closed issue found                    |
| Repository state before this hand-off | `v5` matched `origin/v5`; clean at the baseline commit    |

The repository uses nested CodeOps layout (`codeops/.codeops.yml`) and strict quality policy
(`codeops/codeops.json`). A cohesive capability must follow:

1. Confirm the feature slug.
2. Run requirements discovery and pass its Zero-Ambiguity Gate.
3. Create and quality-check the implementation plan.
4. Execute specification-first.
5. Run the strict independent reviewer and auditor quality loop.
6. Sync the feature and portfolio roadmaps.

## 3. Strategic objective

BlendSDK already has substantial framework breadth: WebAFX lifecycle and dependency injection,
PostgreSQL data access and migrations, authentication, cache/pub-sub, structured logging, Zod-based
validation and OpenAPI metadata, mail, internationalization, React support, code generation, and an
assembled public `blendsdk` package.

The next strategic need is proof of composition rather than another module. A production reference
application should demonstrate that a consumer can install the public package, combine the major
backend capabilities safely, operate the application, and verify it through repeatable black-box
tests. It should become the framework's executable golden path and later serve as the behavioral
source for priority 2, the `blendsdk create` scaffolder.

### Intended outcome

A developer should be able to use one maintained example to answer:

- How is a BlendSDK service structured?
- Which package/import surface is public and supported?
- How are configuration and secrets validated?
- How are services, plugins, controllers, and lifecycle hooks composed?
- How are PostgreSQL migrations created, validated, and applied?
- How are authentication and authorization enforced?
- How are caching, structured logs, request IDs, and health signals wired?
- How are request and response contracts validated and documented?
- How is the service tested against real PostgreSQL and Redis dependencies?
- How is startup failure and graceful shutdown handled?

## 4. Repository facts and evidence

### 4.1 Toolchain and delivery constraints

| Fact                                       | Evidence                                 | Consequence                                                              |
| ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------ |
| Yarn 1 monorepo                            | `package.json:7-15`                      | Use Yarn `1.22.x`; preserve `yarn.lock`                                  |
| Node 22+                                   | `package.json:7-11`                      | Reference documentation and containers must not advertise Node 18        |
| Turborepo task graph                       | `turbo.json:5-48`                        | New workspace tasks must participate in build/test dependencies          |
| Integration branch is `v5`                 | `codeops/.codeops.yml:5`                 | Branch the new worktree from `origin/v5`                                 |
| Strict CodeOps review                      | `codeops/codeops.json:2-8`               | Major review findings block execution until ruled on                     |
| CI builds, separates DB suites, then packs | `.github/workflows/ci.yml:26-68`         | Verification must cover build, Docker-backed tests, and package assembly |
| Public package is `blendsdk`               | `packages/blendsdk/package.json:1-12`    | Golden-path imports should exercise `blendsdk/<subpath>`                 |
| Package assembly has no direct tests       | no test files under `packages/blendsdk/` | Reference app should provide consumer-level contract coverage            |

### 4.2 Existing public aggregate surface

The assembled `blendsdk` package exports these relevant backend subpaths:

| Capability                                | Public import           |
| ----------------------------------------- | ----------------------- |
| Expressions                               | `blendsdk/expression`   |
| Database core                             | `blendsdk/dbcore`       |
| PostgreSQL                                | `blendsdk/postgresql`   |
| Web framework                             | `blendsdk/webafx`       |
| Pino logging                              | `blendsdk/webafx-pino`  |
| Cache and pub/sub                         | `blendsdk/webafx-cache` |
| Authentication                            | `blendsdk/webafx-auth`  |
| Code generation and migration CLI helpers | `blendsdk/codegen`      |

See `packages/blendsdk/package.json:12-76`. The package also declares optional runtime peers for
Express, PostgreSQL, Redis, JWT/OIDC, Pino, and other integrations at
`packages/blendsdk/package.json:114-184`.

The generated technical documentation already uses `blendsdk/*` imports broadly, while the root
README still teaches separate `@blendsdk/*` installs and imports (`README.md:32-260`). The reference
application should settle and prove the intended consumer contract rather than copy the root
README's older package guidance.

### 4.3 Existing playground assets

`packages/playground/src/demo-app/` is a substantial WebAFX demo with controllers, services,
plugins, middleware, database SQL, configuration, authentication, products, users, and admin
routes. It is useful source material, but it is not currently a trustworthy production reference.

| Existing strength                                | Evidence                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Full application bootstrap                       | `packages/playground/src/demo-app/main.ts:82-370`                             |
| PostgreSQL service lifecycle                     | `packages/playground/src/demo-app/main.ts:123-145`                            |
| Controller composition                           | `packages/playground/src/demo-app/main.ts:205-227`                            |
| Lifecycle and shutdown example                   | `packages/playground/src/demo-app/main.ts:231-370`                            |
| Zod and OpenAPI route metadata                   | `packages/playground/src/demo-app/controllers/products.controller.ts:47-267`  |
| Parameterized SQL appears in product tag lookup  | `packages/playground/src/demo-app/controllers/products.controller.ts:393-400` |
| Separate migration smoke fixture uses public CLI | `packages/playground/database-migrations/README.md:7-102`                     |

### 4.4 Why the current demo should not simply be renamed

| Gap                                                           | Evidence                                                                                                                        | Required response                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Test command is a no-op                                       | `packages/playground/package.json:8`                                                                                            | Add real specification, integration, security, and lifecycle tests                      |
| CI explicitly excludes playground tests                       | `.github/workflows/ci.yml:40-42`                                                                                                | Add an authoritative reference-app CI path                                              |
| Demo imports private workspace packages                       | `packages/playground/src/demo-app/main.ts:42-43`                                                                                | Exercise the assembled public `blendsdk/*` contract                                     |
| Default JWT secrets exist                                     | `packages/playground/src/demo-app/config.ts:121-124`; `services/auth.service.ts:29-34`                                          | Fail closed when required production secrets are absent or insecure                     |
| Production auth only warns for a default secret in one path   | `services/auth.service.ts:97-105`                                                                                               | Make invalid security configuration a startup error                                     |
| Broad CORS and trusted proxy defaults                         | `packages/playground/src/demo-app/config.ts:103-109`                                                                            | Require explicit production allowlists and deployment-aware proxy settings              |
| Unsafe casts and `any` are present                            | examples include `main.ts:140-164`, `auth.service.ts:193`, `products.controller.ts:356,468-469`                                 | Use public typed APIs without unsafe casts; surface framework typing defects separately |
| Duplicate signal handlers are registered                      | WebAFX registers them at `packages/webafx/src/application/web-application.ts:634-651`; demo registers more at `main.ts:341-350` | Use one lifecycle owner and test idempotent shutdown                                    |
| Demo uses custom in-memory cache/auth/logging implementations | `src/demo-app/services/` and `src/demo-app/plugins/`                                                                            | Prefer BlendSDK's real `webafx-cache`, `webafx-auth`, and `webafx-pino` integrations    |
| README still states Node 18+                                  | `packages/playground/src/demo-app/README.md:67-74`                                                                              | Align all instructions with Node 22+                                                    |
| README calls the demo production-grade despite the gaps       | `packages/playground/src/demo-app/README.md:20-54`                                                                              | Reserve that claim until acceptance tests prove it                                      |

The existing playground may be mined for domain behavior and examples, but production-reference
code should be reviewed line by line. Copying all of it would preserve the exact ambiguity and
quality problems this initiative is meant to expose.

### 4.5 Framework capabilities already available

Do not reimplement these in application-local abstractions unless requirements identify a genuine
framework defect:

| Capability                                             | Current framework evidence                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| Application lifecycle and DI                           | `packages/webafx/src/application/web-application.ts:23-142`          |
| Request validation                                     | `packages/webafx/src/application/web-application.ts:386-407`         |
| Authentication/authorization route flow                | `packages/webafx/src/application/web-application.ts:366-383`         |
| Request ID with validated inbound UUID                 | `packages/webafx/src/application/request-id-middleware.ts:5-64`      |
| Built-in health endpoint                               | `packages/webafx/src/application/web-application.ts:589-601`         |
| Graceful shutdown and service/plugin disposal          | `packages/webafx/src/application/web-application.ts:572-587,666-749` |
| In-memory rate limiter                                 | `packages/webafx/src/application/rate-limiter.ts:4-102`              |
| OpenAPI route metadata                                 | `packages/webafx/src/application/route-builder.ts:9-109,234-262`     |
| JWT, OIDC, and memory auth providers                   | `packages/webafx-auth/src/index.ts:1-86`                             |
| Redis and memory cache/pub-sub providers               | `packages/webafx-cache/src/index.ts:1-88`                            |
| Structured Pino adapter/plugin with redaction defaults | `packages/webafx-pino/src/index.ts:1-27`                             |
| Reviewed SQL migration workflow                        | `packages/playground/database-migrations/README.md:24-102`           |

Known framework typing concerns should be recorded rather than hidden in the application. Examples
include `AuthorizeFunction<T = any>` and builder casts in
`packages/webafx/src/application/route-builder.ts:82-101,264-307`, plus `Server<any>` and settings
casts in `packages/webafx/src/application/web-application.ts:43-47,140-142`. If these block a clean
consumer implementation, create narrowly scoped framework fixes with their own specification tests.

## 5. Recommended product boundary

The recommendation is a single backend reference service focused on one small domain, with enough
behavior to exercise the framework's composition seams. It should be intentionally narrower than
the current all-features playground.

### 5.1 Recommended in scope

| Area           | Recommended proof                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Packaging      | A private workspace that imports only supported `blendsdk/*` public subpaths                                    |
| Domain         | Users plus a small product/catalog resource; avoid unrelated demo/error endpoints                               |
| Configuration  | Typed, allowlisted environment parsing; production secrets required; sanitized configuration logging            |
| Lifecycle      | Dependency registration, startup readiness, failure cleanup, graceful SIGTERM/SIGINT behavior                   |
| PostgreSQL     | Versioned migrations, transactional CRUD, constraints, parameterized queries, deterministic test reset          |
| Authentication | JWT validation through `webafx-auth`; password hashes via bcrypt/argon2/scrypt if local login remains in scope  |
| Authorization  | Public reads, authenticated writes, owner/admin checks, explicit 401 versus 403 behavior                        |
| Validation     | Zod schemas for params, query, and body; bounded pagination and search input                                    |
| API contract   | OpenAPI metadata for every supported route; deterministic generated artifact or contract assertion              |
| Cache          | Redis-backed read-through cache for one useful query; explicit invalidation after writes                        |
| Logging        | `webafx-pino`, structured request logs, request IDs, redaction, no credentials/tokens/PII                       |
| Operations     | Liveness, dependency-aware readiness, startup failure, and graceful shutdown documentation                      |
| Security       | Restrictive CORS, explicit trust-proxy policy, rate-limited login/public abuse paths, minimal production errors |
| Testing        | Black-box HTTP tests plus real PostgreSQL/Redis integration; security and lifecycle cases                       |
| Documentation  | One verified quick start, architecture explanation, environment reference, migration/runbook, curl examples     |
| CI             | Build, spec/integration/security tests, package assembly, and a consumer-import check                           |

### 5.2 Recommended out of scope

| Deferred capability                   | Reason                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `blendsdk create` scaffolder          | Priority 2; derive it from the verified reference structure                             |
| Frontend/React application            | Adds a second deployment/runtime boundary before backend composition is proven          |
| Mail, Azure mail, and i18n            | Useful modules but not necessary to validate the primary backend golden path            |
| OIDC browser login                    | JWT provider composition is sufficient initially; OIDC adds external identity workflows |
| Pub/sub workflows                     | Redis cache is enough to exercise the distributed dependency in the first slice         |
| OpenTelemetry                         | Separate priority after the application exposes stable operational seams                |
| Kubernetes/Terraform/cloud deployment | Keep deployment-provider policy separate from framework composition                     |
| Multiple databases or caches          | One PostgreSQL and one Redis contract provide sufficient proof                          |
| General framework refactors           | Fix only defects directly demonstrated by immutable reference-app specs                 |
| Public release automation changes     | The reference app can remain private and should not expand release scope                |

## 6. Recommended architecture

### 6.1 Workspace placement

Recommended: create a new private workspace, tentatively `packages/reference-app`, rather than
turning `packages/playground` into the reference application.

Rationale:

- Playground remains useful for experiments, generated artifacts, and focused demonstrations.
- A separate package receives a strict build/test contract without inheriting experimental launchers.
- CI can run it explicitly without changing the meaning of the playground.
- Its dependency list can model a real consumer of the assembled package.
- Later scaffolding can copy or template a deliberately small, stable structure.

Strongest counterargument: maintaining both a playground demo and reference app creates duplicate
examples. Mitigation: once the reference app is accepted, reduce the playground demo to focused
experiments or point its README to the reference app; do not maintain two production claims.

### 6.2 Suggested component layout

This is a planning seed, not an authorized file tree:

```text
packages/reference-app/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── .env.example
├── docker/
│   ├── docker-compose.yml
│   └── docker-compose-ci.yml
├── migrations/
│   ├── blendsdk.migrations.ts
│   ├── schema.ts
│   ├── migrations/
│   └── schema.snapshot.json
├── src/
│   ├── main.ts
│   ├── application.ts
│   ├── config.ts
│   ├── service-names.ts
│   ├── controllers/
│   ├── domain/
│   ├── services/
│   └── schemas/
└── tests/
    ├── reference-app.spec.test.ts
    ├── auth-security.spec.test.ts
    ├── cache-consistency.spec.test.ts
    ├── lifecycle.spec.test.ts
    └── support/
```

### 6.3 Composition model

1. Parse and validate configuration before creating external clients.
2. Construct `WebApplication` with restrictive runtime settings.
3. Register Pino logging first so later startup failures are structured and redacted.
4. Register PostgreSQL and Redis providers with health and disposal behavior.
5. Register the selected JWT auth provider under the service name expected by secure routes.
6. Register domain services through the application-owned service container.
7. Register a minimal controller set with Zod validation and OpenAPI metadata.
8. Let WebAFX own process signal handling; application code should use the returned shutdown
   function for tests and explicit embedding only.
9. Expose liveness independently from dependency-aware readiness if the framework supports that
   contract; otherwise document and implement the smallest necessary framework extension first.

## 7. Draft behavioral slice

The smallest useful domain slice is a product catalog with user ownership:

| Route                      | Authentication                             | Behavior to prove                                                |
| -------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `GET /health`              | Public                                     | Process is alive; no secret or dependency detail leaked          |
| `GET /ready`               | Public or network-restricted by deployment | PostgreSQL and Redis readiness; 503 on dependency failure        |
| `POST /api/auth/login`     | Public, rate limited                       | Validate credentials and issue a short-lived signed token        |
| `GET /api/products`        | Public, rate limited/bounded               | Validated pagination/filtering; cached result                    |
| `GET /api/products/:id`    | Public                                     | Validated ID; cache hit/miss behavior; 404 contract              |
| `POST /api/products`       | Authenticated                              | Validated create; current user becomes owner; caches invalidated |
| `PUT /api/products/:id`    | Owner or admin                             | 401/403/404 distinctions; transactional update; invalidation     |
| `DELETE /api/products/:id` | Admin                                      | Transactional deletion; invalidation; stable response contract   |

Registration, user administration, refresh tokens, logout/revocation, and seed endpoints are
material product choices. Do not inherit them from the demo without explicit requirements.

## 8. Draft acceptance criteria for requirements discovery

These criteria are candidates to refine and approve through the CodeOps ambiguity register.

### 8.1 Consumer and packaging contract

- [ ] Application source imports framework code only through public `blendsdk/*` subpaths.
- [ ] No source import reaches another workspace's private `src` or `dist` path.
- [ ] A clean install/build from the lockfile succeeds on Node 22+.
- [ ] A consumer-import test proves the assembled package exports every subpath used by the app.
- [ ] `cd packages/blendsdk && npm pack --dry-run` remains successful.

### 8.2 Configuration and startup

- [ ] Every environment input is parsed with an allowlist and bounded values.
- [ ] Missing/weak production JWT secrets fail startup before listening.
- [ ] Production CORS requires an explicit origin allowlist.
- [ ] Trust-proxy configuration is explicit and documented.
- [ ] Database and Redis connection failures prevent readiness and produce sanitized errors.
- [ ] Logs never include database passwords, JWTs, cookies, authorization headers, or password data.

### 8.3 Database and migrations

- [ ] A fresh database reaches the expected schema using committed reviewed migrations.
- [ ] Migration validation detects drift/checksum/history problems and fails closed.
- [ ] CRUD uses parameterized queries and database constraints.
- [ ] Failed multi-step writes roll back atomically.
- [ ] Tests can create and destroy isolated database state deterministically.

### 8.4 Authentication and authorization

- [ ] Invalid, missing, expired, or malformed credentials produce stable 401 responses.
- [ ] An authenticated non-owner receives 403 for owner-only mutation.
- [ ] An authenticated non-admin receives 403 for admin-only deletion.
- [ ] Passwords are hashed with an approved adaptive algorithm and never returned or logged.
- [ ] Login is rate limited and tested at the exact configured boundary.
- [ ] Token validation rejects invalid issuer/audience/signature/algorithm according to the chosen
      auth contract.

### 8.5 Validation and API contract

- [ ] Params, query, and body input are validated server-side.
- [ ] Pagination is bounded; empty, negative, oversized, duplicate, and malformed values are tested.
- [ ] Search/filter input cannot alter SQL structure.
- [ ] Unknown fields are rejected or stripped according to one explicitly approved policy.
- [ ] Production errors do not expose stack traces, SQL, paths, or configuration.
- [ ] OpenAPI declares every supported route, auth requirement, request schema, and response family.

### 8.6 Cache consistency

- [ ] The first eligible read populates Redis and the next equivalent read uses it.
- [ ] Create/update/delete invalidates all affected keys.
- [ ] Redis unavailability follows an explicitly approved fail-open or fail-closed behavior.
- [ ] Cache keys are namespaced and do not contain secrets or raw unbounded input.
- [ ] TTL behavior is deterministic under tests.

### 8.7 Lifecycle and operations

- [ ] Liveness remains distinct from dependency readiness.
- [ ] Readiness returns 503 when a required dependency is unavailable.
- [ ] SIGTERM stops accepting new work and disposes database, Redis, plugins, and singleton services.
- [ ] Repeated shutdown calls are safe.
- [ ] Startup failure disposes resources already created before the failure.
- [ ] Request logs carry the validated/generated request ID through asynchronous work.

### 8.8 Verification and documentation

- [ ] Specification tests are authored and observed red before implementation.
- [ ] PostgreSQL and Redis tests use real disposable services, not behavioral mocks.
- [ ] Security tests cover validation, authn, authz, injection resistance, rate limiting, and redaction.
- [ ] The quick start is executed from a clean checkout and matches actual commands.
- [ ] CI runs the reference-app test suite instead of excluding it.
- [ ] Full repository verification passes.

## 9. Decisions the next session must resolve

The following are not approved. They are the first ambiguity-register candidates.

| ID   | Decision                                  | Recommendation                                                                                                                  | Why it matters                                                 |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| D-01 | CodeOps feature slug                      | `production-reference-app`                                                                                                      | Determines all nested artifact paths                           |
| D-02 | New package versus playground replacement | New private `packages/reference-app`                                                                                            | Isolates the maintained contract from experimentation          |
| D-03 | Domain breadth                            | Products plus only the user behavior required for ownership/auth                                                                | Keeps focus on framework composition                           |
| D-04 | Registration                              | Seed test identities; omit public registration initially                                                                        | Registration creates a larger abuse and verification surface   |
| D-05 | Authentication                            | `webafx-auth` JWT provider; no custom JWT plugin                                                                                | Proves the actual framework integration                        |
| D-06 | Password login                            | Keep only if local login is needed to demonstrate auth end to end                                                               | Otherwise a test token/provider is smaller and safer           |
| D-07 | Cache backend                             | Redis in integration/production; memory only in unit-isolated contexts                                                          | Proves distributed dependency lifecycle                        |
| D-08 | Redis outage behavior                     | Reads fail open to DB; readiness reports degraded/unready; writes still invalidate best-effort only if consistency is specified | Incorrect policy causes stale or unavailable service behavior  |
| D-09 | Health model                              | `/health` liveness plus `/ready` dependency readiness                                                                           | Current WebAFX `/health` aggregates plugin health              |
| D-10 | OpenAPI artifact                          | Generate and compare a deterministic committed file or a normalized snapshot                                                    | Prevents documentation drift                                   |
| D-11 | Database reset strategy                   | Per-suite database/schema with deterministic migration application                                                              | Parallelism and cleanup affect reliability                     |
| D-12 | CI service ownership                      | Reference workspace owns disposable PostgreSQL and Redis compose files                                                          | Keeps its verification self-contained                          |
| D-13 | Framework fixes found during build        | Separate narrow tasks/issues, linked as blockers when necessary                                                                 | Prevents hidden scope expansion                                |
| D-14 | Playground disposition                    | Keep during implementation; consolidate only after acceptance                                                                   | Avoids destructive cleanup before replacement is proven        |
| D-15 | Release impact                            | No release for private example alone; release only if public package behavior/docs change                                       | Avoids unnecessary versions while preserving semver discipline |

Additional discovery must cover error formats, exact schemas, roles, token lifetime, password
policy, rate-limit values and keying, cache keys/TTLs, CORS origins, readiness information exposure,
data retention/deletion, concurrency conflicts, transaction boundaries, search semantics, pagination,
OpenAPI versioning, log fields/redaction, startup/shutdown timeouts, and test parallelism.

## 10. Specification-first test inventory

The final requirements must provide exact input-to-output expectations before these become tests.
Suggested suites:

| Suite            | Essential scenarios                                                               |
| ---------------- | --------------------------------------------------------------------------------- |
| Consumer package | Every used `blendsdk/*` import resolves from assembled output                     |
| Configuration    | Missing, malformed, boundary, hostile, production-secret, CORS, proxy cases       |
| Health/readiness | Healthy, PostgreSQL down, Redis down, recovery, sanitized response                |
| Authentication   | Missing/malformed/expired/wrong-signature/wrong-claims/valid token                |
| Authorization    | Anonymous, owner, other user, admin across each mutation                          |
| Product reads    | Empty list, pagination edges, search/filter combinations, invalid IDs, 404        |
| Product writes   | Valid, invalid, conflicts, forbidden, transaction rollback                        |
| SQL security     | Injection payloads remain values and cannot alter query structure                 |
| Cache            | Miss/hit, TTL, invalidation, Redis outage, namespace isolation                    |
| Rate limiting    | Requests up to limit, first rejected request, reset boundary, separate identities |
| Logging          | Request ID propagation; sensitive header/body/config values absent                |
| Lifecycle        | Startup dependency failure, partial cleanup, graceful drain, repeated shutdown    |
| OpenAPI          | Route inclusion, schemas, security declarations, deterministic generation         |
| Documentation    | Command/link/config validation and clean-checkout walkthrough                     |

Follow the repository naming rule: requirement-derived oracle tests use
`<feature>.spec.test.ts`; implementation-detail tests use `<feature>.impl.test.ts`. Write spec tests,
observe the expected red result, implement, turn them green, then add implementation tests.

## 11. Suggested execution phases after requirements approval

This is sequencing guidance only; `make-plan` must produce the authoritative checklist.

| Phase                               | Result                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| 1. Consumer skeleton                | Private workspace builds using only public aggregate imports                        |
| 2. Configuration and lifecycle      | Secure config, app factory, structured logging, health contract                     |
| 3. Persistence                      | Migration fixture, PostgreSQL service, domain repository/service, integration tests |
| 4. Authentication and authorization | Provider composition, login decision, roles, security tests                         |
| 5. API and OpenAPI                  | Validated controllers, stable responses, generated contract                         |
| 6. Redis caching                    | Provider wiring, read-through behavior, invalidation, failure policy                |
| 7. Operations hardening             | Readiness, shutdown, redaction, rate limiting, failure tests                        |
| 8. Documentation and CI             | Verified quick start, runbooks, CI workflow, full assembly check                    |

Each phase must end with focused verification, CodeOps reviewer/auditor review, finding rulings, and
roadmap synchronization before the next phase begins.

## 12. Verification contract

The authoritative repository sequence is `.github/workflows/ci.yml`. At minimum, the finished
initiative should pass:

```bash
yarn install --frozen-lockfile
yarn clean && yarn build
MODE=-ci yarn test
cd packages/blendsdk && npm pack --dry-run
```

Database-backed suites require Docker and must not be skipped when the reference app changes. The
plan should add focused workspace commands for fast iteration, but the exact scripts must be
confirmed during planning rather than invented here.

## 13. Worktree continuation procedure

Create a branch from the recorded integration baseline or the latest verified `origin/v5` if it
has advanced intentionally:

```bash
git fetch origin
git worktree add ../blendsdk-production-reference-app \
  -b feat/production-reference-app origin/v5
cd ../blendsdk-production-reference-app
yarn install --frozen-lockfile
```

Before changing files:

1. Confirm `git status --short --branch` is clean and the base commit is intended.
2. Read the repository `AGENTS.md`, this hand-off, and the linked GitHub issue.
3. Inspect whether `origin/v5` advanced beyond the baseline and review those changes.
4. Confirm `production-reference-app` as the feature slug, or choose another sanitized slug.
5. Run CodeOps `make-requirements` for the confirmed feature.
6. Resolve every ambiguity; do not accept this hand-off's recommendations by silence.
7. Sync `codeops/features/<feature>/00-roadmap.md` and `codeops/00-roadmap.md` after RDs are drafted.
8. Run CodeOps `make-plan` against the approved RD set.
9. Preflight the plan if desired, then run `exec-plan` specification-first.

## 14. Stop conditions and scope protection

Pause and seek a decision when:

- the application cannot use a required capability through the public `blendsdk/*` surface;
- a framework defect requires changes outside the approved modification set;
- a test exposes ambiguous behavior not covered by an RD/ambiguity decision;
- Redis failure semantics, auth policy, readiness meaning, or data ownership is unclear;
- CI would need infrastructure or permissions beyond the repository's existing runners;
- implementation would require weakening type safety, validation, security, or verification;
- the existing playground would need destructive removal or incompatible repurposing.

Do not broaden this initiative into scaffolding, observability platform work, frontend development,
new framework abstractions, or release-process changes without explicit scope approval.

## 15. Definition of hand-off completion

This hand-off is complete when:

- [x] Current repository state and evidence are recorded.
- [x] Proposed scope, boundaries, architecture, tests, and risks are documented.
- [x] Unapproved decisions are visibly separated from facts.
- [x] Continuation and verification steps are documented.
- [x] The GitHub issue exists and links the continuing work.
- [ ] The local hand-off file is committed if the user wants it available in every worktree.

The final two items are intentionally separate: the issue makes the hand-off immediately portable;
this file remains local until an explicit commit is requested.
