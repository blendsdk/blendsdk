<!-- CODEOPS-PROJECT:START -->

# BlendSDK v5 project guidance

## Project

- This is a pnpm and Turborepo monorepo for a TypeScript SDK.
- Use Node.js 22 or newer and pnpm `12.8.x`; install from the committed `pnpm-lock.yaml` and keep
  exactly one lockfile.
- `v5` is the integration and deployment branch.

## Structure

- `packages/*` contains the workspace libraries, the assembled public `blendsdk` package, user
  documentation, and the playground. The libraries are private workspaces assembled into `blendsdk`
  subpaths.
- Package source normally lives in `packages/<name>/src`; tests live beside source or in
  `packages/<name>/tests`.
- `scripts/` contains repository-wide assembly, release, changelog, documentation, and training
  generators.
- `codeops/` contains the current nested CodeOps configuration and forward-looking roadmaps.
- `plans/archive/` and `requirements/` are legacy reference material, not active CodeOps inputs.

## Commands

- Install exactly from the lockfile: `pnpm install --frozen-lockfile`.
- Build all packages: `pnpm clean && pnpm build`.
- Run the repository test graph: `pnpm test`.
- Run one workspace test: `pnpm --filter <package-name> test`.
- The authoritative full verification sequence is `.github/workflows/ci.yml`; database-backed
  suites require Docker and use `MODE=-ci`.
- Format changed files with `pnpm exec prettier --write <paths>` using `.prettierrc`.
- Docs are generated from each package's `ai-training/` content. `pnpm docs:generate` refreshes
  every package page; scope it with `pnpm docs:generate --package <name[,name]>`, or write only
  pages that differ from the committed tree with `pnpm docs:generate --changed`.
  The committed tree is guarded by `pnpm docs:check`.
- Regenerating `ai-training/` content itself is LLM-backed and paid:
  `tsx --env-file=.env scripts/generate-ai-training.ts`. It already skips packages whose source
  hashes are current; add `--package` to narrow further and `--check` to preview without calls.
  Long runs start detached, log under `/tmp`, and are polled every two minutes; never run the
  generator in the foreground (recipe in the `blendsdk-develop` skill).

## Conventions

- TypeScript packages use strict mode, ES2022, ESM-compatible module resolution, and declaration
  output.
- Follow the existing Conventional Commit style, such as `feat(scope): ...`, `fix(scope): ...`,
  and `docs(scope): ...`.
- Respect package boundaries and import another workspace through its public API.
- Keep exactly one Zod version across the monorepo. Every package uses Zod 4 (`^4.4.3`, the
  version whose native `z.toJSONSchema` the OpenAPI tooling needs) and imports from `'zod'` only.
  Never import the `zod/v3` or `zod/v4` subpaths, never add a second copy through a dependency,
  and do not give generated clients or runtime client libraries a Zod dependency.
- `dist/` is generated build output. Do not edit files that identify themselves as auto-generated;
  run their owning generator instead.

## Verification

- For focused work, build and test every affected package and its dependants.
- Before committing, run the CI-equivalent build and test sequence. Do not treat Docker-dependent
  suites as optional when their packages are affected.
- When `ai-training/` content changes, regenerate the docs in the same change (`pnpm docs:generate`)
  and keep `pnpm docs:check` green. `pnpm docs:generate && pnpm docs:build` must complete with no
  dead links.
- Package assembly must pass `cd packages/blendsdk && npm pack --dry-run`.

## CodeOps

- Layout marker: `codeops/.codeops.yml`.
- Quality policy: `codeops/codeops.json` (`strict`, independent review required).
- Portfolio roadmap: `codeops/00-roadmap.md`; feature directories are created lazily under
  `codeops/features/`.
- Requirements use per-feature `RD-NN` identifiers; maintenance tasks use `T-NN`.

<!-- CODEOPS-PROJECT:END -->

## Development skill

- If `.agents/skills/blendsdk-develop/SKILL.md` exists (it is absent from the public mirror), load
  the repo-local `blendsdk-develop` skill at the start of every session, before any work in this
  repository. It covers ai-training, agent-skill, and techdocs regeneration, the DeepSeek run-scope
  rules, the detached long-run procedure, and CodeOps bookkeeping.

## Test resource map

- Run at most one full test graph per machine. CI serializes runs with the shared
  `blendsdk-self-hosted` concurrency group in `.github/workflows/ci.yml` and `release.yml`
  (`cancel-in-progress: false`); locally, do not run `pnpm test` while CI or another local full run
  uses the same machine. GitHub keeps one pending run per group, so a queued run replaced by a
  newer one must be re-triggered.
- Each Docker-backed package owns a unique host port, compose project, and (where fixed) container
  name:

  | Package         | Host port(s) | Compose project | Fixed container name           |
  | --------------- | ------------ | --------------- | ------------------------------ |
  | `codegen`       | 5597         | `codegen`       | —                              |
  | `playground`    | 5598         | `playground`    | —                              |
  | `postgresql`    | 5599         | `postgresql`    | —                              |
  | `webafx-cache`  | 6399         | `webafx-cache`  | `webafx-cache-redis-test[-ci]` |
  | `webafx-mailer` | 1025, 8025   | `webafx-mailer` | `webafx-mailer-mailpit[-ci]`   |

- `playground`'s compose stack is never started by its in-process test; its CI compose mount
  (`/home/builder/temp/...`) is stale and not a live shared path.
- `postgresql` tests must use TEMP tables or unique databases; they share one `testdb`.
- `webafx-mailer` runs its files serially (`fileParallelism: false`) because they share Mailpit.
- Concurrency caps: root `pnpm test` runs Turbo with `--concurrency=4`; the `postgresql`,
  `codegen`, and `webafx-cache` packages cap Vitest at `maxWorkers: 2` because they share a single
  Docker service each.
