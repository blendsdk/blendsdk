# Roadmap: BlendSDK Agent Skill

> **Feature-Set**: BlendSDK Agent Skill
> **Status**: Active
> **Created**: 2026-09-13
> **Last Updated**: 2026-09-15
> **Progress**: 7 / 7 (100%)
> **CodeOps Artifact Schema**: 1

## Legend

⬜ Backlog · ✏️ RD Drafted · 🔎 RD Preflighted · 📋 Plan Created · 🔬 Plan Preflighted · 🔄 Executing · ✅ Done · ⛔ Blocked · ⏸️ Deferred

## Tracker

| ID    | Title                                      | RD                                                                          | Plan | Stage      | Status | Last Updated | Depends-on / Blocker |
| ----- | ------------------------------------------ | --------------------------------------------------------------------------- | ---- | ---------- | ------ | ------------ | -------------------- |
| RD-01 | Skill Content Model and Coverage           | [RD-01](requirements/RD-01-skill-content-model-and-coverage.md)             | [skill-v1](plans/skill-v1/00-index.md) | Done | ✅     | 2026-09-13 19:50   | —                    |
| RD-02 | Freshness Pipeline                         | [RD-02](requirements/RD-02-freshness-pipeline.md)                           | [skill-v1](plans/skill-v1/00-index.md) | Done | ✅     | 2026-09-13 19:50   | depends on RD-01, RD-03 |
| RD-03 | DeepSeek Authoring Provider                | [RD-03](requirements/RD-03-deepseek-authoring-provider.md)                  | [skill-v1](plans/skill-v1/00-index.md) | Done | ✅     | 2026-09-13 19:50   | —                    |
| RD-04 | Validation and Evaluation                  | [RD-04](requirements/RD-04-validation-and-evaluation.md)                    | [skill-v1](plans/skill-v1/00-index.md) | Done      | ✅     | 2026-09-14 11:11   | depends on RD-01, RD-02 |
| RD-05 | Distribution and MCP Retirement            | [RD-05](requirements/RD-05-distribution-and-mcp-retirement.md)              | [skill-v1](plans/skill-v1/00-index.md) | Done      | ✅     | 2026-09-14 11:11   | depends on RD-01, RD-04 |
| RD-06 | Versionless docs and content-only freshness | [RD-06](requirements/RD-06-versionless-docs-and-content-freshness.md)        | [versionless-docs-and-content-freshness](plans/versionless-docs-and-content-freshness/00-index.md) | Done | ✅     | 2026-09-15   | all 19 tasks verified                     |
| RD-07 | Skill installer and updater | [RD-07](requirements/RD-07-skill-installer.md)        | [skill-installer](plans/skill-installer/00-index.md) | Done | ✅     | 2026-09-15   | all 13 tasks verified |

## Notes

- The `Plan` column stays `—` until a plan folder declares `> **Implements**: blendsdk-skill/RD-NN`
  in its `00-index.md`.
- Portfolio `codeops/00-roadmap.md` is intentionally not updated on this non-integration branch;
  the cascade runs when the feature lands on `v5`.
