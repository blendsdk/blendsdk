# Roadmap: Database Migrations

> **Feature-Set**: Database Migrations
> **Status**: Archived
> **Created**: 2026-08-27
> **Last Updated**: 2026-08-30 01:52
> **Progress**: 4 / 4 (100%)
> **CodeOps Artifact Schema**: 1

## Legend

⬜ Backlog · ✏️ RD Drafted · 🔎 RD Preflighted · 📋 Plan Created · 🔬 Plan Preflighted · 🔄 Executing · ✅ Done · ⛔ Blocked · ⏸️ Deferred

## Tracker

| ID    | Title                                          | RD                                                                         | Plan                                                         | Stage | Status | Last Updated     | Depends-on / Blocker           |
| ----- | ---------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ | ----- | ------ | ---------------- | ------------------------------ |
| RD-01 | Migration CLI and SQL runner                   | [RD-01](requirements/RD-01-migration-cli-and-runner.md)                    | [database-migrations](plans/database-migrations/00-index.md) | Done  | ✅     | 2026-08-28 05:01 | —                              |
| RD-02 | Schema snapshots and diff generation           | [RD-02](requirements/RD-02-schema-snapshots-and-diff-generation.md)        | [database-migrations](plans/database-migrations/00-index.md) | Done  | ✅     | 2026-08-28 05:01 | depends on RD-01               |
| RD-03 | Production lifecycle and baseline adoption     | [RD-03](requirements/RD-03-production-lifecycle-and-baseline-adoption.md)  | [database-migrations](plans/database-migrations/00-index.md) | Done  | ✅     | 2026-08-28 05:01 | depends on RD-01, RD-02        |
| RD-04 | Quality, security, documentation, and examples | [RD-04](requirements/RD-04-quality-security-documentation-and-examples.md) | [database-migrations](plans/database-migrations/00-index.md) | Done  | ✅     | 2026-08-28 05:01 | depends on RD-01, RD-02, RD-03 |
