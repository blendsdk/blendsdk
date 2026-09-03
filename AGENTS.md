<!-- CODEOPS-PROJECT:START -->
# BlendSDK v5 project guidance

## Project

- This is a Yarn 1 and Turborepo monorepo for a TypeScript SDK.
- Use Node.js 22 or newer and Yarn `1.22.x`; do not replace `yarn.lock` with another package
  manager's lockfile.
- `v5` is the integration and deployment branch.

## Structure

- `packages/*` contains the publishable libraries, the assembled `blendsdk` package, documentation,
  the MCP server, and the playground.
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

## Conventions

- TypeScript packages use strict mode, ES2022, ESM-compatible module resolution, and declaration
  output.
- Follow the existing Conventional Commit style, such as `feat(scope): ...`, `fix(scope): ...`,
  and `docs(scope): ...`.
- Respect package boundaries and import another workspace through its public API.
- `dist/` is generated build output. Do not edit files that identify themselves as auto-generated;
  run their owning generator instead.

## Verification

- For focused work, build and test every affected package and its dependants.
- Before committing, run the CI-equivalent build and test sequence. Do not treat Docker-dependent
  suites as optional when their packages are affected.
- Package assembly must pass `cd packages/blendsdk && npm pack --dry-run`.

## CodeOps

- Layout marker: `codeops/.codeops.yml`.
- Quality policy: `codeops/codeops.json` (`strict`, independent review required).
- Portfolio roadmap: `codeops/00-roadmap.md`; feature directories are created lazily under
  `codeops/features/`.
- Requirements use per-feature `RD-NN` identifiers; maintenance tasks use `T-NN`.
<!-- CODEOPS-PROJECT:END -->
