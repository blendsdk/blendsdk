# Roadmap: webafx-auth

> **Feature-Set**: webafx-auth
> **Status**: Active
> **Created**: 2026-09-14
> **Last Updated**: 2026-09-26 23:35
> **Progress**: 9 / 9 (100%)
> **CodeOps Artifact Schema**: 1

## Legend

⬜ Backlog · ✏️ RD Drafted · 🔎 RD Preflighted · 📋 Plan Created · 🔬 Plan Preflighted · 🔄 Executing · ✅ Done · ⛔ Blocked · ⏸️ Deferred

## Tracker

| ID  | Title                              | RD  | Plan                                                                   | Stage | Status | Last Updated | Depends-on / Blocker |
| --- | ---------------------------------- | --- | ---------------------------------------------------------------------- | ----- | ------ | ------------ | -------------------- |
| —   | IntrospectionAuthProvider (RFC 7662) | —   | [introspection-auth-provider](plans/introspection-auth-provider/00-index.md) | Done  | ✅     | 2026-09-14   | Issue #107           |
| —   | Sliding sessions (session cookie)  | —   | [sliding-session-cookie](plans/sliding-session-cookie/00-index.md)       | Done  | ✅     | 2026-09-14   | Issue #109 |
| —   | Harden OIDC/JWT validation         | —   | [harden-oidc-jwt-validation](plans/harden-oidc-jwt-validation/00-index.md) | Done  | ✅     | 2026-09-15 | Issue #110 |
| —   | Rotate OIDC session id on refresh  | —   | [rotate-oidc-session-id](plans/rotate-oidc-session-id/00-index.md) | Done | ✅     | 2026-09-15 | Issue #112 |
| —   | Principal discriminator on AuthResult | —   | [principal-discriminator](plans/principal-discriminator/00-index.md) | Done | ✅     | 2026-09-15 | Issue #113 |
| —   | Align public API surface with exports | —   | [align-public-api-surface](plans/align-public-api-surface/00-index.md) | Done  | ✅     | 2026-09-15 | Issue #111 |
| —   | OIDC transport hardening (issue #119) | —   | [oidc-transport-hardening](plans/oidc-transport-hardening/00-index.md) | Done | ✅     | 2026-09-26 14:45 | Issue #119 |
| —   | OIDC BFF hardening (issues #122, #123) | —   | [oidc-bff-hardening](plans/oidc-bff-hardening/00-index.md) | Done | ✅     | 2026-09-26 20:57 | Issues #122, #123 |
| —   | OIDC callback outcomes (issues #125, #126) | —   | [oidc-callback-outcomes](plans/oidc-callback-outcomes/00-index.md) | Done | ✅     | 2026-09-26 23:10 | Issues #125, #126 |
| T-01 | Harden `returnTo` and stop reflecting IdP error text (issue #128) | — | [oidc-callback-input-hardening](plans/oidc-callback-input-hardening/99-execution-plan.md) | Done | ✅ | 2026-09-26 23:35 | Issue #128 |

> Standalone plans derived from GitHub issues. No upstream RD; each `01-requirements.md` is the owning requirements doc. Related follow-ups live in issues #108–#111; the session-id rotation follow-up is opened by the sliding-session plan (AR #6).
