# Roadmap: codegen-schema-coverage

> **Feature-Set**: codegen-schema-coverage
> **Status**: Active
> **Created**: 2026-10-29
> **Last Updated**: 2026-10-29 22:58
> **Progress**: 3 / 3 (100%)
> **CodeOps Artifact Schema**: 1

## Legend

⬜ Backlog · 🔄 Executing · ✅ Done · ⛔ Blocked · ⏸️ Deferred

## Tracker

| ID   | Title                                                             | RD  | Plan                                                                              | Stage | Status | Last Updated     | Depends-on / Blocker |
| ---- | ----------------------------------------------------------------- | --- | --------------------------------------------------------------------------------- | ----- | ------ | ---------------- | -------------------- |
| T-01 | Add pattern and length constraints to string schemas (issue #147) | —   | [string-schema-constraints](plans/string-schema-constraints/99-execution-plan.md) | Done  | ✅     | 2026-10-29 22:58 | Issue #147           |
| T-02 | Support deferrable foreign key constraints (issue #146)           | —   | [deferrable-foreign-keys](plans/deferrable-foreign-keys/99-execution-plan.md)     | Done  | ✅     | 2026-10-29 22:58 | Issue #146           |
| T-03 | Support `bytea` and `inet` columns (issue #144)                   | —   | [binary-network-columns](plans/binary-network-columns/99-execution-plan.md)       | Done  | ✅     | 2026-10-29 22:58 | Issue #144           |

> Issue-driven codegen coverage work. Each mini-plan is the owning specification for its issue; the
> three tasks share one `codegen` ai-training regeneration at the end of the feature.
