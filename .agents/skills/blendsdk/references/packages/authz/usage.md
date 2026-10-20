> **Package**: `blendsdk/authz`

# authz Core Concepts

This document covers each core concept of `blendsdk/authz` in depth: what it is, how the mechanism works, a complete example, and a reference table. The package is entirely functional — no classes, no hidden state — so the concepts compose: an application defines its [vocabulary](#access-vocabulary-roles-permissions-and-principals), a [provider identity](#provider-identity-and-claim-precedence) becomes an `AccessPrincipal` through [claim profiles](#claim-profiles), [namespaced keys](#namespaced-grant-keys), and [translation](#grant-translation-and-the-authority-model), and every later check runs through [evaluation](#access-requirements-and-evaluation). [isOneOf](#untrusted-input-guard-isoneof) guards values that enter from outside the application.

All examples are ESM, strict TypeScript, and complete: every block imports what it uses and can be pasted into a project as is. For a high-level tour of the package, see the Overview; for a task-oriented walkthrough, see Basic Usage.

---

## Access Vocabulary: Roles, Permissions, and Principals

### What It Is

The vocabulary layer defines what there is to grant. A `Role` is a coarse label such as `"admin"` that groups related capabilities; a `Permission` is a fine-grained capability conventionally written `resource:action`, such as `"invoice:read"`. Both are type aliases for `string`. An `AccessPrincipal` is the plain `{ roles, permissions }` object that holds a caller's grants, and it is the only input the evaluation functions read. The package ships no default names: every value in the vocabulary belongs to the application.

### How It Works

`Role` and `Permission` are plain string aliases with no runtime representation and no registry, so there is nothing to register or configure at import time. Every comparison the library performs is exact and case-sensitive, which means `"Admin"` and `"admin"` are different roles. Applications typically declare their vocabulary once as `const` objects with `as const`, producing literal types that can be shared between the server and the browser.

`AccessPrincipal` holds two readonly arrays — `roles` and `permissions`. It is serializable plain data with no methods and no prototype requirements, so a principal can be stored on a session, survive a JSON round-trip, and be re-evaluated in the browser. Evaluation never cares how the principal was assembled — [translated from provider claims](#grant-translation-and-the-authority-model) or constructed by any other means.

### Complete Example

```typescript
import { hasPermission, hasRole } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const ROLES = { Admin: "admin", Finance: "finance" } as const;
const PERMISSIONS = {
    InvoiceRead: "invoice:read",
    InvoiceWrite: "invoice:write",
} as const;

const principal: AccessPrincipal = {
    roles: [ROLES.Admin, ROLES.Finance],
    permissions: [PERMISSIONS.InvoiceRead],
};

hasRole(principal, ROLES.Admin); // true
hasRole(principal, "editor"); // false — unknown values are simply not held
hasPermission(principal, PERMISSIONS.InvoiceRead); // true
hasPermission(principal, PERMISSIONS.InvoiceWrite); // false
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `Role` | `type Role = string` | A coarse label that groups related permissions; free-form and application-defined. |
| `Permission` | `type Permission = string` | A fine-grained capability, conventionally written `resource:action`. |
| `AccessPrincipal` | `interface` | The grants a principal holds; the only input evaluation reads. |
| `AccessPrincipal.roles` | `readonly Role[]` | The roles the principal holds. |
| `AccessPrincipal.permissions` | `readonly Permission[]` | The permissions the principal holds. |

---

## Access Requirements and Evaluation

### What It Is

The evaluation layer answers one question: does a principal satisfy a requirement? An `AccessRequirement` describes the check — optional `roles`, optional `permissions`, and a `mode` that decides how the two lists combine — and `satisfiesAccess` evaluates the whole requirement in one call. `hasRole` and `hasPermission` are the single-value membership checks that requirement evaluation is built from, and they are exported for call sites that need only one lookup.

### How It Works

`hasRole` and `hasPermission` perform an exact, case-sensitive membership test over the principal's arrays; duplicates in the principal change nothing. `satisfiesAccess` normalizes missing lists to empty arrays and treats an absent or empty requirement as always satisfied — an unconfigured rule never locks users out. Otherwise, every listed role and permission produces a membership result, and the flattened results combine according to `mode`:

- `"any"` (the default) — the principal must hold at least one of the listed roles or permissions. Roles and permissions are considered together, so holding a listed role satisfies a requirement that also lists permissions.
- `"all"` — the principal must hold every listed role and permission across both lists.

All three functions are pure, synchronous, and allocation-light, so they are safe to call in a hot request path or in the browser. Matching is exact: `"invoice:read:extra"` does not satisfy `"invoice:read"`.

### Complete Example

```typescript
import { hasPermission, hasRole, satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read"],
};

hasRole(principal, "finance"); // true
hasPermission(principal, "invoice:write"); // false

const canReadInvoices: AccessRequirement = {
    permissions: ["invoice:read", "invoice:write"],
};

const canWriteAndAudit: AccessRequirement = {
    mode: "all",
    permissions: ["invoice:write", "audit:read"],
};

satisfiesAccess(principal, canReadInvoices); // true — "any" is the default
satisfiesAccess(principal, canWriteAndAudit); // false — "invoice:write" is not held
satisfiesAccess(principal, {}); // true — an empty requirement is always satisfied
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `hasRole(principal, role)` | `(principal: AccessPrincipal, role: Role) => boolean` | Returns `true` when the principal holds `role`; exact and case-sensitive. |
| `hasPermission(principal, permission)` | `(principal: AccessPrincipal, permission: Permission) => boolean` | Returns `true` when the principal holds `permission`; exact and case-sensitive. |
| `satisfiesAccess(principal, requirement)` | `(principal: AccessPrincipal, requirement: AccessRequirement) => boolean` | Evaluates the full requirement; an absent or empty requirement is satisfied. |
| `AccessRequirement.roles` | `readonly Role[] \| undefined` | Roles the principal must hold, subject to `mode`. |
| `AccessRequirement.permissions` | `readonly Permission[] \| undefined` | Permissions the principal must hold, subject to `mode`. |
| `AccessRequirement.mode` | `AccessMode \| undefined` | How the two lists combine; defaults to `"any"`. |
| `AccessMode` | `"any" \| "all"` | `"any"`: at least one value; `"all"`: every value. |

---

## Provider Identity and Claim Precedence

### What It Is

`ProviderIdentity` is the raw material translation consumes: everything the application collected from the identity provider about one caller. `userInfo` — typically the OIDC `/userinfo` response — is required; `idTokenClaims`, `accessTokenClaims`, and `scopes` are optional because different providers and sign-in flows supply different subsets.

### How It Works

The package never contacts the provider, decodes a token, or refreshes credentials; the application assembles the identity from tokens it already holds. Profiles read claims from the three claim sources with the merge order `userInfo` → `idTokenClaims` → `accessTokenClaims`: when several sources define the same claim, the access token wins. The replacement is per claim — a later source's array replaces an earlier source's array wholesale rather than concatenating with it. Each claim is resolved independently, though, so a profile can read one claim from the access token while another claim falls back to user info. The `scopes` field carries the OAuth scopes granted to the access token; no built-in profile reads it, but a custom profile can. Claim values are deliberately typed as `unknown`: [profiles](#claim-profiles) narrow them and drop malformed values instead of trusting the provider's shape.

### Complete Example

```typescript
import { genericClaimsProfile } from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

const identity: ProviderIdentity = {
    userInfo: { roles: ["user"], permissions: ["invoice:read"] },
    idTokenClaims: { roles: ["editor"] },
    accessTokenClaims: { roles: ["admin"] },
};

genericClaimsProfile.extract(identity);
// ["role:admin", "permission:invoice:read"]
//  - "roles": the access token wins over the identity token and user info.
//  - "permissions": resolved independently from user info, the only source carrying it.
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `ProviderIdentity.userInfo` | `Record<string, unknown>` | User info returned by the provider, such as the OIDC `/userinfo` response. Required. |
| `ProviderIdentity.idTokenClaims` | `Record<string, unknown> \| undefined` | Claims decoded from the OIDC identity token, when one is available. |
| `ProviderIdentity.accessTokenClaims` | `Record<string, unknown> \| undefined` | Claims decoded from the access token; wins on claim conflicts. |
| `ProviderIdentity.scopes` | `readonly string[] \| undefined` | OAuth scopes granted to the access token; read by custom profiles only. |

---

## Claim Profiles

### What It Is

A claim profile is the adapter between one identity provider's claim shapes and the package's namespaced key vocabulary. `genericClaimsProfile` covers OIDC-style providers that emit `roles` and `permissions` arrays; `azureClaimsProfile` covers Azure Entra ID's `roles`, `scp`, and `groups` claims. A provider that matches neither implements the `ClaimsProfile` interface.

### How It Works

`ClaimsProfile.extract(identity)` reads a `ProviderIdentity` and returns [namespaced keys](#namespaced-grant-keys) — it reports what the provider said and nothing more. Deciding which keys confer authority happens later, in [translation](#grant-translation-and-the-authority-model). Both built-ins resolve claims with the [precedence rules](#provider-identity-and-claim-precedence) and filter malformed shapes rather than throwing: a claim that is not an array is ignored, and non-string entries inside an array are dropped.

- `genericClaimsProfile` reads the `roles` array into `role:` keys and the `permissions` array into `permission:` keys — nothing else.
- `azureClaimsProfile` reads the `roles` array into `role:` keys, splits the whitespace-delimited `scp` string into one `scp:` key per scope (empty segments are skipped), and reads the `groups` array into `group:` keys. It never emits `permission:` keys, because Azure scopes are not application permissions; an application grants permissions by mapping `scp:` and `group:` keys in its grant map.

A custom profile implements the same two members: `name` is a human-readable label, and `extract` returns the keys. Profiles should be pure — a function of the identity alone — because translators call them during every translation and tests can substitute them freely. Use the exported `grantKey` to build keys so the `source:value` format stays consistent.

### Complete Example

```typescript
import { azureClaimsProfile, grantKey } from "blendsdk/authz";
import type { ClaimsProfile, ProviderIdentity } from "blendsdk/authz";

// Built-in profile: Azure Entra ID claims become role:, scp:, and group: keys.
azureClaimsProfile.extract({
    userInfo: {},
    accessTokenClaims: {
        roles: ["App.Admin"],
        scp: "Invoice.Read Invoice.Write",
        groups: ["Finance"],
    },
});
// ["role:App.Admin", "scp:Invoice.Read", "scp:Invoice.Write", "group:Finance"]

// Custom profile: a provider whose directory claims use its own names.
const directoryProfile: ClaimsProfile = {
    name: "directory",
    extract(identity: ProviderIdentity): readonly string[] {
        const keys: string[] = [];

        const department = identity.userInfo["department"];
        if (typeof department === "string" && department.length > 0) {
            keys.push(grantKey("role", department));
        }

        const entitlements = identity.userInfo["entitlements"];
        if (Array.isArray(entitlements)) {
            for (const entry of entitlements) {
                if (typeof entry === "string") {
                    keys.push(grantKey("permission", entry));
                }
            }
        }

        return keys;
    },
};

directoryProfile.extract({
    userInfo: {
        department: "finance",
        entitlements: ["invoice:read", "invoice:write"],
    },
});
// ["role:finance", "permission:invoice:read", "permission:invoice:write"]
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `ClaimsProfile.name` | `readonly string` | Human-readable profile name, for example `"generic"` or `"azure"`. |
| `ClaimsProfile.extract(identity)` | `(identity: ProviderIdentity) => readonly string[]` | Returns the namespaced keys found in the identity. |
| `genericClaimsProfile` | `ClaimsProfile` | Reads `roles` and `permissions` arrays; emits `role:` and `permission:` keys. |
| `azureClaimsProfile` | `ClaimsProfile` | Reads `roles`, the whitespace-delimited `scp` string, and `groups`; emits `role:`, `scp:`, and `group:` keys — never `permission:`. |

---

## Namespaced Grant Keys

### What It Is

A namespaced grant key is the `source:value` string that a profile reports and translation consumes — for example `role:admin`, `permission:invoice:read`, `scp:Invoice.Read`, or `group:Finance`. `grantKey` is the helper that produces the format, and `GrantSource` enumerates its four sources.

### How It Works

`grantKey(source, value)` joins a claim family and a raw value with a single colon. A key is split at the first colon only, so values may contain colons of their own: `permission:invoice:read` parses as source `permission` plus value `invoice:read`, and `role:a:b` grants the role value `a:b`. A key without a colon is malformed — translation ignores it, and a translator built with `onUnmapped` reports it. The source also decides what a key may ever grant: `role:` and `permission:` are canonical and eligible for direct grants through the allowlist, while `scp:` and `group:` are provider-specific and grant only through an explicit [grant map](#grant-translation-and-the-authority-model). Keys are plain strings on purpose: a key can cross any boundary — a log line, a cache entry, a queue message — without carrying structures.

### Complete Example

```typescript
import { grantKey, resolveGrants } from "blendsdk/authz";
import type { GrantSource } from "blendsdk/authz";

const source: GrantSource = "role";
grantKey(source, "admin"); // "role:admin"
grantKey("scp", "Invoice.Read"); // "scp:Invoice.Read"
grantKey("group", "Finance"); // "group:Finance"
grantKey("permission", "invoice:read"); // "permission:invoice:read"

// Only the first colon separates source from value, so values may contain colons.
resolveGrants(["permission:invoice:read"], {}, { permissions: ["invoice:read"] });
// { roles: [], permissions: ["invoice:read"] }
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `grantKey(source, value)` | `(source: GrantSource, value: string) => string` | Joins a source and a value into a namespaced key, for example `role:admin`. |
| `GrantSource` | `"role" \| "scp" \| "group" \| "permission"` | The claim family a key came from; `role`/`permission` are canonical, `scp`/`group` are provider-specific. |
| Key format | `${source}:${value}` | Split at the first colon only, so the value may contain colons. |

---

## Grant Translation and the Authority Model

### What It Is

Translation turns [namespaced keys](#namespaced-grant-keys) into the canonical `AccessPrincipal` a caller holds. `resolveGrants` is the pure aggregation step from keys to grants; `createClaimsTranslator` is the factory most applications use, pairing a [claim profile](#claim-profiles) with a grant map and options. Everything authority-related in the package lives here: the application, not the identity provider, decides which provider labels become roles and permissions.

### How It Works

For every key, translation applies the same rules, in order:

1. **A mapped key is trusted.** If the key is an own property of the `GrantMap`, its mapped roles and permissions are granted immediately. The map is trusted application configuration, so mapped values are exempt from the allowlist — this is how a provider label such as `group:Finance` becomes a canonical grant. A mapped key also takes precedence over its canonical fallback: `role:admin` mapped to `{ roles: ["super"] }` grants `super`, never `admin`.
2. **An unmapped canonical key is allowlisted.** A `role:` or `permission:` key with no map entry grants its value only when the application lists that value in `AllowedGrants`. A value the application does not list grants nothing.
3. **Provider-specific keys are never canonical.** `scp:` and `group:` keys grant nothing on their own, whatever the allowlist contains; they must be mapped explicitly.
4. **No allowlist means fail closed.** When `AllowedGrants` is absent, unmapped keys grant nothing at all.

The mechanics are defensive about runtime data. Granted values are filtered to strings and de-duplicated in first-seen order, so the output arrays are stable. A mapped entry that is not an object, or a list that is not an array of strings, contributes nothing rather than throwing — JSON-parsed claims and maps cannot crash a translation. Map lookups use own-property checks, so an inherited property never grants.

`createClaimsTranslator(profile, map, options)` extracts the keys, then aggregates exactly as `resolveGrants` does. When `TranslatorOptions.onUnmapped` is provided, it is called once for every key that yields no grant; a mapped key never triggers it, even when its mapped values are empty. The callback receives the key name only — never a claim value — so the key is safe to log. A translator is typically built once and called once per sign-in: store the resulting `AccessPrincipal` on the session and run every later check with [`satisfiesAccess`](#access-requirements-and-evaluation).

### Complete Example

```typescript
import {
    azureClaimsProfile,
    createClaimsTranslator,
    satisfiesAccess,
} from "blendsdk/authz";

const translator = createClaimsTranslator(
    azureClaimsProfile,
    {
        "group:Finance": { roles: ["finance"], permissions: ["invoice:read"] },
        "scp:Invoice.Write": { permissions: ["invoice:write"] },
    },
    {
        allowed: { roles: ["user"] },
        onUnmapped: (key: string): void => {
            console.warn(`No grant configured for claim key: ${key}`);
        },
    }
);

const principal = translator.translate({
    userInfo: { roles: ["user"] },
    accessTokenClaims: {
        scp: "Invoice.Write Unknown.Scope",
        groups: ["Finance"],
    },
});
// { roles: ["user", "finance"], permissions: ["invoice:write", "invoice:read"] }
// onUnmapped is called once, with "scp:Unknown.Scope".

satisfiesAccess(principal, { permissions: ["invoice:read"] }); // true
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `createClaimsTranslator(profile, map, options?)` | `(profile: ClaimsProfile, map: GrantMap, options?: TranslatorOptions) => ClaimsTranslator` | Builds a reusable translator: extracts keys, then aggregates them into a principal. |
| `resolveGrants(keys, map, allowed?)` | `(keys: readonly string[], map: GrantMap, allowed?: AllowedGrants) => AccessPrincipal` | Pure aggregation of keys into canonical grants; fails closed without `allowed`. |
| `ClaimsTranslator.translate(identity)` | `(identity: ProviderIdentity) => AccessPrincipal` | Translates one provider identity into the principal it holds. |
| `GrantMap` | `Record<string, Partial<AccessPrincipal>>` | Application configuration mapping namespaced keys to the grants they confer; trusted. |
| `AllowedGrants.roles` | `readonly Role[] \| undefined` | Canonical roles an unmapped `role:` key may grant directly. |
| `AllowedGrants.permissions` | `readonly Permission[] \| undefined` | Canonical permissions an unmapped `permission:` key may grant directly. |
| `TranslatorOptions.allowed` | `AllowedGrants \| undefined` | The allowlist for unmapped canonical keys; absent means fail closed. |
| `TranslatorOptions.onUnmapped` | `((key: string) => void) \| undefined` | Called once for every key that yields no grant; receives the key name only. |

---

## Untrusted-Input Guard: isOneOf

### What It Is

`isOneOf` is a runtime guard for values that arrive from outside the application — a claim read from a token payload, a scope passed as a request parameter. It returns `true` only for a string that appears in a list of application-owned values, and it narrows the caller's `unknown` value to the union those values form.

### How It Works

The guard checks the value's type first and membership second: a number, an object, or `null` is rejected rather than coerced, and a string must match an allowed value exactly, following the same case-sensitive comparison used everywhere else in the package. Its generic parameter is inferred from the `allowed` argument with a `const` modifier, so passing an application constant's values yields a precise union — `"admin" | "user"` — and the caller can use the narrowed value without a cast. Use it where untrusted data enters: validate a raw claim before trusting it, instead of letting a malformed value flow deeper and fail later. The guard is pure and has no runtime dependencies.

### Complete Example

```typescript
import { isOneOf } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;

// A raw value decoded from an untrusted token payload.
const raw: unknown = "admin";

if (isOneOf(raw, Object.values(ROLES))) {
    const role: "admin" | "user" = raw; // narrowed — no cast needed
    console.log(`Granting role: ${role}`);
} else {
    console.warn("Ignoring an unknown role claim.");
}

isOneOf("root", Object.values(ROLES)); // false
isOneOf(42, Object.values(ROLES)); // false — a non-string value is rejected
```

### Key Methods and Properties

| Name | Type / Signature | Description |
| --- | --- | --- |
| `isOneOf(value, allowed)` | `<const T extends string>(value: unknown, allowed: readonly T[]) => value is T` | Returns `true` only when `value` is a string present in `allowed`, narrowing `unknown` to `T`. |

---

# authz Basic Usage

This guide takes you from installing `blendsdk/authz` to a working sign-in-to-check loop. The package is small by design: you declare your own roles and permissions, translate a provider identity once, and evaluate requirements against the resulting principal with synchronous, pure functions.

---

## Installation

`blendsdk/authz` is consumed either as a workspace dependency inside the BlendSDK monorepo or through the published `blendsdk` umbrella package outside it. It is ESM-only, ships zero runtime dependencies, and has no install-time configuration — importing the package has no side effects.

### Inside the monorepo (workspace dependency)

Add the workspace dependency to the consuming package's `package.json`:

```json
{
    "dependencies": {
        "blendsdk/authz": "workspace:*"
    }
}
```

Then install from the repository root with pnpm:

```bash
pnpm install
```

### From the published umbrella package

```bash
# npm
npm install blendsdk

# yarn
yarn add blendsdk

# pnpm
pnpm add blendsdk
```

### Requirements

- **Node.js ≥ 22.0.0** for tooling. The runtime code uses only ECMAScript built-ins (`Object.hasOwn`, `Array.isArray`, string operations), so the same build also runs in the browser.
- **ESM project** that resolves the `import` condition. The export map exposes only `types` and `import`, so `require()` is not supported — always import with `import { ... } from "blendsdk/authz"`.
- **TypeScript in strict mode** is recommended. `ProviderIdentity.userInfo` is required, and the type checker catches missing or misspelled requirements before runtime.

---

## Quick Start

The whole loop is three steps: build a translator once, translate the provider identity into a principal, and evaluate requirements against it.

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";

const ROLES = { Admin: "admin" } as const;

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: [ROLES.Admin] } }
);

const principal = translator.translate({ userInfo: { roles: ["app-admin"] } });
// { roles: ["admin"], permissions: [] }

satisfiesAccess(principal, { roles: [ROLES.Admin] }); // true
```

What just happened:

1. `createClaimsTranslator` bound the generic OIDC profile to a grant map that translates the provider label `app-admin` into your `admin` role — build this once, at startup.
2. `translate` read `userInfo.roles` and produced a canonical principal — run this once per sign-in and store the principal on the session.
3. `satisfiesAccess` answered a requirement against the stored principal — run this on every protected action.

---

## Fundamentals

### 1. Declare Your Vocabulary

You own the words before you check them. Roles and permissions are plain strings, and the package ships no default names.

```typescript
import type { AccessPrincipal, Permission, Role } from "blendsdk/authz";

const ROLES = {
    Admin: "admin",
    Finance: "finance",
} as const;

const PERMISSIONS = {
    InvoiceRead: "invoice:read",
    InvoiceWrite: "invoice:write",
} as const;

const admin: Role = ROLES.Admin;
const readInvoices: Permission = PERMISSIONS.InvoiceRead;

const principal: AccessPrincipal = {
    roles: [admin, ROLES.Finance],
    permissions: [readInvoices],
};

hasRoleAndPermission(principal); // see the next subsection for the checks

function hasRoleAndPermission(candidate: AccessPrincipal): boolean {
    return candidate.roles.length > 0 && candidate.permissions.length > 0;
}
```

What to keep in mind:

- `Role` and `Permission` are type aliases of `string` — there is nothing to register and no registry to keep in sync. The convention `resource:action` (such as `invoice:read`) keeps related capabilities grouped.
- Every comparison in the package is exact and case-sensitive: `"Admin"` and `"admin"` are different roles.
- `AccessPrincipal` is a serializable `{ roles, permissions }` object with no methods, so it crosses a session store or a JSON boundary unchanged.
- Declaring the vocabulary as `as const` objects produces literal types such as `"admin" | "finance"` that the server and the browser can share from one module.

### 2. Evaluate a Requirement

Evaluation answers one question — does the principal satisfy the requirement? — with two single-value helpers and one full-requirement function.

```typescript
import { hasPermission, hasRole, satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read"],
};

hasRole(principal, "finance"); // true
hasPermission(principal, "invoice:read"); // true
hasPermission(principal, "invoice:write"); // false

// "any" is the default: at least one listed value, with roles and permissions combined.
satisfiesAccess(principal, { permissions: ["invoice:read", "invoice:write"] }); // true

// "all": every listed role and permission must be held.
const requirement: AccessRequirement = {
    mode: "all",
    roles: ["finance"],
    permissions: ["invoice:read", "invoice:write"],
};
satisfiesAccess(principal, requirement); // false — "invoice:write" is not held

// An absent or empty requirement is always satisfied.
satisfiesAccess(principal, {}); // true
```

What to keep in mind:

- Matching is exact: `"invoice:read:extra"` does not satisfy `"invoice:read"`.
- `hasRole` and `hasPermission` check one value; `satisfiesAccess` checks a whole requirement and is what most call sites should use.
- An empty requirement is satisfied by design, so an unconfigured rule never accidentally locks users out.
- All three functions are pure, synchronous, and allocation-light — safe in a hot request path, a route guard, or a component render.

### 3. Translate a Provider Identity

Translation is the bridge from what the provider said to what your application grants. A claim profile reads the identity into namespaced keys; the translator turns those keys into your vocabulary.

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
} from "blendsdk/authz";
import type { AccessPrincipal, ProviderIdentity } from "blendsdk/authz";

const ROLES = { Admin: "admin" } as const;

// The identity your sign-in flow assembled from the provider response and tokens.
const identity: ProviderIdentity = {
    userInfo: {
        roles: ["app-admin"],
        permissions: ["invoice:read"],
    },
};

// Step 1 — see what the profile reports: namespaced keys, nothing more.
genericClaimsProfile.extract(identity);
// ["role:app-admin", "permission:invoice:read"]

// Step 2 — bind the profile to a grant map and an allowlist.
const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: [ROLES.Admin] } },
    { allowed: { permissions: ["invoice:read"] } }
);

// Step 3 — translate once per identity.
const principal: AccessPrincipal = translator.translate(identity);
// { roles: ["admin"], permissions: ["invoice:read"] }
```

What to keep in mind:

- `userInfo` is required; `idTokenClaims`, `accessTokenClaims`, and `scopes` are optional. The built-in profiles merge claims per claim with the order `userInfo` → `idTokenClaims` → `accessTokenClaims`, so the access token wins when sources disagree, and each claim resolves independently.
- Build the translator once and reuse it; it holds no per-request state. Store the resulting `AccessPrincipal` on the session — later checks never need the profile again.
- `genericClaimsProfile` reads OIDC-style `roles` and `permissions` arrays. If a claim is not an array of strings, it is ignored rather than fatal.

### 4. Map Provider Labels to Your Vocabulary

The grant map is where provider labels become your terms. It is trusted application configuration: a listed key always grants its mapped roles and permissions.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const translator = createClaimsTranslator(genericClaimsProfile, {
    "role:app-admin": { roles: ["admin"], permissions: ["audit:read"] },
    "role:app-editor": { roles: ["editor"], permissions: ["invoice:read"] },
});

translator.translate({ userInfo: { roles: ["app-editor", "app-admin"] } });
// { roles: ["editor", "admin"], permissions: ["invoice:read", "audit:read"] }
```

What to keep in mind:

- Mapped values bypass the allowlist — the map is the application speaking, not the provider.
- A mapped key takes precedence over its canonical fallback: mapping `"role:admin"` to `{ roles: ["super-admin"] }` grants `super-admin`, never `admin`.
- Grants are de-duplicated in first-seen order, so the output arrays are stable.
- A mapped entry with empty values grants nothing but still counts as mapped (it never triggers the audit callback introduced next).
- `resolveGrants` is the same aggregation step without a profile, useful when you already hold namespaced keys:

```typescript fragment
resolveGrants(["group:Finance"], { "group:Finance": { roles: ["finance"] } });
// { roles: ["finance"], permissions: [] }
```

### 5. Fail Closed and Audit Unmapped Keys

Unmapped keys are gated by the allowlist, and the default is to grant nothing. The `onUnmapped` callback shows you exactly which claims you have not mapped yet.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: ["admin"] } },
    {
        allowed: {
            roles: ["user"],
            permissions: ["invoice:read"],
        },
        onUnmapped: (key: string): void => {
            console.warn(`authz: no grant configured for claim key "${key}"`);
        },
    }
);

const principal = translator.translate({
    userInfo: {
        roles: ["app-admin", "user", "app-owner"],
        permissions: ["invoice:read", "invoice:write"],
    },
});
// keys:      role:app-admin  | role:user    | role:app-owner  | permission:invoice:read | permission:invoice:write
// grants:    admin (mapped) | user (allow) | — (reported)    | invoice:read (allowed)  | — (reported)
// principal: { roles: ["admin", "user"], permissions: ["invoice:read"] }
```

What to keep in mind:

- An unmapped `role:` or `permission:` key grants a value only when the value appears in `allowed`. Without `allowed`, unmapped keys grant nothing at all — translation fails closed.
- Provider-specific keys (`scp:`, `group:`) never grant authority on their own, whatever the allowlist contains; they must be mapped explicitly.
- `onUnmapped` is called once per key that yields no grant and receives the key name only — never a claim value — so it is safe to log in production.

### 6. Read Azure Entra ID Claims

For Azure Entra ID, `azureClaimsProfile` reads `roles`, the whitespace-delimited `scp` scope claim, and `groups`, and emits `role:`, `scp:`, and `group:` keys.

```typescript
import {
    azureClaimsProfile,
    createClaimsTranslator,
    satisfiesAccess,
} from "blendsdk/authz";

const translator = createClaimsTranslator(
    azureClaimsProfile,
    {
        "group:Finance": { roles: ["finance"], permissions: ["invoice:read"] },
        "scp:Invoice.Write": { permissions: ["invoice:write"] },
    },
    { allowed: { roles: ["user"] } }
);

const principal = translator.translate({
    userInfo: { roles: ["user"] },
    accessTokenClaims: {
        scp: "Invoice.Write Unknown.Scope",
        groups: ["Finance"],
    },
});
// { roles: ["user", "finance"], permissions: ["invoice:write", "invoice:read"] }

satisfiesAccess(principal, { permissions: ["invoice:read"] }); // true
```

What to keep in mind:

- The Azure profile never emits `permission:` keys, because Azure scopes are not application permissions — scopes and groups grant only through your map.
- The `scp` string is split on whitespace and empty segments are skipped. `scp:Unknown.Scope` yields no grant and (with `onUnmapped` configured) would be reported for mapping.
- Claim precedence applies per claim: `roles` resolved from `userInfo` above, while `scp` and `groups` came from the access token.

### 7. Validate Untrusted Values with isOneOf

When a raw value arrives from outside the application — a claim read from a token, a scope passed as a request parameter — validate it against your own vocabulary before trusting it.

```typescript
import { isOneOf } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;

function normalizeRole(value: unknown): "admin" | "user" | undefined {
    if (isOneOf(value, Object.values(ROLES))) {
        return value; // narrowed to "admin" | "user" — no cast needed
    }
    return undefined;
}

normalizeRole("admin"); // "admin"
normalizeRole("root"); // undefined — not an application value
normalizeRole(42); // undefined — not a string
```

What to keep in mind:

- The guard checks the type first and membership second, so a number, an object, or `null` is rejected rather than coerced.
- It narrows the caller's `unknown` value to the literal union formed by the allowed values, following the same exact, case-sensitive matching used everywhere else.
- It returns `false` instead of throwing; decide the safe default — usually deny — in the `else` branch.

---

## Configuration

Everything configurable lives in the translator options and the requirement, and both are plain objects. A complete configuration:

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: ["admin"] } },
    {
        allowed: {
            roles: ["user"],
            permissions: ["invoice:read"],
        },
        onUnmapped: (key: string): void => {
            console.warn(`Unmapped claim key: ${key}`);
        },
    }
);
```

### Options and Defaults

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `TranslatorOptions.allowed` | `AllowedGrants \| undefined` | `undefined` | Canonical values an unmapped `role:`/`permission:` key may grant. Omitting it fails closed: unmapped keys grant nothing. |
| `TranslatorOptions.allowed.roles` | `readonly Role[] \| undefined` | `undefined` | Canonical roles eligible for direct grants from a `role:` key. |
| `TranslatorOptions.allowed.permissions` | `readonly Permission[] \| undefined` | `undefined` | Canonical permissions eligible for direct grants from a `permission:` key. |
| `TranslatorOptions.onUnmapped` | `((key: string) => void) \| undefined` | `undefined` | Called once for every key that yields no grant. Receives the key name only — never a claim value — so it is safe to log. |
| `AccessRequirement.mode` | `AccessMode \| undefined` | `"any"` | How a requirement combines `roles` and `permissions`: `"any"` needs one value, `"all"` needs every value. |

### Fixed Behavior (not configurable)

- Claim merge order in the built-in profiles: `userInfo` → `idTokenClaims` → `accessTokenClaims`; the access token wins per claim, and each claim resolves independently.
- Matching is exact and case-sensitive everywhere.
- An absent or empty `AccessRequirement` is always satisfied.
- `scp:` and `group:` keys never grant authority without a map entry, whatever the allowlist contains.
- The `GrantMap` argument has no default — pass at least `{}` to make the fail-closed intent explicit.
- Translators hold no per-request state. Build the one you need at startup and reuse it; create separate translators when different applications need different maps or allowlists.

---

## Error Handling

`blendsdk/authz` defines no error classes, and none of its exported functions throw or reject a promise for bad input. That is deliberate: a malformed provider claim must not crash a sign-in or a request. Failures are represented as values instead — evaluation returns `false`, translation produces smaller (or empty) grants, and `isOneOf` returns `false`.

**Error types**: none. There is nothing to `catch` or `instanceof`-check. The outcomes worth handling are:

| Situation | What happens | How to observe it |
| --- | --- | --- |
| A claim is not an array of strings (or malformed otherwise) | The profile ignores it; no keys and no grants | `onUnmapped` is *not* called — log `profile.extract(identity)` output during rollout if you need visibility into dropped claims |
| A key yields no grant (unmapped and not allowlisted, or a provider-specific key with no map entry) | The key contributes nothing; translation fails closed | `onUnmapped(key)` |
| No `allowed` allowlist is supplied | Every unmapped key grants nothing | `onUnmapped(key)` |
| A requirement is not satisfied | `satisfiesAccess`, `hasRole`, and `hasPermission` return `false` | The return value — branch or deny |
| The requirement is absent or empty | Always satisfied by design — an unconfigured rule cannot lock users out | Review requirement construction if that is not the intent |
| An untrusted value has the wrong type | `isOneOf` returns `false` and performs no narrowing | The `else` branch of the check |

**The only code that can throw is code you supply.** `translator.translate` calls a `ClaimsProfile.extract` implementation and the `onUnmapped` callback directly, without a guard. The built-in profiles are total (they filter malformed data rather than throwing), but a custom profile that parses JSON, hits a database, or otherwise does risky work must catch its own failures — or you guard the call:

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";
import type { AccessPrincipal, ProviderIdentity } from "blendsdk/authz";

const translator = createClaimsTranslator(genericClaimsProfile, {}, {
    allowed: { roles: ["user"] },
});

/** Translates an identity; falls back to no grants when translation fails. */
function translateOrDeny(identity: ProviderIdentity): AccessPrincipal {
    try {
        return translator.translate(identity);
    } catch (error: unknown) {
        console.error("Authorization translation failed; denying access.", error);
        return { roles: [], permissions: [] };
    }
}

const principal = translateOrDeny({ userInfo: { roles: ["user"] } });
// { roles: ["user"], permissions: [] }
```

Two more practices for a robust integration:

- **Deny with an empty principal.** `{ roles: [], permissions: [] }` satisfies no non-empty requirement, so it is the safe fallback when translation cannot complete.
- **Validate before translating.** `ProviderIdentity.userInfo` is required, which TypeScript enforces at compile time. When an identity crosses a JSON boundary (for example, when restored from a session store), validate its shape with the same discipline `isOneOf` applies to single values before calling `translate`.
- **Watch `onUnmapped` in production.** Every logged key is a claim you have not mapped yet — the report tells you exactly which grant-map entries or allowlist values to add next, and because only key names are logged, the output is safe to keep.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
