# Hand-off: BlendSDK agent-agnostic skill

> **Status**: Planning complete, decisions locked, implementation not started
> **Branch**: `feature/blendsdk-skill` (cut from `v5`, nothing committed yet)
> **Created**: 2026-09-13
> **Audience**: the coding agent (opencode) that will implement this work

---

## 0. How to use this document

This is a complete brief. Everything decided in the originating session is recorded here, with the
evidence behind it, so no further discovery interviews are needed for the decisions marked
**LOCKED**. Two questions remain **OPEN** (section 5.3) and need the human's answer before the
requirements gate can pass.

Suggested opening prompt for the new agent:

```text
Read codeops/features/blendsdk-skill/HANDOFF.md end to end, then follow
"Section 15 — First-day checklist". Work only on branch feature/blendsdk-skill.
Ask me the two OPEN questions in section 5.3 before writing any RD.
```

Read this document together with:

| Artifact | Path | Purpose |
|---|---|---|
| Ambiguity register (requirements stage) | `codeops/features/blendsdk-skill/requirements/00-ambiguity-register.md` | 12 resolved decisions, 2 open items |
| Project guidance | `AGENTS.md` | Repo conventions, commands, verification |
| CodeOps layout marker | `codeops/.codeops.yml` | Nested layout, integration branch `v5` |
| Existing portfolio roadmap | `codeops/00-roadmap.md` | Feature tracking |

---

## 1. Executive summary

BlendSDK ships an MCP documentation server (`packages/blendsdk-mcp`, published on npm as
`blendsdk-mcp`). In practice it has been ineffective: agents must install a global process, wire
JSON configuration, and then retrieve documentation through a ranked full-text search that returns
either a 200-character excerpt or a multi-thousand-line document blob. It also teaches wrong import
paths and has carried stale content for months.

We are replacing it with an **agent-agnostic Agent Skill**: a spec-compliant `SKILL.md` folder with
progressive-disclosure references, generated deterministically from the monorepo's existing
documentation sources, validated so its code examples actually work, and distributed inside the
`blendsdk` umbrella npm package.

The work is defined as CodeOps feature `blendsdk-skill`, plan `skill-v1`, on branch
`feature/blendsdk-skill`.

---

## 2. Why: the evidence

All numbers below were measured in the originating session on 2026-09-13 at commit `55c910f34`.

| Finding | Measurement | Why it matters |
|---|---|---|
| MCP documentation corpus | 45 markdown files, ~41,000 lines, 1.4 MB | Large enough that the skill needs progressive disclosure, not one blob |
| Concatenation | `generate-docs.ts` concatenates 11 ai-training files per package into 2,000–5,000-line megadocs | A single query returns a document too large to be useful |
| Search cannot see examples | `packages/blendsdk-mcp/src/indexer/search-engine.ts` strips fenced code blocks before indexing | The most valuable content (working examples) is invisible to retrieval |
| Wrong import paths | 1,481 occurrences of `@blendsdk/*` across generated docs; only the header is rewritten | Agents copy imports that do not resolve for consumers |
| Version staleness | 153 ai-training files still say `**Version**: 5.42.0` while the SDK is 5.54.0 | Content provenance is not trustworthy |
| Package resolution bug | `src/tools/handlers.ts:94-100` does substring matching in alphabetical order | `query_package("webafx")` returns the `webafx-auth` document |
| Installation friction | Global npm install plus JSON server configuration per host | The user's stated reason for abandoning MCP |
| CI gap | `.github/workflows/ci.yml` runs only turbo workspace tests; root `vitest.config.ts` includes `**/*.test.ts` but nothing invokes it | Script-level tests and drift checks do not run unless wired explicitly |
| Manual refresh fails | `.ai-training-manifest.json` last run 5.42.0 | "A person will refresh it" is not a working strategy |

---

## 3. Goal, success criteria, non-goals

### 3.1 Goal

Produce a BlendSDK Agent Skill that any agent supporting the Agent Skills standard can load, whose
content stays current with the repository, and whose examples are verified to work against the
published SDK surface.

### 3.2 Success criteria

1. `.agents/skills/blendsdk/SKILL.md` exists, has valid frontmatter, and is committed on
   `feature/blendsdk-skill`.
2. `SKILL.md` stays under ~500 lines; detailed material lives in `references/`.
3. The skill covers all 16 publishable packages plus the 9 patterns and 5 project templates.
4. All import paths in skill content use the public `blendsdk/<subpath>` form.
5. A deterministic generator reproduces the committed skill content byte for byte.
6. A freshness gate blocks publishing when source documentation is older than the package sources.
7. The example validator passes: every self-contained TypeScript example compiles against the
   assembled package, and every imported symbol exists in the package's public surface.
8. An evaluation with 8–12 realistic prompts shows the skill matches or beats the retired MCP on
   import correctness, API accuracy, and convention adherence.
9. `blendsdk-mcp` no longer exists in the repo, no build or publish step references it, and no new
   versions are published.
10. The project's verify command passes: `yarn clean && yarn build && yarn test` plus
    `npx vitest run scripts/`.

### 3.3 Non-goals (explicitly out of scope for v1)

| Excluded | Why |
|---|---|
| Installer binary (`blendsdk-skill install`) | Deferred by explicit user decision after an independent complexity challenge; see section 5.2 |
| Per-client install-path target map (`--target`, `--auto`) | Deferred with the installer |
| Publishing a public plugin/marketplace repository | Sequenced later; needs its own approval and a new repo plus secrets |
| Regenerating all 16 packages with the LLM | Open question; recommendation is incremental regeneration |
| Rewriting the techdocs (VitePress) pipeline | Only the shared import-rewriting logic is reused |

---

## 4. Agent-agnostic design

### 4.1 The standard

Agent Skills is an open format (`https://agentskills.io/specification`). A skill is a folder with a
required `SKILL.md` (YAML frontmatter: `name`, `description`, optional `license`, `compatibility`,
`metadata`, `allowed-tools`) plus optional `scripts/`, `references/`, `assets/`, and
`agents/openai.yaml`. Discovery is progressive: clients load name and description first, then the
`SKILL.md` body when the skill is selected, then individual references on demand.

Constraints to respect:

- `name` must match the folder name, be lowercase with hyphens, max 64 characters.
- `description` must describe both what the skill does and when to use it, max 1,024 characters.
- Keep `SKILL.md` under ~500 lines / ~5,000 tokens.
- Keep references one level deep and link each one from `SKILL.md` with a clear "read this when" cue.

### 4.2 Verified client discovery paths

| Client | Project path | Global path | Source |
|---|---|---|---|
| opencode | `.agents/skills/<name>/SKILL.md`, `.claude/skills/...`, `.opencode/skills/...` | `~/.agents/skills/...`, `~/.claude/skills/...`, `~/.config/opencode/skills/...` | `https://opencode.ai/docs/skills/` |
| Codex | `.agents/skills` from the working directory up to the repo root | `~/.agents/skills`, `/etc/codex/skills` | `https://developers.openai.com/codex/skills` |
| VS Code | `.agents/skills/` | — | `https://agentskills.io/skill-creation/quickstart` |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` | `https://code.claude.com/docs/en/skills` |

**Consequence:** `.agents/skills/blendsdk/` is the single best canonical location. It is read by
Codex, opencode and VS Code directly, and opencode additionally reads the `.claude/skills` alias, so
one folder covers the clients the user cares about. Roughly 48 clients implement the standard; their
setup pages are listed at `https://agentskills.io/clients`.

### 4.3 Distribution shape decided for v1

The skill folder ships inside the `blendsdk` npm package. The user runs `npm install blendsdk` (or
`yarn add blendsdk`) and the skill content is present at
`node_modules/blendsdk/skills/blendsdk/`. To activate it in a client, the user copies or symlinks
that folder into a discovery path from section 4.2 — for example:

```bash
mkdir -p .agents/skills
cp -R node_modules/blendsdk/skills/blendsdk .agents/skills/
# or keep a single source updating with the package:
ln -s "$(pwd)/node_modules/blendsdk/skills/blendsdk" .agents/skills/blendsdk
```

No installer binary is built in v1. Documenting this copy/symlink step in the package README is part
of the work.

---

## 5. Decisions

### 5.1 Locked decisions

| # | Decision | Value |
|---|---|---|
| D-1 | Replaces MCP? | Yes — the skill is the single agent-facing artifact; the MCP is retired |
| D-2 | Feature / plan / RD naming | Feature `blendsdk-skill`, plan `skill-v1`, RDs `blendsdk-skill/RD-NN` |
| D-3 | Source of truth | `.agents/skills/blendsdk/` holds hand-written and generated content |
| D-4 | Content authoring model | DeepSeek API inside the generator pipeline; the skill assembly itself is deterministic |
| D-5 | Model and effort | `deepseek-flash`, thinking enabled, `reasoning_effort=max` |
| D-6 | Generator limits | Output limit raised to 32K tokens; timeout 300s |
| D-7 | Failure policy | Fail fast — no silent fallback to another model |
| D-8 | Coverage | 16 packages plus the 21 hand-written guide/pattern/template files |
| D-9 | Distribution | Skill folder inside the umbrella npm package; no installer binary in v1 |
| D-10 | Other agents | One spec-compliant skill; per-client target map deferred |
| D-11 | Complexity scope | Generator + drift gate + freshness gate + example validator; installer deferred (challenger verdict: Simplify) |
| D-12 | Validator depth | Import-path and symbol checks plus `tsc --noEmit` on self-contained blocks |
| D-13 | MCP removal | Staged within this feature: migrate content → build and validate the skill → delete package and references |
| D-14 | Evaluation | 8–12 prompts comparing skill vs retired MCP, graded with deterministic checks |
| D-15 | Branch | `feature/blendsdk-skill`, cut from `v5` (already created, empty) |
| D-16 | Verify command | `yarn clean && yarn build && yarn test` plus `npx vitest run scripts/` |

### 5.2 Complexity escalation record

An independent challenger (a separate `codex exec` run, model `deepseek-flash`,
`reasoning_effort=max`, read-only sandbox, blind to the parent's preference) returned:

| Item | Verdict |
|---|---|
| Deterministic generator + drift check | Load-bearing (this is the minimum viable machinery) |
| Source-freshness gate | Required — a drift check alone can pass while inputs are stale |
| Example type-check | High value; keep, because the agreed evaluation needs a deterministic grader |
| npm-embedded installer + multi-client map | Simplify — drop it; it recreates the installation pain that retired the MCP and opens an unbounded client matrix |

The user approved the simplified scope. Note the challenger could not read the repository (its own
nested sandbox failed with `bwrap: loopback: Failed RTM_NEWADDR`), so treat its repo claims as
unverified and verify anything you rely on.

### 5.3 OPEN questions — ask the human before writing RDs

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q-1 | How much source documentation should the first DeepSeek run regenerate? | (a) only packages the checksum manifest marks stale, (b) all 16 packages × 11 files = 176 calls, (c) none in v1 | (a) incremental — cheapest, reuses existing change detection, and the freshness gate still blocks stale output |
| Q-2 | Should the published `blendsdk-mcp` npm package be deprecated? | (a) defer the command to the end of the final phase and ask again, (b) pre-approve `npm deprecate`, (c) never touch the registry | (a) defer — the notice is public and irreversible; existing installs keep working either way |

Record the answers in `requirements/00-ambiguity-register.md` (rows 13 and 14) and change the
header to `✅ GATE PASSED — all 14 items resolved`.

---

## 6. Target architecture

```
packages/*/ai-training/**            (LLM-authored source docs, 11 files per package)
packages/*/package.json + src/index.ts (version + public export surface)
packages/blendsdk-mcp/docs/**        (hand-written guides, patterns, templates — to be migrated)
        │
        ▼
scripts/skill/generate.ts            (deterministic assembly — NEW)
        │
        ├──► .agents/skills/blendsdk/SKILL.md              (hand-written, curated)
        ├──► .agents/skills/blendsdk/references/**          (generated + migrated)
        └──► .agents/skills/blendsdk/assets/templates/**    (migrated project templates)
        │
        ├──► scripts/skill/check-drift.ts   (regenerate to temp, diff against committed)
        ├──► scripts/skill/check-freshness.ts (source manifest vs package sources)
        └──► scripts/skill/validate-examples.ts (import/symbol checks + tsc)
        │
        ▼
scripts/assemble.ts → packages/blendsdk/skills/** → npm package `blendsdk`
```

### 6.1 Proposed skill content model

One `SKILL.md` plus references, split so an agent loads ~200–400 lines rather than 5,000:

```
.agents/skills/blendsdk/
├── SKILL.md                     # scope, conventions, routing table, hard rules
├── references/
│   ├── index.md                 # task → file routing map (generated)
│   ├── packages/<pkg>/overview.md     # what it is, when to use, key features
│   ├── packages/<pkg>/usage.md        # install, quick start, configuration, errors
│   ├── packages/<pkg>/api.md          # exported symbols, signatures, types, tables
│   ├── packages/<pkg>/recipes.md      # advanced patterns, scenarios, examples
│   ├── packages/<pkg>/pitfalls.md     # troubleshooting, testing patterns
│   ├── guides/*.md                    # migrated getting-started guides
│   ├── patterns/*.md                  # migrated how-to patterns
│   └── architecture.md
└── assets/templates/*.md              # migrated project templates (5)
```

Mapping from the existing ai-training file set (identical names across all 16 packages):

| ai-training file | Destination reference |
|---|---|
| `00-overview.md` | `overview.md` |
| `01-core-concepts.md` | `usage.md` (concepts section) |
| `02-basic-usage.md` | `usage.md` |
| `03-advanced-patterns.md` | `recipes.md` |
| `04-best-practices.md` | `pitfalls.md` (practices section) |
| `05-common-scenarios.md` | `recipes.md` |
| `06-testing-patterns.md` | `pitfalls.md` (testing section) |
| `07-troubleshooting.md` | `pitfalls.md` |
| `08-api-reference.md` | `api.md` |
| `09-examples-library.md` | `recipes.md` (examples section) |
| `README.md` | dropped (index noise) |

Normalization rules the generator must apply:

1. Rewrite `@blendsdk/<pkg>` to `blendsdk/<pkg>` everywhere, including subpath mappings — reuse
   `scripts/techdocs/rewrite-imports.ts`.
2. Replace embedded `**Version**: 5.42.0` headers with the current version from
   `packages/blendsdk/package.json`.
3. Drop per-file metadata headers and duplicated intros when merging files into one reference.
4. Emit deterministic output: sorted file order, LF endings, no timestamps, stable key order.
5. Mark every generated file with a final line such as
   `<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->`.

---

## 7. Implementation plan

Phases follow the CodeOps specification-first ordering: spec tests → red → implement → green →
impl tests → verify.

### Phase 0 — Requirements and plan artifacts

| # | Task | Output |
|---|---|---|
| 0.1 | Ask the human the two OPEN questions (section 5.3) | Answers in the register |
| 0.2 | Write `requirements/README.md` and `requirements/RD-01…RD-05` | See section 8 for the RD decomposition |
| 0.3 | Write `plans/skill-v1/00-ambiguity-register.md` (plan-level), then `00-index.md`, `01-requirements.md`, `02-current-state.md`, `03-01…03-03` component specs, `07-testing-strategy.md`, `99-execution-plan.md` | CodeOps plan set |
| 0.4 | Sync `codeops/00-roadmap.md` (feature row, stage RD Drafted → Plan Created) | Portfolio roadmap updated |

### Phase 1 — DeepSeek provider

| # | Task | Files |
|---|---|---|
| 1.1 | Add provider config: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`), `DEEPSEEK_MODEL` (default `deepseek-flash`), `DEEPSEEK_REASONING_EFFORT` (default `max`), explicit `LLM_PROVIDER` selector | `scripts/changelog/llm-provider.ts`, `scripts/changelog/types.ts` |
| 1.2 | Implement the call path. The `openai` SDK already honors `OPENAI_BASE_URL`; prefer passing `baseURL` explicitly and `thinking: { type: 'enabled' }` plus `reasoning_effort` through a typed wrapper | same |
| 1.3 | Fail-fast policy: when `LLM_PROVIDER=deepseek`, an error aborts the run with a clear message instead of falling back | same |
| 1.4 | Report the real provider and model in `LLMResult`; add DeepSeek rows to the pricing table in `scripts/ai-training/cost-estimator.ts` | `scripts/ai-training/cost-estimator.ts` |
| 1.5 | Raise generator limits for DeepSeek: `max_tokens` 8192 → 32768, timeout 120s → 300s (currently hard-coded in `scripts/generate-ai-training.ts`) | `scripts/generate-ai-training.ts`, `scripts/techdocs/guide-generator.ts` |
| 1.6 | Add a `--provider` CLI flag so generation runs are reproducible | both generators |

Verified DeepSeek API facts (from `https://api-docs.deepseek.com/api/create-chat-completion`):

| Fact | Value |
|---|---|
| OpenAI-compatible base URL | `https://api.deepseek.com` (also `/v1`); Anthropic-compatible at `/anthropic` |
| Model ids | `deepseek-flash`, `deepseek-v4-pro` |
| Thinking | `thinking: { type: "enabled" | "disabled" }`, default enabled |
| Reasoning effort | `reasoning_effort: none | low | high | max`, default `high` |
| `max_tokens` | 1 … 393,216; defaults 8K (non-thinking), 64K (thinking), 128K (max effort) |
| Response | `choices[0].message.content` (final answer) and `message.reasoning_content` (chain of thought); usage includes `completion_tokens_details.reasoning_tokens` |

### Phase 2 — Skill generator and gates

| # | Task | Files |
|---|---|---|
| 2.1 | Implement the assembly generator per section 6.1 | `scripts/skill/generate.ts`, `scripts/skill/mapping.ts`, tests in `scripts/skill/tests/` |
| 2.2 | Implement the drift check (generate to a temp dir, diff against `.agents/skills/blendsdk`) | `scripts/skill/check-drift.ts` |
| 2.3 | Implement the freshness gate: fail when a package's `src`, `tests`, `apiSurface` or `packageJson` hash differs from what `.ai-training-manifest.json` recorded | `scripts/skill/check-freshness.ts` |
| 2.4 | Wire both checks into CI as an explicit step (root vitest is not run by CI today) | `.github/workflows/ci.yml` |
| 2.5 | Add root package scripts: `skill:generate`, `skill:check`, `skill:validate` | `package.json` |

### Phase 3 — Content migration

| # | Task | Notes |
|---|---|---|
| 3.1 | Move the 5 getting-started guides, 9 patterns (+ index), 5 templates and 2 hand-written architecture files from `packages/blendsdk-mcp/docs/**` into the skill tree | Templates go to `assets/templates/`; keep `{{PROJECT_NAME}}` placeholders |
| 3.2 | Write `SKILL.md` by hand | Content outline in section 9 |
| 3.3 | Generate the 16 package reference sets and `references/index.md` | Requires Phase 1 only if ai-training content is regenerated |
| 3.4 | Add the generated-file marker to every generated reference | See normalization rule 5 |

### Phase 4 — Validator and evaluation

| # | Task | Files |
|---|---|---|
| 4.1 | Tier 1 checks: every `blendsdk/<subpath>` import resolves in the umbrella `exports` map; every named import exists in that package's `src/index.ts` exports | `scripts/skill/validate-examples.ts` |
| 4.2 | Tier 2 check: extract fenced `ts`/`typescript` blocks, write a temp project, run `tsc --noEmit` against the assembled `packages/blendsdk` types | same |
| 4.3 | Fragment convention: blocks that are illustrative must be marked (for example an info string such as ```` ```typescript fragment ````) and are excluded from tier 2 but still import-checked when they contain imports | same |
| 4.4 | Build the evaluation set: 8–12 realistic prompts (CRUD API, JWT auth, caching, database queries, codegen, email, i18n, testing), run once against the skill and once against the retired MCP content, grade on import correctness, API accuracy and convention adherence | `codeops/features/blendsdk-skill/plans/skill-v1/07-testing-strategy.md` |

### Phase 5 — Distribution

| # | Task | Files |
|---|---|---|
| 5.1 | Copy the skill folder into the umbrella package during assembly | `scripts/assemble.ts` |
| 5.2 | Add `skills` to the published file set | `packages/blendsdk/package.json` (`files: ["dist", "README.md", "skills"]`) |
| 5.3 | Verify packaging: `cd packages/blendsdk && npm pack --dry-run` lists the skill files | CI already runs this |
| 5.4 | Document activation (copy or symlink into `.agents/skills`) in `packages/blendsdk/README.md` | — |

### Phase 6 — MCP retirement (staged, last)

Order inside the phase: confirm the skill passes evaluation first, then delete.

| # | Task | Files / references |
|---|---|---|
| 6.1 | Delete the package folder | `packages/blendsdk-mcp/**` |
| 6.2 | Remove the npm publish block | `scripts/lockstep.ts:576-590` |
| 6.3 | Remove release-workflow references | `.github/workflows/release.yml:118` (artifact bundle), `:169` (dist assertion) |
| 6.4 | Remove the change-detection exclusion and its test | `scripts/ai-training/change-detection.ts:35`, `scripts/ai-training/tests/change-detection.test.ts:415` |
| 6.5 | Remove the public-mirror exclusion | `scripts/sync-public.sh:45` |
| 6.6 | Update tests that assert the MCP generator path or package list | `packages/blendscript/tests/distribution/distribution.impl.test.ts:109`, `distribution.spec.test.ts:233,255` |
| 6.7 | Update documentation references | `AGENTS.md:14`, `.clinerules/project.md:116,136,200`, `.clinerules/update-mcp-docs.md` |
| 6.8 | Leave historical artifacts untouched | `requirements/RD-01-react-i18n.md`, `codeops/features/blendscript/**`, `packages/blendsdk-docs/CHANGELOG.md` |
| 6.9 | Optional registry notice (needs the human's explicit go-ahead, OPEN question Q-2) | `npm deprecate blendsdk-mcp@* "Replaced by the BlendSDK agent skill shipped in the blendsdk package."` |

---

## 8. Requirements decomposition (write these as RDs)

| RD | Title | Covers |
|---|---|---|
| RD-01 | Skill content model and coverage | Folder layout, reference granularity, normalization rules, full 16-package coverage, migration of the hand-written guides/patterns/templates |
| RD-02 | Freshness pipeline | Deterministic generator, drift check, source-freshness gate, CI wiring, root scripts |
| RD-03 | DeepSeek authoring provider | Provider config, model and effort policy, fail-fast behavior, token and timeout limits, provenance and cost reporting |
| RD-04 | Validation and evaluation | Import/symbol checks, `tsc` tier, fragment convention, the 8–12 prompt evaluation and its grading |
| RD-05 | Distribution and MCP retirement | Umbrella packaging, activation documentation, staged deletion, reference cleanup, registry decision |

Dependency order: RD-01 → RD-02 → RD-04, RD-03 independent (feeds RD-02), RD-05 depends on RD-01,
RD-04.

---

## 9. `SKILL.md` outline

Hand-written, under 500 lines. Suggested sections:

1. **Frontmatter** — `name: blendsdk`, a description naming the trigger surface: BlendSDK, webafx,
   dbcore, postgresql, expression, codegen, React, WebAFX plugins.
2. **What BlendSDK is** — one short paragraph, the umbrella package, `blendsdk/<subpath>` imports.
3. **Hard rules** — always import from `blendsdk/<subpath>` (never `@blendsdk/*`, which are private
   workspace names); never invent APIs, verify against `references/packages/<pkg>/api.md`; examples
   must be complete and typed; check the installed version before assuming a signature.
4. **Routing table** — task → files to read (for example "build a REST API" → `packages/webafx/`,
   `patterns/01-web-api-crud.md`; "database access" → `packages/postgresql/`, `packages/dbcore/`,
   `packages/expression/`).
5. **Package map** — 16 packages with one-line descriptions and their reference paths.
6. **Workflows** — short pointers to the pattern references for CRUD, auth, caching, i18n, email,
   logging, codegen, testing.
7. **Scaffolding** — how to use `assets/templates/` and the `{{PROJECT_NAME}}` placeholder.

---

## 10. Validator detail

| Tier | What it does | Failure behavior |
|---|---|---|
| 1a | Parse `import { A, B } from 'blendsdk/<pkg>'` and verify `<pkg>` exists in `packages/blendsdk/package.json` `exports` | Fail with file, line and the offending specifier |
| 1b | Verify each named symbol appears in the corresponding package's `src/index.ts` export surface (reuse the regex export extraction already used by the docs generators) | Fail listing unknown symbols |
| 2 | Extract fenced `ts`/`typescript` blocks that are not marked `fragment`, write them into a temp project that maps `blendsdk/*` to `packages/blendsdk/dist/**`, and run `tsc --noEmit` | Fail with compiler diagnostics |
| — | Fragment blocks | Import-checked when they contain imports, skipped by tier 2 |

The validator must build the umbrella package first (`yarn workspace blendsdk build`) or run after
`yarn build`; make that ordering explicit in the script's error messages.

---

## 11. Evaluation plan

| Aspect | Design |
|---|---|
| Prompts | 8–12 realistic tasks: CRUD API, JWT auth, caching and pub/sub, database queries with the expression builder, codegen from a schema, email sending, i18n, structured logging, React hooks, CLI parsing, testing patterns |
| Arms | Skill references vs the retired MCP documentation (the MCP content can be recovered from git history at commit `55c910f34`) |
| Grading | Deterministic first: imports compile, symbols exist, version references correct. Then a short rubric: correct package choice, correct plugin wiring order, no invented APIs |
| Evidence | Record raw outputs plus a results table in the plan's `07-testing-strategy.md`; state the pass thresholds before running |
| Cost | Use the provider's token reporting; DeepSeek reasoning tokens appear in `usage.completion_tokens_details.reasoning_tokens` |

---

## 12. Verification and definition of done

| Check | Command |
|---|---|
| Build everything | `yarn clean && yarn build` |
| Workspace tests | `yarn test` |
| Script-level tests (generator, gates, validator) | `npx vitest run scripts/` |
| Package assembly | `cd packages/blendsdk && npm pack --dry-run` |
| Skill drift | `yarn skill:check` |
| Skill freshness | `yarn skill:freshness` (or folded into `skill:check`) |
| Example validation | `yarn skill:validate` |

Definition of done: all of section 3.2 satisfied, all checks above green, the CodeOps execution plan
fully checked off, and the branch ready for review against `v5`.

---

## 13. Environment and repository constraints

| Constraint | Detail |
|---|---|
| Node / package manager | Node.js >= 22, Yarn 1.22.x; never replace `yarn.lock` |
| Branch model | `v5` is the integration branch; work happens on `feature/blendsdk-skill` |
| Monorepo | Turborepo; `packages/*` are workspaces; `blendsdk` is the assembled umbrella package |
| CodeOps | Nested layout (`codeops/features/<feature>/...`), strict quality policy, independent review required |
| Coding standards | Strict TypeScript, no `as any`/`as unknown`, JSDoc on public APIs, spec vs impl test naming (`*.spec.test.ts` before implementation), Conventional Commits, no `codeops/`/plan references in code comments |
| Docs generators | `scripts/generate-ai-training.ts` (LLM, checksum manifest) and `scripts/generate-techdocs.ts` + `scripts/techdocs/**` (deterministic, import rewriting) |
| Published package | `packages/blendsdk/package.json` → `files: ["dist", "README.md"]`, `bin.blendsdk` points at the codegen migration CLI |
| Disk | The originating machine was at 97% disk usage; check free space before any full install |

### 13.1 Tooling problems seen in the originating session

| Problem | Impact | Workaround |
|---|---|---|
| `bwrap: loopback: Failed RTM_NEWADDR` | Every sandboxed command failed, in the main session and in nested runs | Run with the sandbox disabled or escalate; mention it if commands fail unexpectedly |
| Subagent task delivery broken (Codex 0.154.0) | Spawned agents started with an empty inbox — no task message was persisted in the child thread | Use `codex exec` for independent runs, or do the work in the main session |
| DeepSeek configured with `wire_api = "responses"` | Nested runs worked, but verify provider behaviour before relying on it | `codex exec -m deepseek-flash -c model_reasoning_effort=max -s read-only` was verified to work |

opencode will have its own runtime; these notes explain gaps in the record rather than predicting
the new environment.

---

## 14. Reference appendix

### 14.1 Key files

| Path | Why it matters |
|---|---|
| `scripts/generate-ai-training.ts` | LLM generator for `ai-training/`; contains the 8192-token limit and 120s timeout to raise |
| `scripts/ai-training/prompts.ts` | Defines the 11-file sequence and prompt assembly |
| `scripts/ai-training/templates/*.md` | Per-file prompt templates (including `04-best-practices.md`) |
| `scripts/ai-training/change-detection.ts` | Checksum staleness detection over `src`, `tests`, `apiSurface`, `packageJson` |
| `.ai-training-manifest.json` | Per-package hashes, `sdkVersion`, `aiTrainingHash`; stale at 5.42.0 |
| `scripts/generate-techdocs.ts`, `scripts/techdocs/**` | Deterministic transformer to VitePress; source of `rewrite-imports.ts` and the package constants |
| `scripts/changelog/llm-provider.ts` | Provider abstraction to extend with DeepSeek |
| `scripts/assemble.ts` | Umbrella package assembly; add the skill copy step here |
| `packages/blendsdk/package.json` | `files`, `bin`, `exports` for the published package |
| `packages/blendsdk-mcp/scripts/generate-docs.ts` | The retiring assembler (content source for migration, not a pattern to copy) |
| `packages/blendsdk-mcp/src/tools/handlers.ts` | Contains the package-resolution bug worth quoting in the evaluation write-up |

### 14.2 External references

| Topic | URL |
|---|---|
| Agent Skills specification | `https://agentskills.io/specification` |
| Skill authoring best practices | `https://agentskills.io/skill-creation/best-practices` |
| Client list and setup pages | `https://agentskills.io/clients` |
| Codex skills documentation | `https://developers.openai.com/codex/skills` |
| opencode skills documentation | `https://opencode.ai/docs/skills/` |
| DeepSeek chat completion API | `https://api-docs.deepseek.com/api/create-chat-completion` |

### 14.3 Measured inventory of the retiring MCP content

| Area | Files | Fate |
|---|---|---|
| `docs/01-getting-started/` (5) | Installation, scaffolding, Docker, deployment, index | Migrate to `references/guides/` |
| `docs/03-patterns/` (10) | CRUD, auth, caching, database, plugins, codegen, email, i18n, testing, index | Migrate to `references/patterns/` |
| `docs/06-templates/` (6) | 5 templates plus index, with `{{PROJECT_NAME}}` placeholders | Migrate to `assets/templates/` |
| `docs/04-architecture/` (4) | Dependency graph is generated; index, project structure and design patterns are hand-written | Regenerate the graph; migrate the three hand-written files |
| `docs/02-packages/` (17) | 16 package docs plus index, generated by concatenation | Regenerate as skill references; never copy the megadocs |
| `docs/05-reference/` (2) | Imports cheatsheet, Docker reference | Regenerate as skill references |
| `docs/00-overview.md` | Generated SDK overview | Regenerate as part of `references/index.md` |

---

## 15. First-day checklist

1. Confirm you are on `feature/blendsdk-skill` and the worktree is clean.
2. Read `AGENTS.md`, `codeops/.codeops.yml`, `codeops/features/blendsdk-skill/requirements/00-ambiguity-register.md`
   and this document.
3. Ask the human the two OPEN questions from section 5.3.
4. Close the register (`✅ GATE PASSED — all 14 items resolved`), then write the requirements set
   (`README.md`, `RD-01…RD-05`) using the CodeOps templates.
5. Write the `plans/skill-v1/` document set, starting with its own ambiguity register, then the
   index, requirements delta, current state, the three component specs, the testing strategy and
   the execution plan.
6. Sync `codeops/00-roadmap.md`.
7. Only then start implementation with Phase 1 (DeepSeek provider), following the CodeOps
   specification-first ordering in every phase.
8. Run the full verify command before every commit; use Conventional Commits such as
   `feat(skill): add deterministic skill reference generator`.

---

## 16. Closing notes from the originating session

- Nothing has been committed; the only files created are this document and the requirements
  ambiguity register.
- The MCP package is still present and still published; do not delete it until Phase 6 and until the
  evaluation passes.
- The skill must never re-introduce the MCP's failure modes: no servers, no install ceremony, no
  megadoc blobs, no internal `@blendsdk/*` import paths, no unverified examples.
- If a decision in this document conflicts with what you find in the repository, trust the
  repository and record the discrepancy in the plan's ambiguity register before proceeding.
