<!-- CODEOPS-PROJECT:START -->

# BlendSDK v5 project guidance

## Project

- This is a Yarn 1 and Turborepo monorepo for a TypeScript SDK.
- Use Node.js 22 or newer and Yarn `1.22.x`; do not replace `yarn.lock` with another package
  manager's lockfile.
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

- Install exactly from the lockfile: `yarn install --frozen-lockfile`.
- Build all packages: `yarn clean && yarn build`.
- Run the repository test graph: `yarn test`.
- Run one workspace test: `yarn workspace <package-name> test`.
- The authoritative full verification sequence is `.github/workflows/ci.yml`; database-backed
  suites require Docker and use `MODE=-ci`.
- Format changed files with `yarn prettier --write <paths>` using `.prettierrc`.
- Docs are generated from each package's `ai-training/` content. `yarn docs:generate` refreshes
  every package page; scope it with `yarn docs:generate --package <name[,name]>`, or write only
  pages that differ from the committed tree with `yarn docs:generate --changed`.
  The committed tree is guarded by `yarn docs:check`.
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
- When `ai-training/` content changes, regenerate the docs in the same change (`yarn docs:generate`)
  and keep `yarn docs:check` green. `yarn docs:generate && yarn docs:build` must complete with no
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
