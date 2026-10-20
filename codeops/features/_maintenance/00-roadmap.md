# Roadmap: _maintenance

> **Feature-Set**: _maintenance
> **Status**: Active
> **Created**: 2026-09-27
> **Last Updated**: 2026-10-04 00:51
> **Progress**: 13 / 13 (100%)
> **CodeOps Artifact Schema**: 1

## Legend

⬜ Backlog · ✏️ RD Drafted · 🔎 RD Preflighted · 📋 Plan Created · 🔬 Plan Preflighted · 🔄 Executing · ✅ Done · ⛔ Blocked · ⏸️ Deferred

## Tracker

| ID   | Title                                                                                                    | RD  | Plan                                                                            | Stage     | Status | Last Updated     | Depends-on / Blocker |
| ---- | -------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------- | --------- | ------ | ---------------- | -------------------- |
| T-01 | ai-training regeneration fidelity                                                                        | —   | [ai-training-budget](plans/ai-training-budget/99-execution-plan.md)             | Done      | ✅     | 2026-09-27 00:33 | —                    |
| T-02 | Repo-local blendsdk-develop development skill                                                            | —   | [blendsdk-develop-skill](plans/blendsdk-develop-skill/99-execution-plan.md)     | Done      | ✅     | 2026-09-27 00:34 | T-01                 |
| T-03 | Refresh the techdocs changelog reference after the v5.62.0 release                                       | —   | —                                                                               | Done      | ✅     | 2026-09-27 00:46 | —                    |
| T-04 | Fix the release skill-freshness failure after the OIDC classification fix                                | —   | —                                                                               | Done      | ✅     | 2026-09-27 10:02 | —                    |
| T-05 | Always-loaded dev skill and detached ai-training runs                                                    | —   | [long-running-ai-training](plans/long-running-ai-training/99-execution-plan.md) | Done      | ✅     | 2026-09-27 14:14 | T-02                 |
| T-06 | Refresh the techdocs changelog reference after the v5.64.0 release                                       | —   | —                                                                               | Done      | ✅     | 2026-09-27 14:25 | —                    |
| T-07 | Pre-push drift gates in the development skill                                                            | —   | —                                                                               | Done      | ✅     | 2026-09-27 14:31 | —                    |
| T-08 | Resolve the open BlendScript issues (#103, #104, #105)                                                   | —   | [blendscript-open-issues](plans/blendscript-open-issues/99-execution-plan.md)   | Done      | ✅     | 2026-10-01 08:33 | —                    |
| T-09 | Refresh the techdocs changelog reference after the v5.65.0 release                                       | —   | —                                                                               | Done      | ✅     | 2026-10-01 01:56 | —                    |
| T-10 | Refresh the techdocs changelog reference after the v5.66.0 release                                       | —   | —                                                                               | Done      | ✅     | 2026-10-01 13:30 | —                    |
| T-11 | Make the generated install commands rewrite-aware (`install blendsdk`, not `install blendsdk/<subpath>`) | — | [install-command-rewrite](plans/install-command-rewrite/99-execution-plan.md)    | Done      | ✅     | 2026-10-03 23:23 | —                    |
| T-12 | ai-training throughput: parallel waves, incremental regeneration, resilience | — | [ai-training-throughput](plans/ai-training-throughput/99-execution-plan.md)     | Done  | ✅     | 2026-10-03 18:30 | —                    |
| T-13 | Umbrella-install instruction in the ai-training and guide prompts (T-11 recurrence guard) | — | [prompt-install-guard](plans/prompt-install-guard/99-execution-plan.md)     | Done      | ✅     | 2026-10-04 00:51 | —                    |

> Cross-cutting tooling maintenance. No upstream RD; each mini-plan is the owning requirements document.
