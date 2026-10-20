# Roadmap: test-parallelism

> **Feature-Set**: test-parallelism
> **Status**: Archived
> **Created**: 2026-10-01 10:28
> **Last Updated**: 2026-10-03 07:57
> **Progress**: 1 / 1 plans (100%)
> **CodeOps Artifact Schema**: 1

## Legend

⬜ Backlog · ✏️ RD Drafted · 🔎 RD Preflighted · 📋 Plan Created · 🔬 Plan Preflighted · 🔄 Executing · ✅ Done · ⛔ Blocked · ⏸️ Deferred

## Tracker

| ID | Title | RD | Plan | Stage | Status | Last Updated | Depends-on / Blocker |
| -- | ----- | -- | ---- | ----- | ------ | ------------ | -------------------- |
| — | Safe whole-repo and per-package parallel test execution | — | [parallel-test-execution](plans/parallel-test-execution/00-index.md) | Done | ✅ | 2026-10-03 01:39 | AR-8 satisfied — `pnpm-migration` merged (PR #137) |

> Standalone plan; `01-requirements.md` is the owning requirements doc.
> Configuration and documentation only: bounded concurrency, one CI package-graph test step plus
> CI's `scripts/` step, shared workflow concurrency group, documented resource map.
