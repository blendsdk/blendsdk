# Roadmap: webafx-auth

> **Feature-Set**: webafx-auth
> **Status**: Active
> **Created**: 2026-09-14
> **Last Updated**: 2026-09-15 08:26
> **Progress**: 6 / 6 (100%)
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

> Standalone plans derived from GitHub issues. No upstream RD; each `01-requirements.md` is the owning requirements doc. Related follow-ups live in issues #108–#111; the session-id rotation follow-up is opened by the sliding-session plan (AR #6).
