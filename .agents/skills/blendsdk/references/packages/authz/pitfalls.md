> **Package**: `blendsdk/authz`

# authz Best Practices

`blendsdk/authz` is built on a handful of deliberate decisions, and most mistakes with the package are one of those decisions read backwards. Translation merges provider claims once per identity; the resulting principal is plain data that evaluation trusts unconditionally. The `GrantMap` is trusted application configuration — which is why mapped keys bypass the allowlist. `mode` defaults to `"any"`. An empty requirement is satisfied. This document turns those decisions into practices: paired wrong/right examples, the anti-patterns they prevent, performance guidance, and the security considerations that follow from them.

---

## Do / Don't Pairs

Each practice below pairs a wrong approach with the right one and explains *why* the wrong one is problematic. Every block is valid TypeScript — the mistakes shown are architectural, not syntactic.

| # | Practice | In one line |
| --- | --- | --- |
| 1 | Translate once, evaluate everywhere | Translation runs at sign-in; checks read the stored principal. |
| 2 | Static, app-owned grant configuration | Never build the `GrantMap` or `AllowedGrants` from request data. |
| 3 | Guard untrusted values with `isOneOf` | Narrow with a runtime check, never with an `as` cast. |
| 4 | Explicit `mode` | Write `mode: "all"` whenever every value must hold. |
| 5 | Deliberate requirements | An empty requirement is satisfied — decide that on purpose. |
| 6 | Provider keys stay provider-namespaced | Map `scp:`/`group:` keys; never promote them to canonical. |
| 7 | One shared vocabulary | `as const` constants prevent casing and typo drift. |

---

### 1. Translate Once at Sign-In, Evaluate Everywhere

**❌ Wrong**

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

const ROLES = { Admin: "admin" } as const;

export function handleRequest(identity: ProviderIdentity): boolean {
    // Rebuilds the translator and re-translates the identity on every request.
    const translator = createClaimsTranslator(
        genericClaimsProfile,
        { "role:app-admin": { roles: [ROLES.Admin] } },
        { allowed: { roles: Object.values(ROLES) } }
    );
    const principal = translator.translate(identity);

    return satisfiesAccess(principal, { roles: [ROLES.Admin] });
}
```

**✅ Correct**

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";
import type { AccessPrincipal, ProviderIdentity } from "blendsdk/authz";

const ROLES = { Admin: "admin" } as const;

// Built once; the translator closes over the profile, map, and options.
const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: [ROLES.Admin] } },
    { allowed: { roles: Object.values(ROLES) } }
);

// Once per sign-in: the provider identity becomes the session principal.
export function buildSessionPrincipal(identity: ProviderIdentity): AccessPrincipal {
    return translator.translate(identity);
}

// Every later check reads the stored principal, not the raw claims.
export function canAdminister(principal: AccessPrincipal): boolean {
    return satisfiesAccess(principal, { roles: [ROLES.Admin] });
}
```

**Why this matters** — Translation is the claim-heavy phase: profiles merge claims across up to three sources, then aggregation walks every key with de-duplication. Evaluation is one exact membership scan per listed value over two small arrays. Paying translation cost per request (or worse, per check) buys nothing, because the principal only changes when the identity changes. The translator is stateless, so re-translating after a token refresh that carries new claims is safe; it is the per-check re-translation this practice removes. The two-phase flow also keeps one obvious home for `onUnmapped` auditing — sign-in.

---

### 2. Keep Grant Configuration Static and Application-Owned

**❌ Wrong**

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

export function buildTranslator(callerSuppliedRole: string) {
    // Trusted configuration assembled from caller-supplied input.
    const map: GrantMap = {
        [`role:${callerSuppliedRole}`]: { roles: [callerSuppliedRole] },
    };

    return createClaimsTranslator(genericClaimsProfile, map);
}
```

**✅ Correct**

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

// Module-level, application-owned configuration — reviewed like code.
const GRANT_MAP: GrantMap = {
    "role:app-admin": { roles: ["admin"] },
    "group:Finance": { roles: ["finance"], permissions: ["invoice:read"] },
};

export const translator = createClaimsTranslator(genericClaimsProfile, GRANT_MAP, {
    allowed: { roles: ["user"] },
});
```

**Why this matters** — A mapped key always grants its mapped values and is exempt from the allowlist; that exemption is exactly what makes the `GrantMap` trusted configuration. If the map is assembled from request data, the caller influences which claim keys confer authority and which values they confer — and mapped keys never consult the allowlist, so it cannot stand in the way. Keep the map in source (or in configuration you load once and control), never in per-request state.

---

### 3. Validate Untrusted Claim Values with `isOneOf`, Not Casts

**❌ Wrong**

```typescript
import type { Role } from "blendsdk/authz";

export function readRoleClaim(claims: Record<string, unknown>): Role | undefined {
    // The cast is erased at runtime; anything the token contains flows through.
    return claims["role"] as Role | undefined;
}
```

**✅ Correct**

```typescript
import { isOneOf } from "blendsdk/authz";
import type { Role } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;

export function readRoleClaim(claims: Record<string, unknown>): Role | undefined {
    const raw: unknown = claims["role"];
    return isOneOf(raw, Object.values(ROLES)) ? raw : undefined;
}
```

**Why this matters** — Claim values are `unknown` because tokens are untrusted input. A cast only silences the compiler: a number, an object, or a `"root"` string would be typed as a role and could reach a principal. `isOneOf` checks the type first (non-strings are rejected, not coerced) and then matches the application's own values exactly, so the narrowed type is *earned at runtime* — with no cast anywhere.

---

### 4. Say `mode: "all"` When Every Listed Value Must Hold

**❌ Wrong**

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const adminWithoutInvoiceWrite: AccessPrincipal = {
    roles: ["admin"],
    permissions: [],
};

// Intended as "the admin role AND invoice:write", but "any" is the default.
const requirement: AccessRequirement = {
    roles: ["admin"],
    permissions: ["invoice:write"],
};

satisfiesAccess(adminWithoutInvoiceWrite, requirement); // true — the role alone passes
```

**✅ Correct**

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const adminWithoutInvoiceWrite: AccessPrincipal = {
    roles: ["admin"],
    permissions: [],
};

const requirement: AccessRequirement = {
    mode: "all",
    roles: ["admin"],
    permissions: ["invoice:write"],
};

satisfiesAccess(adminWithoutInvoiceWrite, requirement); // false — both are required
```

**Why this matters** — In the default `"any"` mode the listed roles and permissions form one combined result set, and the requirement passes when at least one value — role *or* permission — is held. A requirement that reads as "admin and can write invoices" therefore passes for an admin who cannot write invoices. Whenever the intent is a conjunction across the lists, `mode: "all"` must be explicit.

---

### 5. Build Requirements Deliberately — an Empty Requirement Allows

**❌ Wrong**

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const CONFIGURED_PERMISSIONS: readonly string[] = []; // configuration did not load

const visitor: AccessPrincipal = { roles: [], permissions: [] };

// An empty requirement is satisfied, so the failed configuration lets everyone in.
const canReadInvoices = satisfiesAccess(visitor, { permissions: CONFIGURED_PERMISSIONS });
// canReadInvoices === true
```

**✅ Correct**

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const CONFIGURED_PERMISSIONS: readonly string[] = [];

const visitor: AccessPrincipal = { roles: [], permissions: [] };

const requirement: AccessRequirement | undefined =
    CONFIGURED_PERMISSIONS.length > 0
        ? { permissions: CONFIGURED_PERMISSIONS }
        : undefined;

// The call site decides what a missing configuration means; here it denies.
const canReadInvoices = requirement !== undefined && satisfiesAccess(visitor, requirement);
// canReadInvoices === false
```

**Why this matters** — `satisfiesAccess` treats an absent or empty requirement as satisfied, on purpose: an unconfigured rule must not lock users out. The flip side is that a requirement built from an empty list is an accidental *allow*, not an accidental deny. When a rule is genuinely optional (a public route with no access rules), that default is exactly right; when a rule must gate access, decide the "no configuration" case at the call site instead of letting an empty list decide it.

---

### 6. Keep Provider-Specific Keys in Their Namespace — Map Them

**❌ Wrong**

```typescript
import { grantKey } from "blendsdk/authz";
import type { ClaimsProfile, ProviderIdentity } from "blendsdk/authz";

// A custom profile that promotes provider scopes to canonical permission keys,
// so the allowlist will accept them directly.
const scopePromotingProfile: ClaimsProfile = {
    name: "scope-promoter",
    extract(identity: ProviderIdentity): readonly string[] {
        const scp = identity.accessTokenClaims?.["scp"];
        if (typeof scp !== "string") {
            return [];
        }
        return scp
            .split(/\s+/)
            .filter(scope => scope.length > 0)
            .map(scope => grantKey("permission", scope));
    },
};
```

**✅ Correct**

```typescript
import { azureClaimsProfile, createClaimsTranslator } from "blendsdk/authz";

// Provider scopes stay `scp:` keys; the grant map decides what they mean.
export const translator = createClaimsTranslator(azureClaimsProfile, {
    "scp:Invoice.Read": { permissions: ["invoice:read"] },
    "scp:Invoice.Write": { permissions: ["invoice:write"] },
    "group:Finance": { roles: ["finance"] },
});
```

**Why this matters** — Only `role:` and `permission:` keys are canonical, and `scp:`/`group:` keys never grant authority on their own — that boundary is the design, not an obstacle. A provider scope is not an application permission until the application says so in its `GrantMap`; the built-in Azure profile deliberately never emits `permission:` for exactly that reason. A profile that launders scopes into `permission:` keys collapses the boundary and hands your permission vocabulary to the identity provider: any scope the provider issues becomes directly grantable through the allowlist, without a map entry anyone reviewed.

---

### 7. Share One `as const` Vocabulary

**❌ Wrong**

```typescript
import { hasPermission, hasRole } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["Admin"], // different casing than the check below
    permissions: ["invoce:read"], // a typo that silently never matches
};

hasRole(principal, "admin"); // false
hasPermission(principal, "invoice:read"); // false
```

**✅ Correct**

```typescript
import { hasPermission, hasRole } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const ROLES = { Admin: "admin" } as const;
const PERMISSIONS = { InvoiceRead: "invoice:read" } as const;

const principal: AccessPrincipal = {
    roles: [ROLES.Admin],
    permissions: [PERMISSIONS.InvoiceRead],
};

hasRole(principal, ROLES.Admin); // true
hasPermission(principal, PERMISSIONS.InvoiceRead); // true
```

**Why this matters** — Every comparison is exact and case-sensitive, and a mistyped or miscased literal still compiles; it simply never matches, failing closed with no signal. One `as const` vocabulary object per concept — referenced by the grant map, the allowlist, server checks, and browser checks — gives every site the same strings and lets TypeScript reject values that are not in the vocabulary.

---

## Anti-Patterns

The following mistakes come up repeatedly when the package meets real claim data. Each is prevented by a behavior documented above, and each shows up in the package's own test suites as the thing the implementation must *not* do.

---

### 1. Hand-Parsing Namespaced Keys

Keys split at the first colon only — the value may contain colons (`permission:invoice:read` carries the value `invoice:read`). Code that splits on every colon truncates values, and code that re-implements parsing drifts from the real rules. Let the package parse: `grantKey` builds keys, `resolveGrants` consumes them.

**❌ Wrong**

```typescript fragment
const value = "permission:invoice:read".split(":")[1];
// "invoice" — the rest of the value is silently lost
```

**✅ Correct**

```typescript fragment
// The value survives intact; the package splits at the first colon only.
resolveGrants(["permission:invoice:read"], {}, { permissions: ["invoice:read"] });
// { roles: [], permissions: ["invoice:read"] }
```

---

### 2. Expecting `scp:` or `group:` Keys to Grant Through the Allowlist

Provider-specific sources are never canonical. No value in `allowed` changes that; only a `GrantMap` entry turns a provider label into an application grant.

**❌ Wrong**

```typescript fragment
// Neither grants anything, whatever the allowlist contains.
resolveGrants(["scp:Invoice.Read"], {}, { permissions: ["Invoice.Read"] });
// { roles: [], permissions: [] }

resolveGrants(["group:Finance"], {}, { roles: ["Finance"] });
// { roles: [], permissions: [] }
```

**✅ Correct**

```typescript fragment
const map = {
    "scp:Invoice.Read": { permissions: ["invoice:read"] },
    "group:Finance": { roles: ["finance"] },
};

resolveGrants(["scp:Invoice.Read", "group:Finance"], map);
// { roles: ["finance"], permissions: ["invoice:read"] }
```

---

### 3. Assuming `translate()` Caches the Identity

The translator holds configuration, not per-identity state: every call extracts and aggregates again. Repeated calls for the same identity are repeated work, not cache hits — translate once and store the principal.

**❌ Wrong**

```typescript fragment
translator.translate(identity); // re-extracts and re-aggregates
translator.translate(identity); // ...and again — nothing was remembered
```

**✅ Correct**

```typescript fragment
const principal = translator.translate(identity);
// store `principal` on the session; evaluate it for every later request
```

---

### 4. Passing Scalar Claims Where Profiles Read Arrays

Profiles are strict about claim shapes: a claim that is not an array yields no keys — no coercion, no implicit CSV splitting. The Azure `scp` string is the documented exception, handled by its own profile. Normalize upstream values into arrays before building the `ProviderIdentity`.

**❌ Wrong**

```typescript fragment
genericClaimsProfile.extract({ userInfo: { roles: "admin" } });
// [] — a string claim is ignored entirely
```

**✅ Correct**

```typescript fragment
genericClaimsProfile.extract({ userInfo: { roles: ["admin"] } });
// ["role:admin"]
```

---

### 5. Reimplementing Evaluation

The evaluator's semantics are easy to get subtly wrong by hand: an absent or empty requirement is satisfied, `mode` selects between "at least one" and "every", and matching is exact. A hand-rolled membership check quietly changes one of those rules.

**❌ Wrong**

```typescript fragment
// Hardcodes one list, one mode, and one emptiness rule — each of which
// satisfiesAccess defines differently.
const allowed = principal.roles.some(role => requirement.roles?.includes(role));
```

**✅ Correct**

```typescript fragment
const allowed = satisfiesAccess(principal, requirement);
```

---

### 6. Assuming Malformed Runtime Data Will Throw

Translation is defensive: a mapped entry that is not an object, a string where an array was expected, non-string entries inside arrays — all of it contributes nothing instead of failing. That means a configuration mistake fails closed *silently*: grants disappear with no error. Keep maps as typed source constants; validate anything loaded from JSON before it reaches the translator.

**❌ Wrong**

```typescript fragment
// "roles" holds "admin", but the translator reads only arrays — silently nothing.
const loaded: GrantMap = JSON.parse('{"role:x":{"roles":"admin"}}');

resolveGrants(["role:x"], loaded);
// { roles: [], permissions: [] }
```

**✅ Correct**

```typescript fragment
// Source-level constants are typed and reviewable; configuration loaded from
// JSON should be validated against the same shape before use.
const map: GrantMap = { "role:x": { roles: ["admin"] } };
```

---

## Performance Tips

---

### 1. Run the Claim-Heavy Phase Once per Identity

Translation merges claims across up to three sources and aggregates each namespaced key with de-duplication. Evaluation is one exact membership scan per listed value over two small arrays. The two-phase flow — translate at sign-in, store the `AccessPrincipal`, evaluate for every later request — spends the heavier work once and keeps request handlers to array scans. The aggregation step already de-duplicates grants in first-seen order, so stored principals stay minimal without extra cleanup.

---

### 2. Hoist Requirement Objects to Module Scope

A requirement literal passed per call — `satisfiesAccess(principal, { permissions: [...] })` — allocates a fresh object and array on every evaluation. Declare requirements once as module-level constants; they are plain data, and one constant serves every caller.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const PERMISSIONS = {
    InvoiceRead: "invoice:read",
    InvoiceWrite: "invoice:write",
} as const;

// Allocated once, reused by every check.
const CAN_READ_INVOICES: AccessRequirement = {
    permissions: [PERMISSIONS.InvoiceRead],
};

const CAN_WRITE_INVOICES: AccessRequirement = {
    mode: "all",
    permissions: [PERMISSIONS.InvoiceRead, PERMISSIONS.InvoiceWrite],
};

export function canReadInvoices(principal: AccessPrincipal): boolean {
    return satisfiesAccess(principal, CAN_READ_INVOICES);
}

export function canWriteInvoices(principal: AccessPrincipal): boolean {
    return satisfiesAccess(principal, CAN_WRITE_INVOICES);
}
```

---

### 3. Prefer Single-Value Helpers in Hot Paths

`hasRole` and `hasPermission` are a single `.some()` scan and allocate nothing. `satisfiesAccess` maps every listed role and permission into an intermediate `results` array before combining it by `mode` — still light, but strictly more work. For per-item checks (list filtering, menu rendering), the single-value helpers are the cheaper call; keep `satisfiesAccess` for compound rules, where the small difference is worth the clarity.

```typescript fragment
satisfiesAccess(principal, { permissions: ["invoice:read"] }); // builds a results list
hasPermission(principal, "invoice:read"); // one scan, no allocation
```

---

### 4. Keep `onUnmapped` Cheap — It Runs Inside `translate()`

The callback fires synchronously for every key that yields no grant, once per translation. Wire it to cheap logging or key collection; defer anything expensive (network audit calls, database writes) outside the callback. Because translation belongs at sign-in, the callback cost is bounded to once per session per unmapped key — exactly the audit trail you want for the gap between provider claims and your grant map.

```typescript fragment
onUnmapped: (key: string): void => {
    console.warn(`Unmapped authz claim key: ${key}`); // key-only by design, safe to log
},
```

---

## Security Considerations

Evaluation is not authentication: `satisfiesAccess` trusts the principal it is handed, so security depends on what enters that object and which claims are allowed to confer grants.

---

### 1. Keep the Fail-Closed Default, and Guard the Grant Map Like Code

Without an allowlist, unmapped claims grant nothing — a deliberately safe default; keep it, and list only values the application owns. Remember the other half as well: a key declared in the `GrantMap` always grants its mapped values and is exempt from the allowlist. The map is the trust anchor of translation — review changes to it the way you review authorization code, and never assemble it from request data (see Practice 2).

---

### 2. Never Evaluate a Client-Supplied Principal

An `AccessPrincipal` is plain, serializable data — which is exactly why it must never cross a trust boundary inbound. Translate the provider identity inside your sign-in flow, store the result where the client cannot edit it (a server-side session, or a signed/encrypted cookie), and hand only that stored principal to checks.

**❌ Wrong**

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

// The caller picks the principal: a request body containing
// { "roles": ["admin"] } is enough to pass this check.
export function canDeleteInvoice(body: { principal: AccessPrincipal }): boolean {
    return satisfiesAccess(body.principal, { roles: ["admin"] });
}
```

**✅ Correct**

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";
import type { AccessPrincipal, ProviderIdentity } from "blendsdk/authz";

const translator = createClaimsTranslator(genericClaimsProfile, {
    "role:app-admin": { roles: ["admin"] },
});

// Trusted side of the boundary: the identity comes from the provider
// callback, and the server stores the resulting principal for the session.
export function establishSessionPrincipal(identity: ProviderIdentity): AccessPrincipal {
    return translator.translate(identity);
}

// Later checks read that stored session principal — never a client-sent object.
export function canDeleteInvoice(sessionPrincipal: AccessPrincipal): boolean {
    return satisfiesAccess(sessionPrincipal, { roles: ["admin"] });
}
```

---

### 3. Keep Provider Claims in Provider Namespaces

`scp:` and `group:` keys never grant authority on their own, and a custom profile must not promote them to `permission:` keys to shortcut the allowlist — that hands your permission vocabulary to the identity provider's scope list (see Practice 6). The reverse matters too: don't try to allowlist provider strings. It changes nothing, because those sources are not canonical; the grant map is the supported route.

---

### 4. Log Keys, Not Claims

`onUnmapped` was designed to receive the key name only — never the claim value behind it — so the callback is safe to log, and it is the right signal for watching the gap between provider claims and application grants. Don't log raw identities, token payloads, or claim values: they carry PII, and tokens carry secrets.

---

### 5. Treat Accidental Empty Requirements as Accidental Allows

An empty requirement is satisfied, so a requirement that ends up empty because configuration failed silently opens the gate (see Practice 5). Audit security-critical call sites: a deliberate deny must be as explicit as a deliberate grant.

---

### 6. UI Gating Is Advisory, Never Authoritative

The principal is plain data on purpose, so the same checks can power browser route guards and menu code — good for UX and parity. But client-side code runs on data the user controls at runtime; it may shape the interface, never the policy. Every security-relevant decision is re-evaluated on the server with the server's principal.

---

## See Also

- Overview — what the package is and when to use it
- Core Concepts — the mechanics behind every rule in this document
- Basic Usage — task-oriented walkthrough of translation and evaluation

---

# authz Testing Patterns

`blendsdk/authz` is pure, synchronous, and dependency-free: its functions transform plain data and return plain data, touching no network, clock, or file system. Tests therefore need no containers, no service fakes, no fake timers, and no cleanup — every check is deterministic. This document shows how to test code that uses the package, following the patterns of the package's own suite (`tests/evaluate.spec.test.ts`, `tests/translation.impl.test.ts`, and so on), which is the source of truth.

---

## Test Setup

### Required Imports

| Import | From | Purpose |
| --- | --- | --- |
| `describe`, `it`, `expect` | `vitest` | Test structure and assertions; every test file starts with these. |
| `vi` | `vitest` | Spies and mocks: `vi.fn()` for the `onUnmapped` hook, `vi.mock()` / `vi.mocked()` for consumer-level mocking. |
| Runtime functions, e.g. `satisfiesAccess`, `createClaimsTranslator` | `blendsdk/authz` | The behavior under test. |
| Type-only imports, e.g. `AccessPrincipal`, `ClaimsProfile`, `GrantMap`, `ProviderIdentity` | `blendsdk/authz` | Typing fixtures and helpers; erased at runtime. |

All imports are ESM and always target the public entry point, `blendsdk/authz`:

```typescript
import { describe, it, expect } from "vitest";

import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

describe("invoice access", () => {
    it("should let a reader read an invoice", () => {
        const principal: AccessPrincipal = {
            roles: [],
            permissions: ["invoice:read"],
        };
        const requirement: AccessRequirement = { permissions: ["invoice:read"] };

        expect(satisfiesAccess(principal, requirement)).toBe(true);
    });
});
```

Inside the repository, the package's own test files import `../src/index.js` because they run against the source. Consumer tests must import the published entry point — never a `src/` or `dist/` path.

### Vitest Configuration

The package runs its own suite through the following scripts:

| Script | Command | What it does |
| --- | --- | --- |
| `test` | `vitest run --reporter=verbose` | Single run with verbose reporting; use it in CI. |
| `test:watch` | `vitest watch --reporter=verbose` | Re-runs on change during development. |
| `test:coverage` | `vitest run --coverage` | Single run with V8 coverage (via `@vitest/coverage-v8`). |

A consumer project needs almost no configuration:

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
        },
    },
});
```

- Node.js ≥ 22.0.0 is the supported runtime, matching the package.
- The default `node` environment is enough for tests that exercise the package directly: it uses no DOM API. A browser-like environment is only needed for the rest of your front-end code.
- No setup file, no globals, no environment variables. The package has side-effect-free imports, so there is nothing to initialize before a test file runs.

### Test Helpers

Two helpers cover almost every fixture a test needs. Export them from `tests/helpers.ts` and import them everywhere:

```typescript
// tests/helpers.ts
import type { AccessPrincipal, ClaimsProfile } from "blendsdk/authz";

/** Build a principal that holds the given roles and permissions. */
export function principal(
    roles: string[] = [],
    permissions: string[] = []
): AccessPrincipal {
    return { roles, permissions };
}

/**
 * Build a profile that reports fixed keys.
 *
 * The keys are returned for any identity, so stubbing this seam isolates
 * translation from provider claim shapes.
 */
export function stubProfile(keys: readonly string[]): ClaimsProfile {
    return { name: "stub", extract: () => keys };
}
```

`principal()` mirrors the helper used across the package's own evaluate tests; `stubProfile()` promotes the `{ name: "stub", extract: () => [...] }` profiles used throughout the translation tests. A quick check that the setup works:

```typescript
import { describe, it, expect } from "vitest";

import { createClaimsTranslator, satisfiesAccess } from "blendsdk/authz";

import { principal, stubProfile } from "./helpers.js";

describe("translation with shared helpers", () => {
    it("should produce a principal that satisfies its own requirement", () => {
        const translator = createClaimsTranslator(stubProfile(["role:admin"]), {}, {
            allowed: { roles: ["admin"] },
        });

        const access = translator.translate({ userInfo: {} });

        expect(access).toEqual(principal(["admin"]));
        expect(satisfiesAccess(access, { roles: ["admin"] })).toBe(true);
    });
});
```

A typical consumer layout:

```text
tests/
  helpers.ts                 # shared fixtures: principal(), stubProfile()
  authorize.spec.test.ts     # contract tests, derived from requirements
  authorize.impl.test.ts     # boundary tests, written after the code
```

---

## Unit Testing

### Specification and Implementation Tests

The package's suite splits every feature into two files, and the split is worth copying:

| File | Written | Purpose | Rule |
| --- | --- | --- | --- |
| `*.spec.test.ts` | Before the implementation, from the requirements | Describes the contract: what must hold for any correct implementation. | Never adjusted to match the implementation; a failing test means the code is wrong. |
| `*.impl.test.ts` | After the implementation | Probes the edges: malformed input, precedence, ordering, prototype quirks. | Pins down and explains actual behavior. |

For consumer code that wraps authz — a session builder, a route guard, a UI helper — apply the same idea: a spec file for the rules the application promises ("a finance principal may read invoices") and an impl file for boundary cases discovered while coding.

### Synchronous Unit Tests

None of the package's functions return a Promise, so tests that exercise them directly are synchronous: arrange plain data, call the function, assert the result. Use behavior-first titles (`should ...`), `toBe` for booleans, and `toEqual` for arrays and objects. Array assertions are order-sensitive, which lets one assertion check membership, de-duplication, and first-seen order at once.

```typescript
import { describe, it, expect } from "vitest";

import { hasPermission, hasRole, satisfiesAccess } from "blendsdk/authz";

import { principal } from "./helpers.js";

describe("satisfiesAccess", () => {
    it("should combine roles and permissions with any by default", () => {
        expect(
            satisfiesAccess(principal(["admin"]), {
                roles: ["admin"],
                permissions: ["invoice:read"],
            })
        ).toBe(true);
    });

    it("should require every listed value in all mode", () => {
        expect(
            satisfiesAccess(principal(["admin", "editor"]), {
                mode: "all",
                roles: ["admin", "editor"],
            })
        ).toBe(true);
        expect(
            satisfiesAccess(principal(["admin"], ["invoice:read"]), {
                mode: "all",
                roles: ["admin"],
                permissions: ["invoice:write"],
            })
        ).toBe(false);
    });

    it("should treat an absent or empty requirement as satisfied", () => {
        expect(satisfiesAccess(principal(), {})).toBe(true);
        expect(satisfiesAccess(principal(), { mode: "all" })).toBe(true);
        expect(satisfiesAccess(principal(), { roles: [], permissions: [] })).toBe(true);
    });

    it("should match values exactly and case-sensitively", () => {
        expect(hasRole(principal(["Admin"]), "admin")).toBe(false);
        expect(hasPermission(principal([], ["invoice:read"]), "invoice:read:extra")).toBe(false);
        expect(hasPermission(principal([], ["invoice:read"]), "invoice:read")).toBe(true);
    });
});
```

### Asynchronous Unit Tests

Consumer code that uses the package is often asynchronous anyway — it loads a session, runs middleware, or reads a token before calling into authz. The pattern is to await the surrounding code and assert on the data the synchronous core produced. Show the full error path with a `try`/`catch` when you need to assert on error properties:

```typescript
import { describe, it, expect } from "vitest";

import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

class AccessDeniedError extends Error {
    readonly permission: string;

    constructor(permission: string) {
        super(`Missing permission: ${permission}`);
        this.name = "AccessDeniedError";
        this.permission = permission;
    }
}

/** Async consumer guard: loads a principal, then evaluates with authz. */
async function requirePermission(
    loadPrincipal: () => Promise<AccessPrincipal>,
    permission: string
): Promise<void> {
    const principal = await loadPrincipal();
    if (!satisfiesAccess(principal, { permissions: [permission] })) {
        throw new AccessDeniedError(permission);
    }
}

describe("requirePermission", () => {
    it("should resolve when the loaded principal holds the permission", async () => {
        const loadPrincipal = async (): Promise<AccessPrincipal> => ({
            roles: [],
            permissions: ["invoice:read"],
        });

        await expect(requirePermission(loadPrincipal, "invoice:read")).resolves.toBeUndefined();
    });

    it("should reject with AccessDeniedError when the permission is missing", async () => {
        const loadPrincipal = async (): Promise<AccessPrincipal> => ({
            roles: [],
            permissions: [],
        });

        try {
            await requirePermission(loadPrincipal, "invoice:read");
            throw new Error("expected requirePermission to throw AccessDeniedError");
        } catch (error) {
            if (error instanceof AccessDeniedError) {
                expect(error.permission).toBe("invoice:read");
            } else {
                throw error;
            }
        }
    });
});
```

For terse checks that do not inspect the error object, `await expect(requirePermission(loadPrincipal, "invoice:read")).rejects.toThrow(AccessDeniedError)` is the shorter equivalent.

---

## Integration Testing

**No Docker or external services.** The package has zero runtime dependencies, performs no I/O, reads no environment variables, and holds no state, so there is nothing to containerize, fake, or tear down. Integration testing here means something narrower than usual: run the package's real components together — a real profile, a real translator, the real evaluator — against a payload shaped like what a provider actually sends, and assert the end result. Unit tests check one function with minimal fixtures; integration tests check that the composition holds on realistic data.

### Translating a Realistic Provider Payload

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
    azureClaimsProfile,
    createClaimsTranslator,
    satisfiesAccess,
} from "blendsdk/authz";

const onUnmapped = vi.fn();

const translator = createClaimsTranslator(
    azureClaimsProfile,
    {
        "group:Finance": { roles: ["finance"], permissions: ["invoice:read"] },
        "scp:Invoice.Write": { permissions: ["invoice:write"] },
    },
    {
        allowed: { roles: ["user"], permissions: ["invoice:read"] },
        onUnmapped,
    }
);

describe("Azure sign-in pipeline", () => {
    beforeEach(() => {
        onUnmapped.mockClear();
    });

    it("should translate a realistic token payload into a usable principal", () => {
        const access = translator.translate({
            userInfo: { roles: ["user"] },
            accessTokenClaims: {
                roles: ["App.Admin"],
                scp: "Invoice.Write Unknown.Scope",
                groups: ["Finance"],
            },
        });

        // The access token's `roles` claim replaces the one from user info, so the
        // "user" role is never emitted; "App.Admin" is not allowlisted and grants
        // nothing. Grants come from the group and scope mappings.
        expect(access).toEqual({
            roles: ["finance"],
            permissions: ["invoice:write", "invoice:read"],
        });

        // Every key that yielded no grant is reported, in key order.
        expect(onUnmapped).toHaveBeenCalledTimes(2);
        expect(onUnmapped).toHaveBeenNthCalledWith(1, "role:App.Admin");
        expect(onUnmapped).toHaveBeenNthCalledWith(2, "scp:Unknown.Scope");
    });

    it("should evaluate the pipeline end to end", () => {
        const access = translator.translate({
            userInfo: {},
            accessTokenClaims: {
                scp: "Invoice.Write",
                groups: ["Finance"],
            },
        });

        expect(satisfiesAccess(access, { permissions: ["invoice:write"] })).toBe(true);
        expect(
            satisfiesAccess(access, {
                mode: "all",
                roles: ["finance"],
                permissions: ["invoice:read"],
            })
        ).toBe(true);
        expect(satisfiesAccess(access, { roles: ["user"] })).toBe(false);
        expect(onUnmapped).not.toHaveBeenCalled();
    });
});
```

The `mockClear()` in `beforeEach` makes the audit assertions count only the translation in the current test; every other piece of state lives in local variables, which is why no other setup or teardown is needed.

### Serialization Round-Trip

Principals cross process boundaries — sessions, caches, client bundles — as JSON. A round-trip test confirms that decisions survive the trip, because the package deliberately operates on plain data only:

```typescript
import { describe, it, expect } from "vitest";

import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

describe("session persistence", () => {
    it("should keep grants after a JSON round-trip", () => {
        const access: AccessPrincipal = {
            roles: ["finance"],
            permissions: ["invoice:read", "invoice:write"],
        };

        // The session store serializes the principal; the client rebuilds it.
        const restored: AccessPrincipal = JSON.parse(JSON.stringify(access));

        expect(restored).toEqual(access);
        expect(satisfiesAccess(restored, { permissions: ["invoice:read"] })).toBe(true);
    });
});
```

If your application also integrates with real infrastructure — a session store, an HTTP framework, an OIDC client — test that integration in your own project; the authz package contributes no I/O that you would need to mock.

---

## Mocking & Stubbing

The package is pure, deterministic, and dependency-free: there is no network call, timer, or database to substitute. Mocking has exactly two legitimate uses here:

1. **Replacing the package's own seam** — stub the `ClaimsProfile` to isolate translation from provider claim shapes.
2. **Isolating consumer code** that wraps the package, when a unit test must force one outcome.

Everywhere else, prefer the real functions. A denial branch is cheaper to reach by passing a principal that lacks the value than by mocking one.

### Stubbing the ClaimsProfile Seam

`ClaimsProfile` is the strategy seam the package defines for exactly this purpose. A stub profile ignores the identity entirely, so the test proves that translation depends only on the reported keys:

```typescript
import { describe, it, expect } from "vitest";

import { createClaimsTranslator } from "blendsdk/authz";
import type { ClaimsProfile } from "blendsdk/authz";

const stub: ClaimsProfile = { name: "stub", extract: () => ["role:admin"] };

describe("translation in isolation", () => {
    it("should ignore the identity and translate the reported keys", () => {
        const translator = createClaimsTranslator(stub, {}, { allowed: { roles: ["admin"] } });

        expect(
            translator.translate({ userInfo: { roles: ["everything"] } })
        ).toEqual({ roles: ["admin"], permissions: [] });
    });
});
```

### Spying on the onUnmapped Hook

`onUnmapped` is the package's audit seam. Record it with `vi.fn()` and assert both the call count and the key name:

```typescript
import { describe, it, expect, vi } from "vitest";

import { createClaimsTranslator } from "blendsdk/authz";
import type { ClaimsProfile } from "blendsdk/authz";

const profile: ClaimsProfile = {
    name: "stub",
    extract: () => ["role:admin", "scp:Invoice.Read"],
};

describe("onUnmapped", () => {
    it("should report each key that yields no grant exactly once", () => {
        const onUnmapped = vi.fn();
        const translator = createClaimsTranslator(profile, {}, {
            allowed: { roles: ["admin"] },
            onUnmapped,
        });

        translator.translate({ userInfo: {} });

        expect(onUnmapped).toHaveBeenCalledTimes(1);
        expect(onUnmapped).toHaveBeenCalledWith("scp:Invoice.Read");
    });
});
```

The hook receives the key name only — never a claim value — so these assertions can never embed provider data.

### Simulating Malformed Runtime Data

Claim values are `unknown` in the type system, so tests can pass wrong-shaped data with no cast at all. For grant maps, build runtime-shaped values with `JSON.parse`, exactly the way a decoded claim arrives at runtime:

```typescript
import { describe, it, expect } from "vitest";

import { genericClaimsProfile, resolveGrants } from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

describe("malformed runtime data", () => {
    it("should filter malformed claims instead of throwing", () => {
        expect(genericClaimsProfile.extract({ userInfo: { roles: [1, "ok"] } })).toEqual([
            "role:ok",
        ]);
        expect(genericClaimsProfile.extract({ userInfo: { permissions: 42 } })).toEqual([]);
    });

    it("should ignore a mapped value that is a string, not an array", () => {
        // JSON parsing can produce a shape that never type-checked.
        const map: GrantMap = JSON.parse('{"role:x":{"roles":"admin"}}');

        expect(resolveGrants(["role:x"], map).roles).toEqual([]);
    });
});
```

### Mocking the Package in Consumer Tests

When a consumer unit must be tested in isolation — for example, to prove it delegates the decision — mock the package module itself. Two rules apply:

- ESM exports are read-only bindings, so `vi.spyOn` on the package does not work. Use `vi.mock` with a factory and access the mock through `vi.mocked`.
- Keep the factory as small as the code under test demands; a missing runtime export it imports becomes `undefined` and fails at call time.

```typescript
// src/authorize.ts — consumer code under test
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

export function isInvoiceReader(principal: AccessPrincipal): boolean {
    return satisfiesAccess(principal, { permissions: ["invoice:read"] });
}
```

```typescript
// tests/authorize.test.ts
import { describe, it, expect, vi } from "vitest";

import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

import { isInvoiceReader } from "../src/authorize.js";

vi.mock("blendsdk/authz", () => ({
    satisfiesAccess: vi.fn(),
}));

const mockedSatisfiesAccess = vi.mocked(satisfiesAccess);

describe("isInvoiceReader", () => {
    it("should delegate the decision to satisfiesAccess", () => {
        mockedSatisfiesAccess.mockReturnValueOnce(true);

        const principal: AccessPrincipal = { roles: [], permissions: ["invoice:read"] };

        expect(isInvoiceReader(principal)).toBe(true);
        expect(mockedSatisfiesAccess).toHaveBeenCalledWith(principal, {
            permissions: ["invoice:read"],
        });
    });
});
```

If you want the real behavior *and* call tracking, use a partial mock that wraps the actual export:

```typescript
// typescript fragment — keep the real implementation and observe calls.
vi.mock("blendsdk/authz", async (importOriginal) => {
    const actual = await importOriginal<typeof import("blendsdk/authz")>();
    return { ...actual, satisfiesAccess: vi.fn(actual.satisfiesAccess) };
});
```

Because the package is deterministic, most consumer tests need no mock at all: build the principal you need and assert the real decision. Reserve mocking for proving that a consumer handles both outcomes, not for reproducing authz behavior.

---

## Test Patterns by Feature

| Feature | Exports | Pattern |
| --- | --- | --- |
| Evaluation | `hasRole`, `hasPermission`, `satisfiesAccess` | Table-driven boolean cases; assert the safety property that empty requirements pass. |
| Guards | `isOneOf` | Accept/reject cases plus an in-branch narrowing assertion. |
| Claim profiles | `genericClaimsProfile`, `azureClaimsProfile`, custom `ClaimsProfile` | Fixture identity in, ordered key array out; malformed claims filtered, never thrown. |
| Translation | `grantKey`, `resolveGrants`, `createClaimsTranslator` | Stub the profile; enforce the authority rules; spy on `onUnmapped`. |
| Full pipeline | all of the above | Integration test over a realistic provider payload (see [Integration Testing](#integration-testing)). |

### Evaluating Roles, Permissions, and Requirements

- Assert with `toBe(true)` / `toBe(false)`, never truthiness — every function returns a boolean.
- Cover the `mode` matrix: default `"any"`, explicit `"any"`, `"all"`, and the case where only one of the two lists is populated.
- Assert the safety property explicitly: an absent or empty requirement is always satisfied, so an unconfigured rule never locks users out.
- Matching is exact and case-sensitive, so include near-miss values (`"Admin"` vs `"admin"`, `"invoice:read:extra"` vs `"invoice:read"`). Duplicate held values change nothing.

A table-driven block keeps the decision matrix readable; a plain `for` loop over a typed array generates one named test per case.

```typescript
import { describe, it, expect } from "vitest";

import { hasPermission, hasRole, satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

interface Decision {
    readonly name: string;
    readonly principal: AccessPrincipal;
    readonly requirement: AccessRequirement;
    readonly expected: boolean;
}

const decisions: readonly Decision[] = [
    {
        name: "an empty requirement is always satisfied",
        principal: { roles: [], permissions: [] },
        requirement: {},
        expected: true,
    },
    {
        name: "any mode passes when one listed value is held",
        principal: { roles: ["admin"], permissions: [] },
        requirement: { roles: ["admin", "editor"] },
        expected: true,
    },
    {
        name: "any mode spans both lists",
        principal: { roles: [], permissions: ["invoice:read"] },
        requirement: { roles: ["admin"], permissions: ["invoice:read"] },
        expected: true,
    },
    {
        name: "all mode requires every listed value",
        principal: { roles: ["admin"], permissions: ["invoice:read"] },
        requirement: { mode: "all", roles: ["admin"], permissions: ["invoice:write"] },
        expected: false,
    },
    {
        name: "matching is exact and case-sensitive",
        principal: { roles: ["Admin"], permissions: [] },
        requirement: { roles: ["admin"] },
        expected: false,
    },
];

describe("satisfiesAccess", () => {
    for (const decision of decisions) {
        it(`should decide: ${decision.name}`, () => {
            expect(satisfiesAccess(decision.principal, decision.requirement)).toBe(
                decision.expected
            );
        });
    }
});

describe("hasRole / hasPermission", () => {
    it("should ignore duplicates and reject near matches", () => {
        expect(hasRole({ roles: ["admin", "admin"], permissions: [] }, "admin")).toBe(true);
        expect(hasRole({ roles: ["Admin"], permissions: [] }, "admin")).toBe(false);
        expect(
            hasPermission({ roles: [], permissions: ["invoice:read:extra"] }, "invoice:read")
        ).toBe(false);
    });
});
```

### Guarding Untrusted Values with isOneOf

- Test the accept case, the reject case (unknown string), and the type rejections (number, `null`, object).
- Always include the narrowing assertion: inside the `if`, assign the value to a variable typed as the application union. That block fails to compile if the guard ever stops narrowing, which a runtime assertion alone would not catch.

```typescript
import { describe, it, expect } from "vitest";

import { isOneOf } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;

describe("isOneOf", () => {
    it("should accept an application value and reject everything else", () => {
        const allowed = Object.values(ROLES);

        expect(isOneOf("admin", allowed)).toBe(true);
        expect(isOneOf("root", allowed)).toBe(false);
        expect(isOneOf(42, allowed)).toBe(false);
        expect(isOneOf(null, allowed)).toBe(false);
        expect(isOneOf({ role: "admin" }, allowed)).toBe(false);
    });

    it("should narrow an unknown value to the application union", () => {
        const raw: unknown = "user";

        if (isOneOf(raw, Object.values(ROLES))) {
            const role: "admin" | "user" = raw;
            expect(role).toBe("user");
        } else {
            throw new Error("expected the guard to accept an application value");
        }
    });
});
```

### Testing Claim Profiles

Assert `extract` output with `toEqual` on the whole array: the key order is part of the contract (roles, then permissions for the generic profile; roles, then scopes, then groups for Azure). Cover these cases for each profile:

1. **Happy path** — the claims the provider actually sends produce the expected keys, in order.
2. **Malformed claims** — a non-array claim is ignored; non-string entries are dropped; Azure's whitespace-delimited `scp` skips empty segments.
3. **Never `permission:` from Azure** — even when a `permissions` claim is present next to `scp`.
4. **Claim precedence** — the access token wins over the identity token, which wins over user info, and each claim resolves independently.

```typescript
import { describe, it, expect } from "vitest";

import { azureClaimsProfile, genericClaimsProfile } from "blendsdk/authz";

describe("genericClaimsProfile", () => {
    it("should emit role and permission keys in claim order", () => {
        const keys = genericClaimsProfile.extract({
            userInfo: { roles: ["admin", "user"], permissions: ["invoice:read"] },
        });

        expect(keys).toEqual(["role:admin", "role:user", "permission:invoice:read"]);
    });

    it("should ignore malformed claims instead of throwing", () => {
        expect(genericClaimsProfile.extract({ userInfo: { roles: "admin" } })).toEqual([]);
        expect(
            genericClaimsProfile.extract({ userInfo: { roles: ["a", 3, null, "b"] } })
        ).toEqual(["role:a", "role:b"]);
    });

    it("should let the access token claims override other sources", () => {
        const keys = genericClaimsProfile.extract({
            userInfo: { roles: ["user-info"] },
            idTokenClaims: { roles: ["id-token"] },
            accessTokenClaims: { roles: ["access-token"] },
        });

        expect(keys).toEqual(["role:access-token"]);
    });
});

describe("azureClaimsProfile", () => {
    it("should emit role, scp, and group keys", () => {
        const keys = azureClaimsProfile.extract({
            userInfo: {},
            accessTokenClaims: {
                roles: ["App.Admin"],
                scp: "Invoice.Read Invoice.Write",
                groups: ["Finance"],
            },
        });

        expect(keys).toEqual([
            "role:App.Admin",
            "scp:Invoice.Read",
            "scp:Invoice.Write",
            "group:Finance",
        ]);
    });

    it("should never emit a permission key", () => {
        const keys = azureClaimsProfile.extract({
            userInfo: {},
            accessTokenClaims: { permissions: ["p"], scp: "S" },
        });

        expect(keys).toEqual(["scp:S"]);
    });

    it("should skip empty scope segments", () => {
        const keys = azureClaimsProfile.extract({
            userInfo: {},
            accessTokenClaims: { scp: "  A   B  " },
        });

        expect(keys).toEqual(["scp:A", "scp:B"]);
    });
});
```

A custom `ClaimsProfile` is tested the same way: build fixture identities whose claims use your provider's shapes and assert the exact ordered key array. Keep translation tests separate — stub the profile there with `stubProfile()` so a profile change can never make a translation test fail for the wrong reason.

### Testing Grant Translation

Translation holds all the authority rules, so its tests function as the security regression suite. Cover each rule explicitly:

- **Mapped beats canonical** — a mapped key grants its mapped values and never falls back to the canonical value.
- **Allowlist gating** — an unmapped `role:`/`permission:` key grants only a listed value; without an allowlist it grants nothing (fail closed).
- **Provider sources are never canonical** — `scp:` and `group:` keys grant nothing on their own, whatever the allowlist contains.
- **Stable output** — grants are de-duplicated and keep first-seen order.
- **Defensive parsing** — malformed mapped values are filtered instead of throwing; inherited (non-own) map entries are ignored.
- **The audit hook** — `onUnmapped` fires once per ungranted key, never for a mapped key, even when the mapping is empty, and receives the key only.

```typescript
import { describe, it, expect, vi } from "vitest";

import { createClaimsTranslator, resolveGrants } from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

import { stubProfile } from "./helpers.js";

describe("resolveGrants", () => {
    it("should let a mapped key override its canonical fallback", () => {
        const map: GrantMap = { "role:admin": { roles: ["super"] } };

        const result = resolveGrants(["role:admin"], map, { roles: ["admin", "super"] });

        expect(result.roles).toEqual(["super"]);
    });

    it("should gate unmapped canonical keys on the allowlist and fail closed without one", () => {
        expect(resolveGrants(["role:admin"], {}, { roles: ["admin"] }).roles).toEqual(["admin"]);
        expect(resolveGrants(["role:editor"], {}, { roles: ["admin"] }).roles).toEqual([]);
        expect(resolveGrants(["role:admin"], {}).roles).toEqual([]);
    });

    it("should never grant authority from provider-specific keys", () => {
        expect(
            resolveGrants(["scp:Invoice.Read"], {}, { permissions: ["Invoice.Read"] }).permissions
        ).toEqual([]);
        expect(resolveGrants(["group:Finance"], {}, { roles: ["Finance"] }).roles).toEqual([]);
    });

    it("should de-duplicate grants and keep first-seen order", () => {
        const result = resolveGrants(["role:viewer", "role:admin", "role:viewer"], {}, {
            roles: ["admin", "viewer"],
        });

        expect(result.roles).toEqual(["viewer", "admin"]);
    });

    it("should ignore malformed and inherited map entries", () => {
        const malformed: GrantMap = JSON.parse('{"role:x":{"roles":["admin",3,"admin"]}}');
        const inherited: GrantMap = Object.create({ "role:x": { roles: ["admin"] } });

        expect(resolveGrants(["role:x"], malformed).roles).toEqual(["admin"]);
        expect(resolveGrants(["role:x"], inherited).roles).toEqual([]);
    });
});

describe("createClaimsTranslator", () => {
    it("should translate the keys reported by the profile", () => {
        const translator = createClaimsTranslator(stubProfile(["role:admin"]), {}, {
            allowed: { roles: ["admin"] },
        });

        expect(translator.translate({ userInfo: {} })).toEqual({
            roles: ["admin"],
            permissions: [],
        });
    });

    it("should report every key that yields no grant exactly once", () => {
        const onUnmapped = vi.fn();
        const translator = createClaimsTranslator(
            stubProfile(["role:admin", "scp:Invoice.Read"]),
            {},
            { allowed: { roles: ["admin"] }, onUnmapped }
        );

        translator.translate({ userInfo: {} });

        expect(onUnmapped).toHaveBeenCalledTimes(1);
        expect(onUnmapped).toHaveBeenCalledWith("scp:Invoice.Read");
    });

    it("should not report a mapped key whose mapping is empty", () => {
        const onUnmapped = vi.fn();
        const translator = createClaimsTranslator(
            stubProfile(["role:ghost"]),
            { "role:ghost": {} },
            { onUnmapped }
        );

        translator.translate({ userInfo: {} });

        expect(onUnmapped).not.toHaveBeenCalled();
    });
});
```

---

# authz Troubleshooting

Most failures in `blendsdk/authz` are silent. The package filters malformed provider data instead of throwing, and its defaults fail closed, so the usual symptom is an empty principal or a denied check — not a stack trace. This guide covers both sides: the compiler and module errors that stop a build, and the silent outcomes that stop access. Each issue is presented as a symptom, a cause, and a fix with complete code.

---

## Common Errors

The issues below are grouped by the stage where they surface: module resolution, strict-mode typing, translation, and evaluation. Provider claims themselves never make the package throw — a translator that sees garbage returns `{ roles: [], permissions: [] }`. When you see that outcome, treat it as the "empty grants" issue below, not as a bug to catch with try/catch.

### Import and Module Resolution Errors

#### TS2307: `Cannot find module 'blendsdk/authz' or its corresponding type declarations.`

**Symptom:** TypeScript reports `Cannot find module 'blendsdk/authz' or its corresponding type declarations.` even though the package is installed in `node_modules`.

**Cause:** `blendsdk/authz` is ESM-only and declares its files exclusively through the `exports` map (`"." → { "types", "import" }`). The manifest has no top-level `types` or `main` field. TypeScript's legacy `"moduleResolution": "node"` (node10) cannot read export maps, so it finds nothing to resolve.

**Fix:** Use modern resolution. In the consuming project's `tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "es2022",
        "module": "nodenext",
        "moduleResolution": "nodenext",
        "strict": true
    }
}
```

Then import from the package root; `blendsdk/authz/dist/...` subpaths are not in the export map, and importing them fails with the same TS2307 (or at runtime with `Package subpath './dist/index.js' is not defined by "exports" in .../package.json`).

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = { roles: ["admin"], permissions: [] };

console.log(satisfiesAccess(principal, { roles: ["admin"] })); // true
```

---

#### `Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../node_modules/blendsdk/authz/package.json`

**Symptom:** Loading the package from CommonJS fails with `Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../node_modules/blendsdk/authz/package.json`.

**Cause:** The export map defines only `types` and `import` conditions, so a CommonJS resolution matches no condition and fails before any file is loaded. With `"module": "nodenext"`, TypeScript reports the compile-time sibling of this problem as TS1479 when an import sits in a file it treats as CommonJS.

**Fix:** Make the consumer an ES module. In its `package.json`:

```json
{
    "type": "module"
}
```

and ensure the build emits ESM (`"module": "nodenext"`). The same import then works from Node.js ≥ 22 and from bundlers:

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

const identity: ProviderIdentity = { userInfo: { roles: ["user"] } };

console.log(genericClaimsProfile.extract(identity));
// ["role:user"]
```

---

#### TS1484: `'AccessPrincipal' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.`

**Symptom:** Importing a type such as `AccessPrincipal`, `Role`, or `GrantMap` in a value import fails with `'AccessPrincipal' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.`

**Cause:** Every interface and type alias in the package (`Role`, `Permission`, `AccessPrincipal`, `AccessRequirement`, `AccessMode`, `AllowedGrants`, `ProviderIdentity`, `GrantSource`, `GrantMap`, `ClaimsProfile`, `ClaimsTranslator`, `TranslatorOptions`) is erased at compile time. Only the functions are runtime values.

**Fix:** Split value imports from type imports:

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const principal: AccessPrincipal = { roles: [], permissions: [] };
const requirement: AccessRequirement = { permissions: ["invoice:read"] };

console.log(satisfiesAccess(principal, requirement)); // false
```

---

### TypeScript Strict-Mode Errors

#### TS2741: `Property 'permissions' is missing in type '{ roles: string[]; }' but required in type 'AccessPrincipal'.`

**Symptom (two common variants):**

- `Property 'permissions' is missing in type '{ roles: string[]; }' but required in type 'AccessPrincipal'.`
- `Property 'userInfo' is missing in type '{ accessTokenClaims: { scp: string; }; }' but required in type 'ProviderIdentity'.`

**Cause:** `AccessPrincipal` requires both `roles` and `permissions` — evaluation calls `.some()` on both arrays, so they can never be optional. `ProviderIdentity` requires `userInfo`; only `idTokenClaims`, `accessTokenClaims`, and `scopes` are optional.

**Fix:** Supply empty values for the parts you do not have:

```typescript
import type { AccessPrincipal, ProviderIdentity } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["admin"],
    permissions: [],
};

const identity: ProviderIdentity = {
    userInfo: {}, // required even when the provider puts everything in the access token
    accessTokenClaims: { scp: "Invoice.Read" },
};
```

---

#### TS2345: `Argument of type '"scope"' is not assignable to parameter of type 'GrantSource'.`

**Symptom:** Building a key with the wrong source name fails to compile: `Argument of type '"scope"' is not assignable to parameter of type 'GrantSource'.`

**Cause:** `GrantSource` is exactly `"role" | "scp" | "group" | "permission"`. Azure's scope claim is spelled `scp`, and there is no `scope` member.

**Fix:** Use a declared source — and remember that only `role:` and `permission:` are canonical. Keys from any other source grant nothing unless the grant map declares them.

```typescript
import { grantKey } from "blendsdk/authz";
import type { GrantSource } from "blendsdk/authz";

const source: GrantSource = "scp";
const key: string = grantKey(source, "Invoice.Read");

console.log(key); // "scp:Invoice.Read"
```

---

#### TS2540: `Cannot assign to 'roles' because it is a read-only property.`

**Symptom:** Mutating a principal fails to compile: `Cannot assign to 'roles' because it is a read-only property.` or `Property 'push' does not exist on type 'readonly string[]'.`

**Cause:** `AccessPrincipal.roles` and `AccessPrincipal.permissions` are declared `readonly Role[]` / `readonly Permission[]`, and the evaluators treat principals as immutable snapshots.

**Fix:** Derive a new principal instead of mutating one:

```typescript
import type { AccessPrincipal } from "blendsdk/authz";

const base: AccessPrincipal = { roles: ["user"], permissions: ["invoice:read"] };

const elevated: AccessPrincipal = {
    roles: [...base.roles, "admin"],
    permissions: [...base.permissions],
};

console.log(elevated.roles); // ["user", "admin"]
```

---

#### `Type '{ permissions: string[]; roles: undefined; }' is not assignable to type 'AccessRequirement' with 'exactOptionalPropertyTypes: true'.`

**Symptom:** Under `exactOptionalPropertyTypes`, assigning an explicit `undefined` to an optional property fails; the compiler suggests adding `undefined` to the target's property types.

**Cause:** `AccessRequirement.roles`, `.permissions`, and `.mode` are optional properties, not `| undefined` properties. With this flag, an optional property must be omitted rather than set to `undefined`.

**Fix:** Omit the property, or build the requirement conditionally:

```typescript
import type { AccessRequirement } from "blendsdk/authz";

const includeAdminCheck = true;

const requirement: AccessRequirement = includeAdminCheck
    ? { mode: "all", roles: ["admin"], permissions: ["invoice:read"] }
    : { permissions: ["invoice:read"] };

console.log(requirement.mode); // "all"
```

---

#### `'mapped' is possibly 'undefined'.` (reading a `GrantMap` entry under `noUncheckedIndexedAccess`)

**Symptom:** Reading a grant-map entry and using it fails to compile: `'mapped' is possibly 'undefined'.`

**Cause:** `GrantMap` is `Record<string, Partial<AccessPrincipal>>`. Under `noUncheckedIndexedAccess`, every indexed read is `Partial<AccessPrincipal> | undefined` — and `Partial<AccessPrincipal>` means `roles` and `permissions` are optional.

**Fix:** Narrow before reading, exactly as translation does internally:

```typescript
import type { GrantMap } from "blendsdk/authz";

const map: GrantMap = { "role:app-admin": { roles: ["admin"] } };

function describeGrant(key: string): string {
    const mapped = map[key];
    if (!mapped) {
        return `no mapping for ${key}`;
    }
    const roles = mapped.roles ?? [];
    return `${key} grants: ${roles.join(", ")}`;
}

console.log(describeGrant("role:app-admin")); // role:app-admin grants: admin
```

Note that translation checks `Object.hasOwn(map, key)` before trusting an entry, so an inherited property never grants. If you replicate the decision in your own code, check own-property membership too.

---

### Translation: Empty or Unexpected Grants

#### `translate()` returns `{ roles: [], permissions: [] }`

**Symptom:** `translator.translate(identity)` returns empty arrays even though the token visibly contains roles or permissions. No exception is thrown.

**Cause:** One of the fail-closed paths fired:

- the key is provider-specific (`scp:`, `group:`) and has no grant-map entry — those sources can never grant through the allowlist;
- the key is canonical (`role:`, `permission:`) but is not mapped and its value is not in `allowed`;
- the key never existed — the claim was malformed, or the wrong profile read the identity. For example, `azureClaimsProfile` never emits `permission:` keys, so a `"permission:..."` mapping can never match an Azure identity.

**Fix:** Expose the extracted keys first, then map or allowlist them. Provider-specific keys must be mapped explicitly:

```typescript
import { azureClaimsProfile, createClaimsTranslator } from "blendsdk/authz";

const translator = createClaimsTranslator(
    azureClaimsProfile,
    {
        "scp:Invoice.Read": { permissions: ["invoice:read"] },
        "group:Finance": { roles: ["finance"] },
    },
    {
        allowed: { roles: ["user"] },
        onUnmapped: (key: string): void => {
            console.warn(`Unmapped claim key: ${key}`);
        },
    }
);

const principal = translator.translate({
    userInfo: { roles: ["user"] },
    accessTokenClaims: {
        scp: "Invoice.Read Billing.Read",
        groups: ["Finance"],
    },
});
// { roles: ["user", "finance"], permissions: ["invoice:read"] }
// warns: "Unmapped claim key: scp:Billing.Read"
```

If the intended grant used a `"permission:..."` key with an Azure identity, change the key to `"scp:..."` — the Azure profile never produces `permission:` keys.

---

#### A mapped key grants nothing (and `onUnmapped` stays silent)

**Symptom:** An allowlisted canonical value is never granted, or a key grants something other than its canonical value — and `onUnmapped` never fires for that key.

**Cause:** The key is an own property of the `GrantMap`. Mapped keys are trusted and short-circuit everything else: `{ "role:admin": {} }` grants nothing *and* suppresses both the canonical fallback and the `onUnmapped` callback, while `{ "role:admin": { roles: ["super"] } }` grants `super` — never `admin`, whatever the allowlist says.

**Fix:** Delete the entry to re-enable canonical handling, or state the intended grants explicitly:

```typescript
import { resolveGrants } from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

// A declared-but-empty mapping is a deliberate denial; it is not an "allow" switch.
const blocked: GrantMap = { "role:admin": {} };
resolveGrants(["role:admin"], blocked, { roles: ["admin"] });
// { roles: [], permissions: [] }

// To grant a value, say so — or remove the entry and let the allowlist apply.
const explicit: GrantMap = { "role:admin": { roles: ["admin"] } };
resolveGrants(["role:admin"], explicit);
// { roles: ["admin"], permissions: [] }
```

---

#### A map key or allowlist value that "looks right" matches nothing

**Symptom:** Allowlisting `"invoice"` does not grant a `permission:invoice:read` key; mapping `"role:a"` does not cover the key `role:a:b`.

**Cause:** Keys are split at the first colon only. The canonical value of `permission:invoice:read` is `invoice:read` — with the second colon included. The value of `role:a:b` is `a:b`.

**Fix:** Use the full value after the first colon, in both keys and allowlists:

```typescript
import { resolveGrants } from "blendsdk/authz";

// The value after "permission:" is "invoice:read", colons included.
resolveGrants(["permission:invoice:read"], {}, { permissions: ["invoice:read"] });
// { roles: [], permissions: ["invoice:read"] }

// Values with colons are legal; keep the complete value in the allowlist.
resolveGrants(["role:a:b"], {}, { roles: ["a:b"] });
// { roles: ["a:b"], permissions: [] }

// "invoice" alone matches nothing for this key.
resolveGrants(["permission:invoice:read"], {}, { permissions: ["invoice"] });
// { roles: [], permissions: [] }
```

---

#### A claim present in `userInfo` disappears from the principal

**Symptom:** The translated principal contains only values from `idTokenClaims` or `accessTokenClaims`; roles that were present in `userInfo` are gone.

**Cause:** Claim precedence resolves each claim name to exactly one winner, in the order `userInfo` → `idTokenClaims` → `accessTokenClaims`. The winning source's value *replaces* earlier values entirely — arrays are never merged across sources.

**Fix:** Merge the lists you intend before building the identity, and let one source win:

```typescript
import { genericClaimsProfile } from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

const userInfoRoles = ["user"];
const accessTokenRoles = ["admin"];
const mergedRoles = [...new Set([...userInfoRoles, ...accessTokenRoles])];

const identity: ProviderIdentity = {
    userInfo: { roles: mergedRoles },
    accessTokenClaims: {}, // no competing "roles" claim: userInfo wins
};

genericClaimsProfile.extract(identity);
// ["role:user", "role:admin"] — both survive
```

---

#### A claim you can see in the token produces no keys

**Symptom:** `genericClaimsProfile.extract(...)` or `azureClaimsProfile.extract(...)` returns `[]`, or drops entries, for a claim you inspected in the token.

**Cause:** The built-in profiles drop malformed shapes instead of throwing. A `roles`/`permissions`/`groups` claim that is not an array is ignored; non-string array entries are dropped; the Azure `scp` claim is read only when it is a string and is split on whitespace. A bare `"roles": "admin"` string, a numeric `scp`, or `groups: "Finance"` yields nothing.

**Fix:** Check how the token is decoded first — Azure sends `roles`/`groups` as arrays, so a bare string usually indicates a decoding bug. If you must accept both shapes, normalize inside a custom profile:

```typescript
import { grantKey } from "blendsdk/authz";
import type { ClaimsProfile, ProviderIdentity } from "blendsdk/authz";

const lenientRolesProfile: ClaimsProfile = {
    name: "lenient-roles",
    extract(identity: ProviderIdentity): readonly string[] {
        const raw = identity.accessTokenClaims?.["roles"] ?? identity.userInfo["roles"];
        const candidates: readonly unknown[] = Array.isArray(raw) ? raw : [raw];

        const keys: string[] = [];
        for (const candidate of candidates) {
            if (typeof candidate === "string") {
                keys.push(grantKey("role", candidate));
            }
        }
        return keys;
    },
};

lenientRolesProfile.extract({ userInfo: {}, accessTokenClaims: { roles: "admin" } });
// ["role:admin"] — a bare string is wrapped instead of dropped
```

---

### Evaluation: Checks That Deny or Over-Grant

#### A value that "looks held" fails the check

**Symptom:** `hasRole` / `hasPermission` / `satisfiesAccess` return `false` although the value appears to be held — `"Finance"` vs `"finance"`, a trailing space, or `"invoice:read:extra"` vs `"invoice:read"`.

**Cause:** All matching is exact and case-sensitive. The package never trims, lowercases, or prefix-matches; duplicates in the principal change nothing.

**Fix:** Normalize at the translation boundary — map provider values to canonical application values — and compare with the same constants used to define the vocabulary:

```typescript
import { azureClaimsProfile, createClaimsTranslator, satisfiesAccess } from "blendsdk/authz";

const ROLES = { Finance: "finance" } as const;

// The provider emits "Finance"; the application vocabulary is "finance".
const translator = createClaimsTranslator(azureClaimsProfile, {
    "group:Finance": { roles: [ROLES.Finance] },
});

const principal = translator.translate({
    userInfo: {},
    accessTokenClaims: { groups: ["Finance"] },
});

satisfiesAccess(principal, { roles: [ROLES.Finance] }); // true
satisfiesAccess(principal, { roles: ["Finance"] }); // false — casing is significant
```

---

#### An empty requirement grants access to everyone

**Symptom:** `satisfiesAccess(principal, {})` returns `true` even for a principal with no roles and no permissions. So do `{ mode: "all" }` and `{ roles: [], permissions: [] }`.

**Cause:** By design, an absent or empty requirement is always satisfied so an unconfigured rule cannot lock users out. The flip side is that it cannot lock anyone in, either.

**Fix:** If a check site must never be unconfigured, enforce the configuration explicitly:

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

function requiresConfiguredGrant(
    principal: AccessPrincipal,
    requirement: AccessRequirement
): boolean {
    const roles = requirement.roles ?? [];
    const permissions = requirement.permissions ?? [];

    if (roles.length === 0 && permissions.length === 0) {
        return false; // deny an unconfigured requirement instead of granting it
    }
    return satisfiesAccess(principal, requirement);
}

console.log(requiresConfiguredGrant({ roles: [], permissions: [] }, {})); // false
```

---

#### `"any"` mode passes when only one of two lists is held

**Symptom:** A principal holding only a role satisfies a requirement that also listed a permission it does not hold. Conversely, an `"all"` requirement fails although "every role" was held — because permissions were pooled into the same check.

**Cause:** `satisfiesAccess` flattens roles and permissions into one result set: `"any"` (the default) passes when at least one value anywhere is held; `"all"` requires every listed role *and* every listed permission.

**Fix:** Choose the mode that expresses the rule:

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = { roles: ["admin"], permissions: [] };

satisfiesAccess(principal, { roles: ["admin"], permissions: ["invoice:read"] });
// true — "any" pools the lists

satisfiesAccess(principal, {
    mode: "all",
    roles: ["admin"],
    permissions: ["invoice:read"],
});
// false — "all" requires the permission too
```

If roles and permissions represent independent checks that must all pass, run them as separate `satisfiesAccess` calls rather than as one mixed requirement.

---

## Debugging Strategies

Everything in `blendsdk/authz` is pure and synchronous, so any failure reduces to one of three boundaries: the keys a profile **extracts**, the grants translation **resolves**, and the requirement **evaluation**. The table below maps the symptom to the boundary worth inspecting first; the steps that follow describe each inspection.

| Symptom | Inspect first |
| --- | --- |
| `extract()` returns `[]` | Identity construction and profile choice |
| Extracted keys look wrong or incomplete | Claim precedence, malformed claim shapes |
| Keys look right but grants are empty | Grant map, allowlist, fail-closed default |
| Grants look right but a check denies | Exact strings, `mode`, the candidate principal |
| Grants are empty and `onUnmapped` never fired | Declared-but-empty grant-map entries |

### Step 1 — Inspect exactly what the profile extracts

1. Call `extract` with the exact `ProviderIdentity` object from the failing flow.
2. Compare the resulting keys against the claims you expected.

```typescript
import { azureClaimsProfile } from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

const identity: ProviderIdentity = {
    userInfo: {},
    accessTokenClaims: { scp: "Invoice.Read Invoice.Write", groups: ["Finance"] },
};

console.log(azureClaimsProfile.extract(identity));
// ["scp:Invoice.Read", "scp:Invoice.Write", "group:Finance"]
```

No grant map or allowlist change can create a key that was never extracted — if this array is empty or missing a claim you expected, the problem is the identity data or the profile choice, not translation. Note that extracted keys contain claim *values* (group names, role names), so treat them with the same care as claims themselves when logging.

### Step 2 — Turn on the unmapped-key audit

`onUnmapped` receives every key that yields no grant, with the key name only — it never includes the value part of the key, so it is safe to log routinely. Collect into a `Set` to de-duplicate repeated keys:

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const unmappedKeys = new Set<string>();

const translator = createClaimsTranslator(genericClaimsProfile, {}, {
    allowed: { roles: ["user"] },
    onUnmapped: (key: string): void => {
        unmappedKeys.add(key);
    },
});

translator.translate({ userInfo: { roles: ["user", "app-admin", "app-admin"] } });

console.log([...unmappedKeys]); // ["role:app-admin"]
```

A mapped key never triggers the callback, even when its mapped values are empty. If grants are empty and this set is also empty, inspect the grant map for declared-but-empty entries (see the "mapped key grants nothing" issue above).

### Step 3 — Replay the keys through `resolveGrants`

If the keys are correct, replay them directly against your map and allowlist to test a hypothesis without a live token. First, the full translation decision path:

| The key is… | Translation outcome | `onUnmapped` |
| --- | --- | --- |
| an own property of the `GrantMap` | Grants the mapped roles/permissions, whatever the allowlist says | not called |
| an own property with an empty mapping | Grants nothing | not called |
| unmapped `role:`/`permission:`, value in `allowed` | Grants that one value | not called |
| unmapped `role:`/`permission:`, value not in `allowed` | Grants nothing | called with the key |
| unmapped `scp:`/`group:` or another source | Grants nothing — provider sources are never canonical | called with the key |
| unmapped and without a colon (malformed) | Grants nothing | called with the key |

An inherited property is not "an own property": translation looks entries up with `Object.hasOwn`, so keys that exist only on a prototype of the map grant nothing.

```typescript
import { resolveGrants } from "blendsdk/authz";
import type { AllowedGrants, GrantMap } from "blendsdk/authz";

const map: GrantMap = { "role:app-admin": { roles: ["admin"] } };
const allowed: AllowedGrants = { roles: ["user"] };

const principal = resolveGrants(["role:app-admin", "role:user", "role:root"], map, allowed);

console.log(principal);
// { roles: ["admin", "user"], permissions: [] } — "role:root" yields nothing
```

### Step 4 — Pin all three stages in one test

Because the functions are pure, one test can pin each boundary of the pipeline. If a later change breaks a stage, the failing assertion names it.

```typescript
import { describe, expect, it } from "vitest";

import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

describe("access smoke test", () => {
    it("should carry a claim from identity to a satisfied requirement", () => {
        const translator = createClaimsTranslator(genericClaimsProfile, {}, {
            allowed: { permissions: ["invoice:read"] },
        });

        const identity: ProviderIdentity = {
            userInfo: { permissions: ["invoice:read"] },
        };

        expect(genericClaimsProfile.extract(identity)).toEqual(["permission:invoice:read"]);

        const principal = translator.translate(identity);
        expect(principal.permissions).toEqual(["invoice:read"]);

        expect(satisfiesAccess(principal, { permissions: ["invoice:read"] })).toBe(true);
    });
});
```

Inside this repository you can also run `npm test` in `packages/authz` to execute the package's own specification and implementation suites, which encode the rules quoted in this document.

### Step 5 — Verify the evaluation inputs character-for-character

Before concluding that evaluation is wrong, print the exact inputs. `JSON.stringify` makes trailing spaces and casing visible:

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

export function debugAccess(
    principal: AccessPrincipal,
    requirement: AccessRequirement
): boolean {
    console.log("principal.roles:", JSON.stringify(principal.roles));
    console.log("principal.permissions:", JSON.stringify(principal.permissions));
    console.log("requirement:", JSON.stringify(requirement));

    const result = satisfiesAccess(principal, requirement);
    console.log("satisfiesAccess:", result);
    return result;
}

debugAccess({ roles: ["admin"], permissions: [] }, { roles: ["admin "] });
// The requirement string has a trailing space: the check returns false.
```

If the arrays are not arrays at this point — for example a `roles` string read from JSON configuration — the call throws before any comparison runs (see the first pitfall below).

---

## Known Pitfalls

These behaviors are correct by design — and precisely what makes them easy to miss.

### Stored principals and requirements are not validated at runtime

TypeScript protects the data you construct, not the data you deserialize. A principal loaded from a session store or cache may lack its arrays entirely, and evaluation assumes `roles` and `permissions` exist — it immediately calls `.some()` on both. A malformed principal throws `TypeError: Cannot read properties of undefined (reading 'some')` (or `... of null ...`), and a malformed requirement whose `roles` is a string throws `TypeError: roles.map is not a function`, both before any authorization decision happens.

Rebuild principals from stored values instead of trusting them:

```typescript
import type { AccessPrincipal } from "blendsdk/authz";

/** Coerce an unknown value into an array of strings, dropping everything else. */
function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is string => typeof entry === "string");
}

/** Rebuild a principal from a session-stored value. */
export function toAccessPrincipal(value: unknown): AccessPrincipal {
    if (typeof value !== "object" || value === null) {
        return { roles: [], permissions: [] };
    }

    return {
        roles: "roles" in value ? readStringArray(value.roles) : [],
        permissions: "permissions" in value ? readStringArray(value.permissions) : [],
    };
}

const restored = toAccessPrincipal(JSON.parse('{"role":"admin","permissions":["invoice:read"]}'));
console.log(restored);
// { roles: [], permissions: ["invoice:read"] } — the singular "role" key is dropped
```

Apply the same `readStringArray` treatment to any requirement that arrives from JSON configuration before passing it to `satisfiesAccess`.

### Duplicate claim values fire `onUnmapped` per occurrence

Profiles report keys exactly as the claims present them, without de-duplicating. `resolveGrants` de-duplicates granted values, but the `onUnmapped` callback is invoked once per occurrence of a key that yields no grant — so `roles: ["ghost", "ghost"]` triggers it twice.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

let calls = 0;
const translator = createClaimsTranslator(genericClaimsProfile, {}, {
    onUnmapped: (): void => {
        calls += 1;
    },
});

translator.translate({ userInfo: { roles: ["ghost", "ghost"] } });

console.log(calls); // 2 — the grant output is de-duplicated, the callback is not
```

Collect keys in a `Set` (see Debugging step 2), or de-duplicate the claim array before building the identity:

```typescript
const uniqueRoles = [...new Set(["ghost", "ghost"])]; // ["ghost"]
```

### `isOneOf` narrowing degrades to `string` with a widened list

The guard's `const` type parameter infers from the argument's declared type. Pass a list that has already been widened to `string[]` and the narrowed value is just `string`; pass the values of an `as const` object and you get the precise union.

```typescript
import { isOneOf } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;

const widened: string[] = Object.values(ROLES);
const first: unknown = "admin";

if (isOneOf(first, widened)) {
    const role: string = first; // narrowed only to `string`
    console.log(role);
}

const second: unknown = "admin";

if (isOneOf(second, Object.values(ROLES))) {
    const role: "admin" | "user" = second; // narrowed to the application union
    console.log(role);
}
```

### Claim precedence applies per claim, not per source

"`accessTokenClaims` wins" only applies to claim names that the access token actually defines. Each claim is resolved independently, so one claim can come from the access token while another falls back to user info.

```typescript
import { genericClaimsProfile } from "blendsdk/authz";

genericClaimsProfile.extract({
    userInfo: { permissions: ["invoice:read"] },
    accessTokenClaims: { roles: ["admin"] },
});
// ["role:admin", "permission:invoice:read"] — both survive
```

Do not assume one source's values are kept or discarded wholesale; check the extracted keys for each claim you rely on.

### Grant order is first-seen, not sorted

Grants are de-duplicated and appended in first-seen order across mapped and canonical keys. Snapshots, serialized sessions, and array comparisons depend on that order, and it changes when claim order changes.

```typescript
import { resolveGrants } from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

const map: GrantMap = { "group:z": { roles: ["zeta"] } };

const principal = resolveGrants(["group:z", "role:alpha"], map, { roles: ["alpha"] });

console.log(principal.roles); // ["zeta", "alpha"] — first-seen order, not sorted
```

If order matters for display or storage, sort deliberately (`[...principal.roles].sort()`) instead of relying on claim order. Also remember that a value granted by both a mapped and a canonical key appears exactly once.

### `ProviderIdentity.scopes` is ignored by both built-in profiles

The dedicated `scopes` array exists for custom profiles only. `genericClaimsProfile` reads `roles` and `permissions` claims, and `azureClaimsProfile` reads the Azure `scp` string and `groups` — neither reads `identity.scopes`. If your provider data lives in that array, nothing is extracted and every check fails closed.

```typescript
import { azureClaimsProfile, genericClaimsProfile, grantKey } from "blendsdk/authz";
import type { ClaimsProfile, ProviderIdentity } from "blendsdk/authz";

const identity: ProviderIdentity = {
    userInfo: {},
    scopes: ["Invoice.Read"],
};

genericClaimsProfile.extract(identity); // []
azureClaimsProfile.extract(identity); // []

const scopeProfile: ClaimsProfile = {
    name: "scope-list",
    extract(providerIdentity: ProviderIdentity): readonly string[] {
        const scopes = providerIdentity.scopes ?? [];
        return scopes.map((scope) => grantKey("scp", scope));
    },
};

scopeProfile.extract(identity);
// ["scp:Invoice.Read"] — still needs a map entry to grant anything
```

Keys produced from `scopes` use a provider-specific source, so they follow the usual rule: they grant nothing until the grant map maps them.

### A custom profile's output is trusted

The built-in profiles defensively filter provider data, but nothing filters what a custom `extract` returns — the strings are trusted per the `ClaimsProfile` contract. If a profile can emit non-string entries, translation eventually calls `.indexOf` on them while splitting the key and throws `TypeError: key.indexOf is not a function` for any entry that is not mapped.

```typescript
import { grantKey } from "blendsdk/authz";
import type { ClaimsProfile, ProviderIdentity } from "blendsdk/authz";

const safeProfile: ClaimsProfile = {
    name: "safe-entitlements",
    extract(identity: ProviderIdentity): readonly string[] {
        const raw = identity.userInfo["entitlements"];
        if (!Array.isArray(raw)) {
            return [];
        }
        return raw
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => grantKey("permission", entry));
    },
};

safeProfile.extract({ userInfo: { entitlements: ["invoice:read", 7, null] } });
// ["permission:invoice:read"] — malformed entries are dropped before translation
```

Mirror the built-in behavior in every custom profile: ignore non-array claims, drop non-string entries, and return keys as plain strings.

---

When in doubt, reduce the failure to `profile.extract` → `resolveGrants` → `satisfiesAccess`. The package holds no hidden state and performs no I/O, so those three calls always reproduce the behavior you are debugging.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
