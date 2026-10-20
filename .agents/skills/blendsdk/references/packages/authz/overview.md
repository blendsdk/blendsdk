> **Package**: `blendsdk/authz`

# authz Overview

---

## What It Is

`blendsdk/authz` is a zero-dependency TypeScript library that gives an application its own authorization vocabulary and the primitives to populate and evaluate it. It answers two questions: how do the claims an identity provider sends become the roles and permissions the application understands, and does a caller's principal satisfy a requirement? A role or permission is a plain string the application defines (`"admin"`, `"invoice:read"`), a principal is a plain `{ roles, permissions }` object, and every check is a pure, synchronous function. The package never talks to an identity provider, holds no mutable state, and ships no default names, so the same code runs unchanged on the server and in the browser.

---

## Key Features

- **Provider-agnostic vocabulary** — `Role` and `Permission` are free-form strings, so each application owns its naming scheme (the convention `resource:action`, such as `invoice:read`, keeps related capabilities grouped). The package ships no default names.
- **Pure, allocation-light evaluation** — `hasRole`, `hasPermission`, and `satisfiesAccess` are synchronous functions over plain data with exact, case-sensitive matching. They are safe to call in a hot request path or in the browser.
- **Two-phase claim translation** — translate a provider identity once, store the resulting `AccessPrincipal` on the session, and evaluate every later check against it. `createClaimsTranslator` performs the first phase; it does not have to run again per request.
- **Built-in claim profiles** — `genericClaimsProfile` reads OIDC-style `roles` and `permissions` arrays; `azureClaimsProfile` reads Azure Entra ID `roles`, the whitespace-delimited `scp` claim, and `groups`. Providers with other claim shapes implement the `ClaimsProfile` interface.
- **Application-owned authority** — a key declared in the application's `GrantMap` always grants its mapped values; an unmapped `role:`/`permission:` key grants only a value listed in `AllowedGrants`. Provider-specific sources (`scp:`, `group:`) never grant authority on their own.
- **Fail-closed default with an audit hook** — without an allowlist, unrecognized claims grant nothing. `onUnmapped` is called once for every key that yields no grant and receives the key name only (never a claim value), so it is safe to log.
- **Runtime-safe claim parsing** — malformed provider data is filtered, not fatal: non-array claims are ignored, non-string entries are dropped, and malformed map entries never make translation throw.
- **Untrusted-input guard** — `isOneOf` validates an `unknown` value, such as a raw claim from a token, against application-owned values and narrows it to the derived union type without a cast.
- **Zero runtime dependencies, ESM-first** — no provider SDK is bundled; the package runs on Node.js ≥ 22 and in any modern browser.

---

## When To Use

Use `blendsdk/authz` when you:

- authenticate with an external identity provider (generic OIDC, Azure Entra ID, or anything whose claims you can collect) and want authorization decisions expressed in your own vocabulary;
- want to translate the provider identity once — for example while assembling a session at sign-in — and then run many checks against the stored principal;
- need identical authorization behavior on the server (request handling) and in the browser (route guards, UI gating) over the same serializable data;
- want a small, dependency-free authorization core instead of a full IAM product, and you bring the provider integration and session storage yourself;
- want fail-closed defaults together with visibility into which provider claims you have not mapped yet.

The package is deliberately not a fit when you need it to authenticate users, call the identity provider, mint or refresh tokens, or persist sessions — it performs none of those. You assemble the `ProviderIdentity` from claims you already hold; everything after that is vocabulary, translation, and evaluation.

---

## Architecture

The package is layered so provider-specific details stay at the edges: only claim profiles know how a provider names its claims, and everything downstream operates on canonical, plain data. There is no class hierarchy and no global state, and importing the package has no side effects — all behavior composes from the exported functions and type-only interfaces.

### Claim translation (once per identity)

```text
ProviderIdentity
  │  userInfo · idTokenClaims · accessTokenClaims · scopes
  ▼
ClaimsProfile.extract            genericClaimsProfile │ azureClaimsProfile │ custom
  │  namespaced keys — "role:admin" · "scp:Invoice.Read" · "group:Finance"
  ▼
resolveGrants / createClaimsTranslator            GrantMap + AllowedGrants (+ onUnmapped)
  │  canonical grants — de-duplicated, first-seen order
  ▼
AccessPrincipal { roles, permissions }
```

- `ProviderIdentity` is the raw material: `userInfo` is required; `idTokenClaims`, `accessTokenClaims`, and `scopes` are optional. Profiles read claims across the three claim sources with the merge order `userInfo` → `idTokenClaims` → `accessTokenClaims`, so the access token wins when sources disagree; arrays are replaced, not merged, across sources.
- `ClaimsProfile.extract` reports each claim as a namespaced key: `role:` and `permission:` for canonical claims, `scp:` and `group:` for Azure scope and directory-group claims. The exported `grantKey` helper produces this `source:value` format for custom profiles.
- `resolveGrants` is the pure aggregation step; `createClaimsTranslator` wraps it with a profile and options, including the `onUnmapped` audit callback.
- Malformed input never throws: a claim that is not an array of strings, or a map entry that is not an object of string arrays, contributes nothing.

### Evaluation (every check)

```text
AccessPrincipal + AccessRequirement ──► satisfiesAccess ──► boolean
                                        hasRole / hasPermission
```

- `hasRole` and `hasPermission` are exact, case-sensitive membership checks.
- `satisfiesAccess` combines the requirement's `roles` and `permissions` into one result set and applies `mode`: `"any"` (the default) passes when at least one value is held; `"all"` passes only when every listed value is held.
- An absent or empty requirement is always satisfied, so an unconfigured rule never accidentally locks users out.

### Authority model

Translation keeps authority with the application:

1. **Mapped keys are trusted.** A key the application declares in its `GrantMap` always grants its mapped values — that is how provider labels such as `group:Finance` or `scp:Invoice.Read` become canonical roles and permissions. Mapped values are not subject to the allowlist.
2. **Unmapped keys are gated by the allowlist.** A `role:` or `permission:` key with no map entry grants a value only when the application lists that value in `AllowedGrants`.
3. **Provider sources are never canonical.** `scp:` and `group:` keys never grant authority on their own, whatever the allowlist contains; they must be mapped explicitly.
4. **No allowlist means fail closed.** When `AllowedGrants` is absent, unmapped keys grant nothing.

The `onUnmapped` callback fires for exactly the keys that yield no grant — a mapped key never triggers it, even when its mapped values are empty.

### Layers

| Layer | Public exports | Notes |
| --- | --- | --- |
| Vocabulary | `Role`, `Permission`, `AccessPrincipal`, `AccessRequirement`, `AccessMode`, `AllowedGrants`, `ProviderIdentity`, `GrantSource`, `GrantMap`, `ClaimsProfile`, `ClaimsTranslator`, `TranslatorOptions` | Type-only; erased at runtime |
| Guards | `isOneOf` | Narrows an untrusted `unknown` to an application union |
| Evaluation | `hasRole`, `hasPermission`, `satisfiesAccess` | Pure, exact-match, case-sensitive |
| Translation | `grantKey`, `resolveGrants`, `createClaimsTranslator` | Pure aggregation; fails closed |
| Profiles | `genericClaimsProfile`, `azureClaimsProfile` | OIDC and Azure Entra ID claim readers |

### Design patterns

| Pattern | Where it appears | What it provides |
| --- | --- | --- |
| Strategy | `ClaimsProfile`, implemented by `genericClaimsProfile`, `azureClaimsProfile`, or an application-defined profile | Interchangeable claim readers; translation never knows which provider authenticated the caller |
| Factory | `createClaimsTranslator(profile, map, options)` | A reusable `ClaimsTranslator` closed over the profile, grant map, and options |
| Adapter | The claim profiles | Adapt provider-specific claim shapes (`roles`, `scp`, `groups`) onto the canonical namespaced-key format |
| Value object | `AccessPrincipal`, `AccessRequirement`, `GrantMap` | Structurally typed, serializable plain data — safe on a session, across JSON, or in a client bundle |
| Type guard | `isOneOf` | Narrows an untrusted `unknown` to the application's derived union |
| Fail-closed default | `TranslatorOptions.allowed` | Absent allowlist plus unmapped claim yields no grant |

---

## Dependencies

### Runtime dependencies

None. The manifest declares no `dependencies` and no `peerDependencies`; the code uses only ECMAScript built-ins (`Object.hasOwn`, `Array.isArray`, string operations) and its own types. There is nothing to install alongside it, nothing to configure at import time, and no Node-specific API in the runtime code, which is what lets the same build run on Node.js ≥ 22 and in the browser. The package is ESM-only (`"type": "module"`, a single export map with `types` and `import` conditions).

### Development dependencies

| Package | Purpose |
| --- | --- |
| `typescript` | Strict compilation of `src/` to `dist/` via `tsc` |
| `vitest` | Test runner over specification tests (derived from requirements) and implementation tests (written after the code) |
| `@vitest/coverage-v8` | V8 coverage reporting (`npm run test:coverage`) |
| `@types/node` | Node.js typings for the toolchain |

### Dependents

Within the BlendSDK monorepo `blendsdk/authz` is a leaf: it depends on nothing, so any package or application layer can depend on it without creating a cycle. It is marked `"private": true` and ships as part of the `blendsdk` umbrella package rather than as a standalone npm artifact. Typical consumers are the layers that make access decisions — session assembly after sign-in, request-scoped checks on the server, and UI gating in the browser — all sharing one `AccessPrincipal` shape. License: MIT, like the rest of the project.

---

## Minimum Example

The shortest complete example of the core loop: build a translator, translate an identity into a principal, and evaluate a requirement.

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";

const ROLES = { Admin: "admin" } as const;
const PERMISSIONS = { InvoiceRead: "invoice:read" } as const;

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: [ROLES.Admin] } },
    { allowed: { roles: Object.values(ROLES), permissions: Object.values(PERMISSIONS) } }
);

const principal = translator.translate({
    userInfo: { roles: ["app-admin"], permissions: ["invoice:read"] },
});
// principal → { roles: ["admin"], permissions: ["invoice:read"] }

satisfiesAccess(principal, { permissions: [PERMISSIONS.InvoiceRead] }); // true
```

What happens:

1. `genericClaimsProfile` turns the identity into the namespaced keys `role:app-admin` and `permission:invoice:read`.
2. `role:app-admin` is declared in the grant map, so it grants the canonical `admin` role.
3. `permission:invoice:read` has no map entry but appears in `allowed.permissions`, so it grants the `invoice:read` permission.
4. `satisfiesAccess` finds the required permission on the principal and returns `true`.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
