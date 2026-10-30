> **Package**: `blendsdk/authz`

# authz Advanced Patterns

The Core Concepts document covers each part of `blendsdk/authz` on its own. This document covers what happens when the parts are composed into production systems: translating identities once and evaluating for months, onboarding providers whose claims you do not control, mixing claim-derived grants with request-time data, and keeping server and browser decisions in agreement. Each pattern is self-contained — the problem it solves, a complete example, why the structure is worth it, and the caveats that matter at scale.

All examples are ESM, strict TypeScript, and complete: every block imports what it uses and can be pasted into a project as is. Illustrative snippets are marked as fragments.

| # | Pattern | Use it when | Primary exports |
| --- | --- | --- | --- |
| 1 | [Translate Once at the Edge, Evaluate Everywhere](#1-translate-once-at-the-edge-evaluate-everywhere) | every request re-reads claims or re-runs translation | `createClaimsTranslator`, `satisfiesAccess` |
| 2 | [One Module Owns the Vocabulary and the Mapping](#2-one-module-owns-the-vocabulary-and-the-mapping) | role and permission strings are drifting across modules | `GrantMap`, `grantKey`, `AllowedGrants` |
| 3 | [Telemetry-Driven Onboarding with onUnmapped](#3-telemetry-driven-onboarding-with-onunmapped) | you are adopting a provider and cannot see which claims arrive | `TranslatorOptions.onUnmapped` |
| 4 | [Multi-Provider Registries with Per-Provider Maps](#4-multi-provider-registries-with-per-provider-maps) | more than one identity provider feeds one application | `azureClaimsProfile`, `genericClaimsProfile` |
| 5 | [Custom Claim Profiles for Non-Standard Providers](#5-custom-claim-profiles-for-non-standard-providers) | the provider's claims match neither built-in profile | `ClaimsProfile`, `grantKey` |
| 6 | [Hybrid Grants: Session Roles Plus Request-Time ACLs](#6-hybrid-grants-session-roles-plus-request-time-acls) | checks depend on resource-specific data outside the token | `satisfiesAccess`, `AccessPrincipal` |
| 7 | [One Requirement Catalog for Server and Browser](#7-one-requirement-catalog-for-server-and-browser) | UI gating and API checks keep drifting apart | `satisfiesAccess`, `isOneOf` |
| 8 | [A Request-Scoped Access Facade with a Misconfiguration Guard](#8-a-request-scoped-access-facade-with-a-misconfiguration-guard) | call sites invent their own checks and error handling | `satisfiesAccess`, `AccessRequirement` |

---

## 1. Translate Once at the Edge, Evaluate Everywhere

### When To Use It

Use this pattern when the application authenticates with an external identity provider and then runs many checks per session:

- claim reading involves network calls (such as the OIDC `/userinfo` endpoint) or token decoding you do not want inside every request handler;
- the same principal must back server-side decisions and render-time decisions in the browser;
- sessions should stay stable between sign-ins — grants change only when you decide they do.

This is the posture the package is designed around: translate a provider identity once, store the resulting `AccessPrincipal` on the session, and evaluate every later requirement against it.

### The Pattern

Translation consumes a `ProviderIdentity`; evaluation consumes an `AccessPrincipal`. Those are two different lifetimes, so give each its own home: do all provider-shaped work in one sign-in path, store its output, and let request paths touch only the stored principal.

```typescript
// fragment — before: every check re-reads the provider identity and re-translates
const principal = translator.translate(identityFromRequest(request));
if (!satisfiesAccess(principal, { permissions: ["invoice:read"] })) {
    throw new Error("Forbidden");
}
```

The `before` version re-runs claim reading per check, can disagree with itself when claims change mid-request, and forces every call site to know how identities are built. The `after` version translates exactly once, then every check is a pure function over stored data.

### Complete Example

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";
import type {
    AccessPrincipal,
    AccessRequirement,
    ProviderIdentity,
} from "blendsdk/authz";

// Built once at startup; never rebuilt per request.
const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: ["admin"] } },
    { allowed: { roles: ["user"], permissions: ["invoice:read", "invoice:write"] } }
);

interface Session {
    sessionId: string;
    principal: AccessPrincipal;
}

interface SessionStore {
    save(session: Session): Promise<void>;
    load(sessionId: string): Promise<Session | undefined>;
}

class InMemorySessionStore implements SessionStore {
    #sessions = new Map<string, Session>();

    async save(session: Session): Promise<void> {
        this.#sessions.set(session.sessionId, session);
    }

    async load(sessionId: string): Promise<Session | undefined> {
        return this.#sessions.get(sessionId);
    }
}

// Runs once, at sign-in: the only place a ProviderIdentity is read.
async function establishSession(
    store: SessionStore,
    sessionId: string,
    identity: ProviderIdentity
): Promise<AccessPrincipal> {
    const principal = translator.translate(identity);
    await store.save({ sessionId, principal });
    return principal;
}

// Runs per request: evaluation only — no claims, no translation.
async function authorize(
    store: SessionStore,
    sessionId: string,
    requirement: AccessRequirement
): Promise<boolean> {
    const session = await store.load(sessionId);
    if (session === undefined) {
        return false;
    }
    return satisfiesAccess(session.principal, requirement);
}

const store = new InMemorySessionStore();

const principal = await establishSession(store, "s-100", {
    userInfo: {
        roles: ["app-admin", "user"],
        permissions: ["invoice:read"],
    },
});
// { roles: ["admin", "user"], permissions: ["invoice:read"] }

await authorize(store, "s-100", { permissions: ["invoice:read"] }); // true
await authorize(store, "s-100", { permissions: ["invoice:write"] }); // false
await authorize(store, "s-404", { permissions: ["invoice:read"] }); // false — unknown session
```

### Why This Pattern Is Valuable

- **One provider-shaped step per identity.** After sign-in, every decision is a pure, synchronous function over plain data — identical on the server and in the browser.
- **The session stops needing claims.** Once the principal is stored, tokens and raw claims can be discarded; the principal is the only artifact that matters, which shrinks both the attack surface and the state the session must protect.
- **One conversion point is one audit point.** The stored principal is exactly what every later check read — there is no second code path that can disagree.
- **Consistency within a request.** A claim that changes upstream cannot make two checks in the same request disagree, because translation happened before the request existed.
- **Serializable by construction.** `AccessPrincipal` is plain JSON, so any session mechanism — a cookie, a session table, or a cache layer in the stack — can hold it without adapters.

### Caveats and Performance

- **Staleness** — the principal does not update when provider grants change. Re-translate on re-auth or token refresh, or on a schedule; decide the TTL deliberately instead of discovering it during an incident.
- **Integrity** — the principal is authority: a forged or tampered session is a forged role list. Store it behind signed cookies or server-side sessions; never hydrate a principal from a request body.
- **Re-translation needs the identity** — refreshing without re-auth requires a refresh token or another way to rebuild `ProviderIdentity`. Plan which flow rebuilds the principal before promising instant revocation.
- **Cookie budget** — grants are short strings, but very large grant sets can approach typical ~4 KB cookie limits; switch to server-side session storage as lists grow.
- **Don't translate in two places** — if the browser also translates claims, you get two pipelines that can disagree. Translate at the edge and serialize the principal (pattern 7 shows the client half).

---

## 2. One Module Owns the Vocabulary and the Mapping

### When To Use It

Use this pattern when more than one module compares roles or permissions:

- route guards, request handlers, background jobs, and UI components all reference grant names;
- provider labels map to canonical values and one provider rename currently means edits in several files;
- you want typos to be compile errors and the allowlist to be incapable of drifting from the vocabulary.

### The Pattern

One module owns three things: the vocabulary, the authority configuration, and (optionally) the translator. Everything else imports from it. Because `Role` and `Permission` are aliases for `string`, a raw literal always compiles — constants are the only mechanism the compiler can check.

```typescript
// fragment — before: a raw literal compiles (every string is a Permission) and denies in silence
const canWrite = hasPermission(principal, "invoic:write");
```

```typescript
// fragment — after: a missing constant is a compile error; the value lives in one module
const canWrite = hasPermission(principal, PERMISSIONS.InvoiceWrite);
```

Two details make the module safe to grow: build map keys with `grantKey` when they are derived, and derive the allowlist from the same constants the checks use, so a value can never be defined in one list and forgotten in the other.

### Complete Example

```typescript
import {
    azureClaimsProfile,
    createClaimsTranslator,
    grantKey,
    satisfiesAccess,
} from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

// --- Vocabulary: every role and permission the application knows ---
const ROLES = { Admin: "admin", Finance: "finance" } as const;
const PERMISSIONS = {
    InvoiceRead: "invoice:read",
    InvoiceWrite: "invoice:write",
    ReportExport: "report:export",
} as const;

// --- Authority configuration: the only place provider labels appear ---
const GRANTS: GrantMap = {
    [grantKey("group", "Finance")]: { roles: [ROLES.Finance] },
    [grantKey("scp", "Invoice.Read")]: { permissions: [PERMISSIONS.InvoiceRead] },
    [grantKey("scp", "Invoice.Write")]: { permissions: [PERMISSIONS.InvoiceWrite] },
};

// Derived from the vocabulary, so the allowlist cannot drift from it.
const ALLOWED = {
    roles: Object.values(ROLES),
    permissions: Object.values(PERMISSIONS),
};

const translator = createClaimsTranslator(azureClaimsProfile, GRANTS, {
    allowed: ALLOWED,
});

const principal = translator.translate({
    userInfo: {},
    accessTokenClaims: {
        roles: ["admin"],
        scp: "Invoice.Read Invoice.Write",
        groups: ["Finance"],
    },
});
// { roles: ["admin", "finance"], permissions: ["invoice:read", "invoice:write"] }

satisfiesAccess(principal, {
    mode: "all",
    permissions: [PERMISSIONS.InvoiceRead, PERMISSIONS.InvoiceWrite],
}); // true

satisfiesAccess(principal, { permissions: [PERMISSIONS.ReportExport] }); // false
```

Renaming `InvoiceRead` from `"invoice:read"` to `"billing:invoice:read"` is a single edit: the allowlist derives from the constant, and every requirement written against `PERMISSIONS.InvoiceRead` follows automatically. The Azure scope keys in `GRANTS` are untouched because they map to the constant, not to the string.

### Why This Pattern Is Valuable

- **The compiler becomes the vocabulary's enforcement.** Raw literals are valid `Permission` values and can only fail at runtime; constant identifiers fail at build time.
- **Drift is structurally impossible.** The allowlist, the checks, and the map all read the same constants, so "permission exists but is not allowed" or vice versa cannot happen by omission.
- **Provider names live in exactly one place.** Onboarding a provider label, or retiring one, is a reviewable one-file diff under `GRANTS`.
- **Shared across runtimes.** The module has no dependencies and no side effects, so the browser can gate on exactly the vocabulary the server enforces (pattern 7 builds on this module).

### Caveats and Performance

- **Derived allowlists are broad by default.** Every vocabulary value becomes directly grantable from a canonical `role:` or `permission:` claim. If the provider can assert arbitrary claim names, list the allowed subset explicitly instead of deriving `Object.values`.
- **Constants fix disagreement, not wrong values.** A mistyped permission value is still mistyped — but it is mistyped in one place, reviewable in one diff.
- **Keep the module neutral.** It will be imported by browser code: no server-only logic, no secrets. A grant map is policy, but treat changes to it as security-relevant changes.
- **The translator does not have to live here.** Build translators where translation happens (sign-in paths) so claim handling stays out of the browser bundle; the vocabulary module is the shared part.

---

## 3. Telemetry-Driven Onboarding with `onUnmapped`

### When To Use It

Use this pattern when you are adopting a provider whose claims you do not yet fully control or understand:

- the first Azure app registration, where scopes and directory groups arrive in production shapes you cannot enumerate in advance;
- a support workflow where "this user is missing a permission" currently has no explanation;
- a regression watch, where a provider renaming a claim should be visible before users complain.

Failing closed is correct but blind: an unmapped claim produces no grant and no signal. `onUnmapped` is the signal.

### The Pattern

Attach `onUnmapped` at the same time you attach the allowlist, and treat its output as the onboarding checklist:

1. Build the translator with the current map and allowlist, plus a collector that tallies every key that yields no grant.
2. Let real sign-ins flow; each key that currently grants nothing is counted, by name.
3. Review the tally: for every key, either add a grant-map entry or explicitly accept that the key grants nothing.
4. Redeploy with the updated map; the keys in the tally stop firing. Repeat as the provider evolves.

The callback receives the key name only — never a claim value — so it is safe to log by design.

```typescript
// fragment — before: fail closed, but blind — nothing reports what was dropped
const translator = createClaimsTranslator(azureClaimsProfile, grants, { allowed });
```

### Complete Example

```typescript
import { azureClaimsProfile, createClaimsTranslator } from "blendsdk/authz";
import type { GrantMap, ProviderIdentity, TranslatorOptions } from "blendsdk/authz";

// The collector: key names only, never claim values.
const unmappedCounts = new Map<string, number>();

const options: TranslatorOptions = {
    allowed: { roles: ["viewer"] },
    onUnmapped: (key: string): void => {
        // Never throw from telemetry: a sink failure must not break sign-in.
        try {
            unmappedCounts.set(key, (unmappedCounts.get(key) ?? 0) + 1);
        } catch {
            // Intentionally ignored.
        }
    },
};

const grantsV1: GrantMap = {
    "group:Finance": { roles: ["finance"] },
    "scp:Invoice.Read": { permissions: ["invoice:read"] },
};

const translatorV1 = createClaimsTranslator(azureClaimsProfile, grantsV1, options);

const identity: ProviderIdentity = {
    userInfo: {},
    accessTokenClaims: {
        roles: ["viewer"],
        scp: "Invoice.Read Unknown.Scope",
        groups: ["Finance", "Marketing"],
    },
};

const principalV1 = translatorV1.translate(identity);
// { roles: ["viewer", "finance"], permissions: ["invoice:read"] }

console.log([...unmappedCounts.entries()]);
// [["scp:Unknown.Scope", 1], ["group:Marketing", 1]]

// Stage 2 — map exactly the keys the telemetry surfaced, then redeploy.
const grantsV2: GrantMap = {
    ...grantsV1,
    "group:Marketing": { roles: ["marketing"] },
    "scp:Unknown.Scope": { permissions: ["report:read"] },
};

const translatorV2 = createClaimsTranslator(azureClaimsProfile, grantsV2, options);
const principalV2 = translatorV2.translate(identity);
// { roles: ["viewer", "finance", "marketing"], permissions: ["invoice:read", "report:read"] }

console.log([...unmappedCounts.entries()]);
// unchanged — every key now yields a grant, so nothing new was reported
```

Note what did *not* fire: `role:viewer` (allowed), `scp:Invoice.Read` and `group:Finance` (mapped). The tally is exactly the set of claims that currently grant nothing.

### Why This Pattern Is Valuable

- **Fail-closed becomes observable.** "Some users lack permissions" turns into a concrete, prioritized list of provider keys and how often each arrives.
- **The callback cannot leak claim values.** It receives the key name only, so recording it does not move user data into logs.
- **It doubles as a regression detector.** If the provider renames a scope, the old mapping stops matching and the new key appears in the tally — before it becomes a support ticket.
- **The loop converges.** Each pass through steps 2–4 removes exactly the keys you have decided about, and mapped keys never fire again, even when their mapped values are empty.

### Caveats and Performance

- **Never let the callback throw.** It runs synchronously inside `translate`; a throwing sink would abort sign-in. Wrap all telemetry code in `try`/`catch`, as above.
- **Keep it cheap.** Aggregate in an in-memory `Map` and flush elsewhere; do not perform network I/O inside the callback.
- **Keys are provider-controlled text.** Treat them as low-trust: aggregate and cap cardinality rather than streaming unbounded raw strings into logs or alerting.
- **Counts are per process and per translation.** Repeated sign-ins and duplicate claim entries inflate counts — fine for discovery, not for precise accounting. Ship the tally to a shared sink for fleet-wide visibility.
- **Firing does not mean the claim is bad.** Some keys are intentionally ignorable; the point is that every key gets an explicit decision, not that every key becomes a mapping.

---

## 4. Multi-Provider Registries with Per-Provider Maps

### When To Use It

Use this pattern when more than one identity provider feeds the same application:

- enterprise customers authenticate through Azure Entra ID while consumer users use a generic OIDC provider;
- an acquisition brought its own IdP, and both must coexist during migration;
- tenant-specific registrations produce different group identifiers that map into the same canonical vocabulary.

### The Pattern

Keys are plain strings, so a shared map cannot know which provider produced a key. If two providers can ever emit the same key string with different meanings, a shared map lets one provider inherit the other's mappings.

```typescript
// fragment — one shared map for two providers: keys collide where claims overlap
const shared: GrantMap = { "group:Finance": { roles: ["finance"] } };
// If a second provider can ever emit "group:Finance", it inherits this mapping —
// a grant the application never intended for that provider.
```

The fix is a registry: each provider gets its own translator — profile, grant map, and allowlist — while all translators converge on one canonical vocabulary. Dispatch at sign-in, based on the provider that authenticated the caller, and store only the resulting principal.

### Complete Example

```typescript
import {
    azureClaimsProfile,
    createClaimsTranslator,
    genericClaimsProfile,
    isOneOf,
    satisfiesAccess,
} from "blendsdk/authz";
import type {
    AccessPrincipal,
    ClaimsTranslator,
    ProviderIdentity,
} from "blendsdk/authz";

const PROVIDERS = { Azure: "azure", Oidc: "oidc" } as const;
type ProviderName = (typeof PROVIDERS)[keyof typeof PROVIDERS];

const ROLES = { Admin: "admin", Finance: "finance" } as const;

// One translator per provider, each with its own map and allowlist.
const TRANSLATORS = new Map<ProviderName, ClaimsTranslator>([
    [
        PROVIDERS.Azure,
        createClaimsTranslator(
            azureClaimsProfile,
            {
                "group:Finance": { roles: [ROLES.Finance] },
                "scp:Invoice.Read": { permissions: ["invoice:read"] },
            },
            { allowed: { roles: [ROLES.Admin] } }
        ),
    ],
    [
        PROVIDERS.Oidc,
        createClaimsTranslator(
            genericClaimsProfile,
            { "role:app-admin": { roles: [ROLES.Admin] } },
            { allowed: { permissions: ["invoice:read"] } }
        ),
    ],
]);

// The provider identifier may arrive from a callback; validate it before use.
function resolveProvider(raw: unknown): ProviderName {
    if (isOneOf(raw, Object.values(PROVIDERS))) {
        return raw;
    }
    throw new Error("Unknown identity provider.");
}

function translateIdentity(
    provider: ProviderName,
    identity: ProviderIdentity
): AccessPrincipal {
    const translator = TRANSLATORS.get(provider);
    if (!translator) {
        throw new Error(`No translator registered for provider "${provider}".`);
    }
    return translator.translate(identity);
}

const azurePrincipal = translateIdentity(resolveProvider("azure"), {
    userInfo: {},
    accessTokenClaims: {
        roles: ["admin"],
        scp: "Invoice.Read",
        groups: ["Finance"],
    },
});
// { roles: ["admin", "finance"], permissions: ["invoice:read"] }

const oidcPrincipal = translateIdentity(resolveProvider("oidc"), {
    userInfo: { roles: ["app-admin"], permissions: ["invoice:read"] },
});
// { roles: ["admin"], permissions: ["invoice:read"] }

// One requirement, evaluated identically against either provider's principal.
satisfiesAccess(azurePrincipal, { permissions: ["invoice:read"] }); // true
satisfiesAccess(oidcPrincipal, { permissions: ["invoice:read"] }); // true
```

### Why This Pattern Is Valuable

- **Evaluation stays provider-agnostic.** Requirements, UI gating, and stored principals never learn which provider authenticated the caller; only the registry does.
- **Cross-provider privilege bleed is impossible.** Identical key strings from different providers cannot inherit each other's mappings, because there is no shared map to inherit from.
- **Onboarding is additive.** A new provider is a new registry entry; no check, requirement, or principal shape changes.
- **Allowlists can be tailored per provider.** You can apply less trust to providers whose claim names you do not control, and more to ones you do.

### Caveats and Performance

- **Dispatch on an identifier you control.** If the provider name arrives from user input (a callback parameter, a query string), validate it first — `isOneOf` narrows it without a cast, as shown.
- **Store the provider name with the session** if later re-translation (pattern 1) needs to rerun the right translator.
- **Never "simplify" to one shared map.** That is exactly the collision hazard this pattern removes; keep maps per provider even when they look identical today.
- **Multi-tenant variants extend the key.** When each tenant has distinct group identifiers, register a translator per tenant at startup — construction is one-time and cheap, and the registry key becomes tenant plus provider.
- **Keep the canonical vocabulary identical across translators.** Divergent vocabularies would make requirements provider-specific again, which is the problem the registry solves.

---

## 5. Custom Claim Profiles for Non-Standard Providers

### When To Use It

Use a custom `ClaimsProfile` when the provider's claims match neither built-in profile:

- role claims arrive as a delimited string rather than an array, or as `string | string[]` depending on tenant configuration;
- permissions live under provider-specific claim names, and the OAuth scopes you care about are on `identity.scopes`;
- you need a different claim precedence, or filtering the built-ins do not apply.

Both built-ins are just implementations of the same tiny contract: `name` plus a pure `extract(identity)` that returns namespaced keys. Implementing it adds a provider without touching translation or evaluation.

### The Pattern

A custom profile should follow the same conventions as the built-ins:

- resolve each claim with an explicit precedence (`userInfo` → `idTokenClaims` → `accessTokenClaims`, the access token winning);
- filter malformed shapes instead of throwing — a profile runs inside every translation;
- emit keys with `grantKey` so the `source:value` format stays consistent;
- stay pure: no I/O, no mutation, no side effects.

A profile reports what the provider said — nothing more. Its `permission:` keys are still gated by the allowlist and its `scp:`/`group:` keys still require map entries, so a custom profile cannot bypass the authority model.

### Complete Example

```typescript
import { createClaimsTranslator, grantKey, satisfiesAccess } from "blendsdk/authz";
import type { ClaimsProfile, GrantMap, ProviderIdentity } from "blendsdk/authz";

// Helper 1: the same per-claim precedence the built-in profiles use —
// userInfo, then idTokenClaims, then accessTokenClaims (the access token wins).
function mergedClaim(identity: ProviderIdentity, name: string): unknown {
    const sources = [
        identity.userInfo,
        identity.idTokenClaims,
        identity.accessTokenClaims,
    ];

    let value: unknown;
    for (const source of sources) {
        if (source && Object.hasOwn(source, name)) {
            value = source[name];
        }
    }
    return value;
}

// Helper 2: accept a string array, a delimited string, or nothing.
function readStringList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === "string");
    }
    if (typeof value === "string") {
        return value.split(/[,\s]+/).filter(entry => entry.length > 0);
    }
    return [];
}

// A provider whose directory emits "role_list" and "entitlements" claims
// and whose OAuth scopes are only available on identity.scopes.
const directoryClaimsProfile: ClaimsProfile = {
    name: "directory",
    extract(identity: ProviderIdentity): readonly string[] {
        const keys = new Set<string>();

        for (const role of readStringList(mergedClaim(identity, "role_list"))) {
            keys.add(grantKey("role", role));
        }
        for (const entitlement of readStringList(mergedClaim(identity, "entitlements"))) {
            keys.add(grantKey("permission", entitlement));
        }
        for (const scope of identity.scopes ?? []) {
            keys.add(grantKey("scp", scope));
        }

        return [...keys];
    },
};

const GRANTS: GrantMap = {
    [grantKey("role", "finance")]: { roles: ["finance"] },
    [grantKey("scp", "api:read")]: { permissions: ["api:read"] },
};

const translator = createClaimsTranslator(directoryClaimsProfile, GRANTS, {
    allowed: { permissions: ["invoice:read"] },
});

const principal = translator.translate({
    userInfo: { role_list: "finance, support" },
    idTokenClaims: { entitlements: ["invoice:read"] },
    scopes: ["api:read"],
});
// keys: role:finance, role:support, permission:invoice:read, scp:api:read
// { roles: ["finance"], permissions: ["invoice:read", "api:read"] }

satisfiesAccess(principal, { permissions: ["invoice:read"] }); // true
```

### Why This Pattern Is Valuable

- **Provider quirks stop at the edge.** Delimited strings, optional arrays, and scope handling are normalized into namespaced keys, so nothing downstream sees provider-specific shapes.
- **The pipeline is untouched.** Translation, evaluation, vocabulary, and requirements are identical for custom and built-in profiles — the profile is a strategy, not a fork.
- **The profile is trivially testable.** Feed fixture identities and assert the keys, exactly as the packaged specification tests do for the built-ins — no provider, no tokens, no network.
- **Conventions keep reviews predictable.** Reusing the documented precedence order, string filtering, and `grantKey` means maintainers can reason about a custom profile with the same expectations as the built-ins.

### Caveats and Performance

- **Never throw, always filter.** Profiles run inside `createClaimsTranslator`; malformed claims contribute nothing rather than failing the translation.
- **Document your precedence if you deviate.** Callers assume the built-in order (`userInfo` → `idTokenClaims` → `accessTokenClaims`); an undocumented difference is a future bug.
- **Deduplicate deliberately.** The `Set` above keeps audit counts (`onUnmapped`) and logs per unique key; translation would tolerate duplicates, but the noise is not worth it.
- **Keep it cheap and pure.** `extract` runs on every translation — make it a linear pass over claims with no I/O and no mutation of the identity.
- **Emit only what should be mappable.** Every key you emit is a potential grant once mapped or allowlisted; do not surface claims you never intend to authorize with.

---

## 6. Hybrid Grants: Session Roles Plus Request-Time ACLs

### When To Use It

Use this pattern when authorization depends on data that no token can carry:

- "can this user approve invoice 42?" depends on ownership, project membership, or share links stored in the application database;
- some users hold a broad capability (a role-level `invoice:approve`) while others hold only instance-level grants;
- you want one evaluator for both kinds of decisions instead of a second, parallel authorization system.

### The Pattern

The package evaluates whatever `{ roles, permissions }` you hand it and does not care where the grants came from. So keep the session principal for claim-derived grants, load resource-specific grants at request time, merge them into a fresh principal, and run the same `satisfiesAccess` over the result.

The instance grants are ordinary `Permission` strings — `invoice:42:approve` is just a value the ACL decided. The requirement uses `"any"` mode (the default) to express a hierarchy: a global approver *or* an instance-specific approver passes.

### Complete Example

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, Permission } from "blendsdk/authz";

// The session principal: claim-derived grants, translated once at sign-in.
const session: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read"],
};

// Resource-specific grants live where the resource data lives.
interface InvoiceAcl {
    permissionsFor(userId: string, invoiceId: number): Promise<readonly Permission[]>;
}

class InMemoryInvoiceAcl implements InvoiceAcl {
    async permissionsFor(userId: string, invoiceId: number): Promise<readonly Permission[]> {
        // Stand-in for the ACL store: user u-100 may approve invoice 42.
        if (userId === "u-100" && invoiceId === 42) {
            return ["invoice:42:approve"];
        }
        return [];
    }
}

// Merge into a fresh principal; never mutate the session's grants.
function withResourceGrants(
    base: AccessPrincipal,
    resourceGrants: readonly Permission[]
): AccessPrincipal {
    const permissions = [...base.permissions];
    for (const permission of resourceGrants) {
        if (!permissions.includes(permission)) {
            permissions.push(permission);
        }
    }
    return { roles: base.roles, permissions };
}

async function canApproveInvoice(
    base: AccessPrincipal,
    acl: InvoiceAcl,
    userId: string,
    invoiceId: number
): Promise<boolean> {
    const effective = withResourceGrants(base, await acl.permissionsFor(userId, invoiceId));
    return satisfiesAccess(effective, {
        // "any" (the default): a global approver or an instance-specific grant both pass.
        permissions: ["invoice:approve", `invoice:${invoiceId}:approve`],
    });
}

const acl = new InMemoryInvoiceAcl();

await canApproveInvoice(session, acl, "u-100", 42); // true — the instance grant is held
await canApproveInvoice(session, acl, "u-100", 43); // false — no grant for invoice 43
satisfiesAccess(session, { permissions: ["invoice:42:approve"] }); // false — grant is request-scoped
console.log(session.permissions); // ["invoice:read"] — the base principal is untouched
```

### Why This Pattern Is Valuable

- **One evaluator, two grant sources.** RBAC-style claims and instance-level ACLs reduce to the same `AccessPrincipal` shape, so there is no second authorization system to learn, audit, or keep consistent.
- **Hierarchies without new machinery.** `"any"` mode expresses "broad capability or specific grant" with no wildcard support needed — the requirement simply lists both candidates.
- **The session stays minimal.** Instance grants are fetched where they are verifiable (server-side, next to the data) and never persisted into the session, where they would go stale.
- **Immutable by construction.** Merging produces a new principal, which keeps request-scoped grants from leaking into shared session state.

### Caveats and Performance

- **One ACL read per decision.** Rendering a list of resources invites an N+1 pattern — batch-load ACLs for the whole page and merge per resource, or cache the lookup per request.
- **No wildcard expansion exists.** `invoice:*` is a literal permission string, not a pattern; the evaluator matches exactly. Keep instance permission names deterministic (`invoice:<id>:approve`) and mint them only in server-side code.
- **Do not persist merged principals.** ACLs change server-side; a stored merged principal is a stale snapshot of a database row.
- **Matching is linear.** Each held permission is compared by exact equality, which is negligible at normal grant counts; if a principal ever carries thousands of grants, precompute sets in application code — the evaluator contract stays the same.
- **The client must not supply these grants.** Only the server can read the ACL store; if the UI needs the same view, send the resulting decisions, not the raw ACL data.

---

## 7. One Requirement Catalog for Server and Browser

### When To Use It

Use this pattern whenever the same authorization decision is made more than once:

- the API must reject an edit the UI also hides or disables;
- route guards in the browser should apply the same rules as request handlers;
- you are tired of "the button was there but the API said no" drift between two hand-written copies of the same rule.

### The Pattern

Define each decision once as an `AccessRequirement` in a shared catalog. Then use it in three consumers that cannot disagree:

1. the server, which translates the identity and re-checks the requirement on every API call (enforcement);
2. the browser, which hydrates the canonical principal the server serialized and evaluates the same requirement to gate UI (UX only);
3. any route guard or renderer, which reads the same catalog entries.

Hydration is what makes the browser side trustworthy in shape: the payload is validated against the application's vocabulary with `isOneOf`, so junk values are filtered out and a malformed payload fails closed (an empty grant list satisfies no concrete requirement).

### Complete Example

```typescript
import { isOneOf, satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

// --- One catalog, imported by the server and the browser ---
const ROLES = { Admin: "admin", User: "user" } as const;
const PERMISSIONS = {
    InvoiceRead: "invoice:read",
    InvoiceWrite: "invoice:write",
} as const;

const REQUIREMENTS = {
    viewInvoice: { permissions: [PERMISSIONS.InvoiceRead] },
    editInvoice: {
        mode: "all",
        permissions: [PERMISSIONS.InvoiceRead, PERMISSIONS.InvoiceWrite],
    },
} as const satisfies Record<string, AccessRequirement>;

// --- Hydration: validate whatever the client received ---
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function readGrantList<const T extends string>(
    value: unknown,
    allowed: readonly T[]
): T[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry): entry is T => isOneOf(entry, allowed));
}

function hydratePrincipal(payload: unknown): AccessPrincipal {
    if (!isRecord(payload)) {
        return { roles: [], permissions: [] };
    }
    return {
        roles: readGrantList(payload["roles"], Object.values(ROLES)),
        permissions: readGrantList(payload["permissions"], Object.values(PERMISSIONS)),
    };
}

// --- Server: enforce the requirement and serialize the principal ---
const serverPrincipal: AccessPrincipal = {
    roles: [ROLES.Admin],
    permissions: [PERMISSIONS.InvoiceRead],
};

satisfiesAccess(serverPrincipal, REQUIREMENTS.editInvoice); // false — the API denies the edit
const sessionPayload = JSON.stringify(serverPrincipal);

// --- Browser: hydrate the principal and gate the UI with the same catalog ---
const raw: unknown = JSON.parse(sessionPayload);
const clientPrincipal = hydratePrincipal(raw);

function invoiceActions(principal: AccessPrincipal): readonly string[] {
    const actions: string[] = [];
    if (satisfiesAccess(principal, REQUIREMENTS.viewInvoice)) {
        actions.push("view");
    }
    if (satisfiesAccess(principal, REQUIREMENTS.editInvoice)) {
        actions.push("edit");
    }
    return actions;
}

console.log(invoiceActions(clientPrincipal)); // ["view"] — no edit button
console.log(
    invoiceActions({
        roles: [ROLES.Admin],
        permissions: [PERMISSIONS.InvoiceRead, PERMISSIONS.InvoiceWrite],
    })
); // ["view", "edit"]

// Junk in the payload fails closed: values outside the vocabulary are filtered out.
console.log(hydratePrincipal({ roles: ["root"], permissions: ["invoice:read"] }));
// { roles: [], permissions: ["invoice:read"] }
```

### Why This Pattern Is Valuable

- **Drift is impossible by construction.** One catalog object drives API enforcement, UI gating, and route guards; there is no second copy of a rule to update.
- **Defense in depth with shared semantics.** The client hides what the server rejects — and it hides it using the exact same requirement the server enforces, so the two can never disagree about *what* the rule is.
- **The browser never sees authority internals.** It receives canonical grants only — no claims, no grant map, no provider details — and hydration keeps even that payload filtered to the application's vocabulary.
- **Both runtimes run the same code.** The package is dependency-free, side-effect-free ESM, so the browser bundle includes only the evaluation functions a module imports; translation and profiles stay on the server.

### Caveats and Performance

- **Client checks never enforce.** Anyone can call the API directly; every endpoint re-checks the same requirement server-side. UI gating is a courtesy, not a control.
- **Hydration validates vocabulary, not authenticity.** The payload must still come from a trusted session (signed cookie, server-rendered state, or server-side store); filtering only ensures shape, never provenance.
- **Keep translation out of the browser.** Import only vocabulary and evaluation in client-facing modules so bundlers can drop profiles and translation from the browser graph.
- **Releases are coupled by design.** A shared catalog means a requirement change affects both runtimes — that is the point; deploy server and client together when the catalog changes.
- **Never gate critical flows on `can`-style checks alone.** Hide *and* enforce: the same `REQUIREMENTS` entry serves both, so this costs nothing.

---

## 8. A Request-Scoped Access Facade with a Misconfiguration Guard

### When To Use It

Use this pattern when call sites have started inventing their own authorization ergonomics:

- three handlers check the same kind of requirement and respond three different ways (throw, return 403, log and continue);
- you want denial errors to carry context for logging while staying out of your way in the happy path;
- you want an application-level guard against the library's deliberate fail-open corner: an empty requirement is always satisfied.

### The Pattern

Wrap the request's principal in a tiny closure-based facade: `can` mirrors the library for UI hints, and `require` enforces — throwing a typed error unless the requirement is satisfied *and* non-empty. The emptiness check lives in the application layer, where a forgotten requirement is a bug; the library keeps its pass-through semantics for genuinely optional rules.

```typescript
// fragment — before: each call site invents its own requirement and its own response
if (!satisfiesAccess(principal, { permissions: ["refund:issue"] })) {
    return new Response("Forbidden", { status: 403 });
}
// ... while another handler throws, and a third one forgets the check entirely.
```

### Complete Example

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

export class AccessDeniedError extends Error {
    readonly requirement: AccessRequirement;

    constructor(requirement: AccessRequirement) {
        super("Access denied: the principal does not satisfy the requirement.");
        this.name = "AccessDeniedError";
        this.requirement = requirement;
    }
}

export class MisconfiguredRequirementError extends Error {
    constructor() {
        super("Refusing to require an empty access requirement.");
        this.name = "MisconfiguredRequirementError";
    }
}

export interface AccessFacade {
    /** Mirrors the library: an empty requirement is satisfied. Use for UI hints. */
    can(requirement: AccessRequirement): boolean;
    /** Throws unless the requirement is non-empty and satisfied. Use for enforcement. */
    require(requirement: AccessRequirement): void;
}

export function createAccess(principal: AccessPrincipal): AccessFacade {
    function hasValues(requirement: AccessRequirement): boolean {
        return (
            (requirement.roles?.length ?? 0) > 0 ||
            (requirement.permissions?.length ?? 0) > 0
        );
    }

    return {
        can(requirement: AccessRequirement): boolean {
            return satisfiesAccess(principal, requirement);
        },
        require(requirement: AccessRequirement): void {
            if (!hasValues(requirement)) {
                throw new MisconfiguredRequirementError();
            }
            if (!satisfiesAccess(principal, requirement)) {
                throw new AccessDeniedError(requirement);
            }
        },
    };
}

function issueRefund(access: AccessFacade, invoiceId: number): string {
    access.require({
        mode: "all",
        permissions: ["invoice:read", "refund:issue"],
    });
    return `Refund started for invoice ${invoiceId}.`;
}

const access = createAccess({ roles: ["finance"], permissions: ["invoice:read"] });

access.can({ permissions: ["refund:issue"] }); // false — UI hint, no side effect

try {
    issueRefund(access, 42);
} catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
        console.error("Denied by requirement:", error.requirement.permissions);
    } else if (error instanceof Error) {
        console.error(error.message);
    }
}

// The misconfiguration guard: an empty requirement can never pass `require`.
try {
    access.require({});
} catch (error: unknown) {
    if (error instanceof MisconfiguredRequirementError) {
        console.error(error.message); // "Refusing to require an empty access requirement."
    }
}
```

### Why This Pattern Is Valuable

- **Call sites read like policy.** `access.require({ mode: "all", permissions: [...] })` states the rule and fails the request on denial; there is no per-site response logic to keep consistent.
- **One denial path.** A framework's error mapping translates `AccessDeniedError` to 403 and `MisconfiguredRequirementError` to 500 in exactly one place, so behavior cannot vary between handlers.
- **The fail-open corner is closed where bugs live.** `satisfiesAccess` treats an empty requirement as satisfied by design (unconfigured rules must not lock users out); `require` treats it as a programming error, which is what it is for statically-known requirements.
- **Errors carry context without leaking grants.** The denial error carries the requirement but never the principal, so logs get the rule that failed, not the caller's full grant list.

### Caveats and Performance

- **The facade composes, never reimplements.** All decision logic stays in `satisfiesAccess`; the facade only adds emptiness checking and error mapping. Any mode logic of its own would fork the semantics.
- **Keep it synchronous.** Evaluation is synchronous and pure, so the facade is too — do not introduce async plumbing in front of it.
- **`can({})` returns `true`.** That mirrors the library; when dynamic requirements can be empty, handle that case explicitly in your UI code or route enforcement through `require`.
- **The facade is not a security boundary by itself.** It standardizes decisions over a principal that must come from trusted storage (pattern 1); a forged principal makes every facade honest and wrong.
- **One facade per request is fine.** It is a closure over a reference and two functions — a handful of allocations, immeasurable next to the session load it followed.

---

## Where To Go Next

- Overview — what the package is, its architecture, and its design vocabulary.
- Core Concepts — vocabulary, provider identity, profiles, namespaced keys, translation, and evaluation in depth.
- The package's specification tests (`tests/*.spec.test.ts`) pin the exact behavior of profiles, translation, evaluation, and the guard — treat them as executable documentation when a pattern here meets an edge case.

---

# authz Common Scenarios

This document answers the questions that come up most often when building authorization with `blendsdk/authz`. Each scenario gives the question, a short solution, and a complete example, ordered from single membership checks to full provider integrations. Every code block is ESM, strict TypeScript, and imports everything it uses. For the underlying concepts, see the Overview and Core Concepts.

---

## How do I check whether a principal holds a role or a permission?

Use `hasRole` and `hasPermission` for single-value membership checks. Both are pure and synchronous, and matching is exact — case-sensitive — so `"Admin"` and `"admin"` are different roles.

```typescript
import { hasPermission, hasRole } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const ROLES = { Admin: "admin", Finance: "finance" } as const;
const PERMISSIONS = {
    InvoiceRead: "invoice:read",
    InvoiceWrite: "invoice:write",
} as const;

const principal: AccessPrincipal = {
    roles: [ROLES.Finance],
    permissions: [PERMISSIONS.InvoiceRead],
};

hasRole(principal, ROLES.Finance); // true
hasRole(principal, ROLES.Admin); // false
hasPermission(principal, PERMISSIONS.InvoiceRead); // true
hasPermission(principal, PERMISSIONS.InvoiceWrite); // false

// Matching is exact: an unknown value is simply not held, and case matters.
hasRole({ roles: ["Admin"], permissions: [] }, ROLES.Admin); // false
```

---

## How do I grant access when a principal holds any one of several roles or permissions?

Use `satisfiesAccess` without a mode — the default, `"any"`, passes when the principal holds at least one listed role or permission. The two lists form a single result set, so a listed role alone satisfies a requirement that also lists permissions.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["admin"],
    permissions: [],
};

// Holds "admin", so this passes even though "editor" is also listed.
satisfiesAccess(principal, { roles: ["admin", "editor"] }); // true

// Roles and permissions are one result set: one match is enough.
satisfiesAccess(principal, { roles: ["admin"], permissions: ["invoice:read"] }); // true

// The mode is explicit here for readability; omitting it behaves identically.
satisfiesAccess(principal, { mode: "any", roles: ["editor", "viewer"] }); // false
```

---

## How do I require every listed role and permission?

Set `mode: "all"` on the requirement. Every listed role and permission must be held; lists that are absent or empty are simply not checked.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read", "invoice:write"],
};

satisfiesAccess(principal, {
    mode: "all",
    permissions: ["invoice:read", "invoice:write"],
}); // true

satisfiesAccess(principal, {
    mode: "all",
    roles: ["finance"],
    permissions: ["invoice:read"],
}); // true — only the populated lists are checked

satisfiesAccess(principal, {
    mode: "all",
    roles: ["finance"],
    permissions: ["invoice:read", "audit:read"],
}); // false — "audit:read" is missing
```

---

## How do I treat a route that has no requirement configured?

Pass the requirement through unchanged: an absent or empty requirement is always satisfied, in both modes. An unconfigured rule therefore never accidentally locks users out, while any rule that lists a value is enforced strictly.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const principal: AccessPrincipal = { roles: ["admin"], permissions: [] };

satisfiesAccess(principal, {}); // true — no requirement at all
satisfiesAccess(principal, { roles: [], permissions: [] }); // true — explicitly empty
satisfiesAccess(principal, { mode: "all" }); // true — "all" over zero values also holds

// As soon as one value is required, the check is enforced.
const requirement: AccessRequirement = {
    mode: "all",
    roles: ["admin"],
    permissions: ["invoice:read"],
};
satisfiesAccess(principal, requirement); // false
```

---

## How do I validate an untrusted role value from a token?

Call `isOneOf` with the untrusted value and the application-owned values before trusting the value. It accepts only strings present in the list and narrows the `unknown` value to the union those values form, so the check doubles as a type guard with no cast.

```typescript
import { isOneOf } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;

/** A raw value exactly as it was decoded from an untrusted token payload. */
const raw: unknown = "admin";

if (isOneOf(raw, Object.values(ROLES))) {
    const role: "admin" | "user" = raw; // narrowed to the application union
    console.log(`Accepted role claim: ${role}`);
} else {
    console.warn("Rejected a role claim outside the application vocabulary.");
}

isOneOf("root", Object.values(ROLES)); // false — not an owned value
isOneOf(42, Object.values(ROLES)); // false — a non-string value is rejected
```

---

## How do I translate a generic OIDC identity into an access principal?

Pair `genericClaimsProfile` with `createClaimsTranslator`. The profile converts the `roles` and `permissions` arrays into namespaced keys, and the translator applies your grant map and allowlist to produce canonical grants.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;
const PERMISSIONS = { InvoiceRead: "invoice:read" } as const;

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: [ROLES.Admin] } },
    {
        allowed: {
            roles: Object.values(ROLES),
            permissions: Object.values(PERMISSIONS),
        },
    }
);

const principal: AccessPrincipal = translator.translate({
    userInfo: {
        roles: ["app-admin", "user"],
        permissions: ["invoice:read"],
    },
});
// { roles: ["admin", "user"], permissions: ["invoice:read"] }
//  - "role:app-admin"          → mapped to the canonical "admin" role
//  - "role:user"               → unmapped, but allowlisted
//  - "permission:invoice:read" → unmapped, but allowlisted
```

---

## How do I translate Azure Entra ID claims?

Use `azureClaimsProfile`. It reads the `roles` array, splits the whitespace-delimited `scp` claim into one key per scope, and reads the `groups` array. It never emits `permission:` keys — grant permissions by mapping `scp:` and `group:` keys.

```typescript
import { azureClaimsProfile, createClaimsTranslator } from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

const identity: ProviderIdentity = {
    userInfo: {},
    accessTokenClaims: {
        roles: ["App.Admin"],
        scp: "Invoice.Read Invoice.Write",
        groups: ["Finance"],
    },
};

// Step 1 — the profile reports the namespaced keys the identity carries.
azureClaimsProfile.extract(identity);
// ["role:App.Admin", "scp:Invoice.Read", "scp:Invoice.Write", "group:Finance"]

// Step 2 — the translator turns the keys into canonical grants.
const translator = createClaimsTranslator(azureClaimsProfile, {
    "role:App.Admin": { roles: ["admin"] },
    "group:Finance": { roles: ["finance"], permissions: ["invoice:read"] },
    "scp:Invoice.Write": { permissions: ["invoice:write"] },
});

translator.translate(identity);
// { roles: ["admin", "finance"], permissions: ["invoice:write", "invoice:read"] }
// "scp:Invoice.Read" is unmapped and no allowlist is set, so it grants nothing.
```

---

## How do I translate once at sign-in and evaluate on every request?

Translate the provider identity once — typically while assembling the session at sign-in — and store the resulting `AccessPrincipal` on the session; it is plain, serializable data. Every later check is a pure call to `satisfiesAccess`, so the same principal and the same code work on the server and in the browser.

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";
import type { AccessPrincipal, ProviderIdentity } from "blendsdk/authz";

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: ["admin"] } },
    { allowed: { permissions: ["invoice:read"] } }
);

// Sign-in path — runs once per session.
const identity: ProviderIdentity = {
    userInfo: { roles: ["app-admin"], permissions: ["invoice:read"] },
};
const principal: AccessPrincipal = translator.translate(identity);
// { roles: ["admin"], permissions: ["invoice:read"] }

// Store `principal` on the session; it survives a JSON round-trip.

// Request path — runs on every request against the stored grants.
satisfiesAccess(principal, { permissions: ["invoice:read"] }); // true
satisfiesAccess(principal, {
    mode: "all",
    roles: ["admin"],
    permissions: ["invoice:write"],
}); // false
```

---

## How do I map a provider group or scope to my own role or permission?

Add an entry to the `GrantMap` keyed by the namespaced claim key, for example `"group:Finance"` or `"scp:Invoice.Write"`. Mapped keys are trusted application configuration, so they always grant their mapped values — and they are the only way `group:` and `scp:` keys can grant anything.

```typescript
import {
    azureClaimsProfile,
    createClaimsTranslator,
    resolveGrants,
} from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

const grantMap: GrantMap = {
    "group:Finance": { roles: ["finance"], permissions: ["invoice:read"] },
    "scp:Invoice.Write": { permissions: ["invoice:write"] },
};

const translator = createClaimsTranslator(azureClaimsProfile, grantMap);

translator.translate({
    userInfo: {},
    accessTokenClaims: {
        scp: "Invoice.Write",
        groups: ["Finance"],
    },
});
// { roles: ["finance"], permissions: ["invoice:write", "invoice:read"] }

// Provider-specific keys never grant on their own — not even when the
// allowlist happens to contain the value.
resolveGrants(["group:Finance"], {}, { roles: ["Finance"] });
// { roles: [], permissions: [] }
```

---

## How do I accept a canonical claim without a map entry?

List the value in `AllowedGrants` (`TranslatorOptions.allowed`). An unmapped `role:` or `permission:` key grants its value only when the application lists that value; with no allowlist at all, unmapped keys grant nothing.

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    resolveGrants,
} from "blendsdk/authz";

// Translator form: canonical claims flow through the allowlist.
const translator = createClaimsTranslator(genericClaimsProfile, {}, {
    allowed: { roles: ["user"], permissions: ["invoice:read"] },
});

translator.translate({
    userInfo: { roles: ["user"], permissions: ["invoice:read"] },
});
// { roles: ["user"], permissions: ["invoice:read"] }

// The same rule, shown directly with resolveGrants:
resolveGrants(["role:root"], {}, { roles: ["admin"] });
// { roles: [], permissions: [] } — "root" is not listed

// Fail-closed default: without an allowlist, unmapped keys grant nothing.
resolveGrants(["role:admin"], {});
// { roles: [], permissions: [] }

// Mapped keys are exempt: the map is trusted application configuration.
resolveGrants(
    ["role:app-admin"],
    { "role:app-admin": { roles: ["admin"] } },
    { roles: [] }
);
// { roles: ["admin"], permissions: [] }
```

---

## How do I find the provider claims that never grant anything?

Pass `TranslatorOptions.onUnmapped`. It fires once for every key that yields no grant — never for a mapped key — and receives the key name only, never a claim value, so the key is safe to log.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: ["admin"] } },
    {
        allowed: { roles: ["user"] },
        onUnmapped: (key: string): void => {
            console.warn(`Unmapped provider claim key: ${key}`);
        },
    }
);

translator.translate({
    userInfo: {
        roles: ["app-admin", "user", "partner-preview"],
        permissions: ["legacy:feature"],
    },
});
// Grants { roles: ["admin", "user"], permissions: [] } and logs twice:
//   "role:partner-preview" and "permission:legacy:feature"
// "role:app-admin" is mapped and "role:user" is allowlisted — neither is reported.
```

---

## How do I resolve conflicting claims across userInfo, the ID token, and the access token?

Nothing to configure: claims merge with the order `userInfo` → `idTokenClaims` → `accessTokenClaims`, so the access token wins per claim. A winning source replaces an earlier array wholesale, but each claim is resolved independently and falls back through the sources that define it.

```typescript
import { genericClaimsProfile } from "blendsdk/authz";

// The access token defines "roles", so its array replaces both earlier ones.
genericClaimsProfile.extract({
    userInfo: { roles: ["user", "editor"], permissions: ["invoice:read"] },
    idTokenClaims: { roles: ["editor"] },
    accessTokenClaims: { roles: ["admin"] },
});
// ["role:admin", "permission:invoice:read"]
//  - "roles": the access token wins; the earlier arrays are not merged in.
//  - "permissions": resolved independently, from the only source carrying it.

// When the access token has no "roles" claim, the identity token is next in line.
genericClaimsProfile.extract({
    userInfo: { roles: ["user-info"] },
    idTokenClaims: { roles: ["id-token"] },
});
// ["role:id-token"]
```

---

## How do I support an identity provider that has no built-in profile?

Implement the `ClaimsProfile` interface: a `name` plus an `extract` function that returns namespaced keys built with `grantKey`. Profiles are plain functions of the identity, so they can read any subset of `userInfo`, `idTokenClaims`, `accessTokenClaims`, and `scopes`.

```typescript
import { createClaimsTranslator, grantKey } from "blendsdk/authz";
import type { ClaimsProfile, ProviderIdentity } from "blendsdk/authz";

/**
 * A profile for a provider that sends a single `tier` value in user info and
 * the granted OAuth scopes alongside the access token.
 */
const tierProfile: ClaimsProfile = {
    name: "tier",
    extract(identity: ProviderIdentity): readonly string[] {
        const keys: string[] = [];

        const tier = identity.userInfo["tier"];
        if (typeof tier === "string" && tier.length > 0) {
            keys.push(grantKey("role", tier));
        }

        for (const scope of identity.scopes ?? []) {
            keys.push(grantKey("scp", scope));
        }

        return keys;
    },
};

const translator = createClaimsTranslator(tierProfile, {
    "role:gold": { roles: ["premium"] },
    "scp:report:view": { permissions: ["report:view"] },
});

translator.translate({
    userInfo: { tier: "gold" },
    scopes: ["report:view"],
});
// { roles: ["premium"], permissions: ["report:view"] }
```

---

## How do I keep malformed claims and map entries from breaking translation?

Nothing extra to do — translation filters malformed input instead of throwing. Claims that are not arrays of strings are ignored, non-string entries are dropped, and map entries that are not objects of string arrays contribute nothing.

```typescript
import {
    azureClaimsProfile,
    genericClaimsProfile,
    resolveGrants,
} from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

// Non-string entries are dropped; the remaining strings still count.
genericClaimsProfile.extract({ userInfo: { roles: ["admin", 42, null] } });
// ["role:admin"]

// A claim that is not an array is ignored — a bare string is not iterated.
genericClaimsProfile.extract({ userInfo: { roles: "admin" } });
// []

// Azure scope whitespace is collapsed and empty segments are skipped.
azureClaimsProfile.extract({
    userInfo: {},
    accessTokenClaims: { scp: "  A   B  " },
});
// ["scp:A", "scp:B"]

// A malformed map (as JSON parsing can produce) never makes translation throw.
const parsedMap: GrantMap = JSON.parse(
    '{"group:x":{"roles":["admin",null,"admin"],"permissions":[7]}}'
);
resolveGrants(["group:x"], parsedMap);
// { roles: ["admin"], permissions: [] } — non-strings dropped, duplicates collapsed
```

---

## How do I test authorization logic without a real identity provider?

Stub `ClaimsProfile` with a fixed `extract`, then test translation and evaluation over plain data. Everything downstream is pure, so tests need no provider, no network, and no tokens.

```typescript
import {
    createClaimsTranslator,
    resolveGrants,
    satisfiesAccess,
} from "blendsdk/authz";
import type { ClaimsProfile } from "blendsdk/authz";

/** A stub profile that returns fixed keys, so the test controls the claims exactly. */
const stubProfile: ClaimsProfile = {
    name: "stub",
    extract: (): readonly string[] => ["role:admin", "permission:invoice:read"],
};

const translator = createClaimsTranslator(
    stubProfile,
    { "role:admin": { roles: ["admin"] } },
    { allowed: { permissions: ["invoice:read"] } }
);

const principal = translator.translate({ userInfo: {} });
// { roles: ["admin"], permissions: ["invoice:read"] }

satisfiesAccess(principal, { roles: ["admin"] }); // true
satisfiesAccess(principal, {
    mode: "all",
    roles: ["admin"],
    permissions: ["invoice:read"],
}); // true

// Pure aggregation can also be tested directly, with no profile at all.
resolveGrants(["scp:Report.View"], {
    "scp:Report.View": { permissions: ["report:view"] },
});
// { roles: [], permissions: ["report:view"] }
```

---

# authz Examples Library

Every example in this library is complete and self-contained: each block includes its imports, compiles under strict TypeScript, and can be pasted into an ESM project as is. Expected results are shown as comments in the code. The package has no runtime dependencies and no configuration, so every example runs synchronously — on Node.js ≥ 22 or in any modern browser — without a provider, a server, or a build step.

Examples are grouped by feature area and grow from simple to complex within each category:

- **Access Evaluation** — membership checks and requirement evaluation over a principal.
- **Application Vocabulary** — declaring roles and permissions and building principals.
- **Built-in Claim Profiles** — reading generic OIDC and Azure Entra ID claims.
- **Grant Translation** — keys, aggregation, allowlists, and translator factories.
- **Grant Maps and the Authority Model** — how provider claims become canonical grants.
- **Custom Claim Profiles** — supporting a provider that matches no built-in profile.
- **Untrusted Input Guarding** — validating raw values with `isOneOf`.
- **End-to-End Recipes** — sign-in, session storage, server checks, and browser gating.

Examples use `console.log` so results are visible; in application code you would branch on the returned values instead. For a high-level tour see Overview, for concept deep-dives see Core Concepts, and for a task-oriented walkthrough see Basic Usage.

---

## Access Evaluation

Single-value lookups with `hasRole` and `hasPermission`, and full requirement evaluation with `satisfiesAccess`.

### Check a Role With `hasRole`

`hasRole` reports whether a principal holds a role, using exact, case-sensitive matching.

```typescript
import { hasRole } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["finance", "auditor"],
    permissions: ["invoice:read"],
};

console.log(hasRole(principal, "finance")); // true
console.log(hasRole(principal, "admin")); // false
console.log(hasRole(principal, "Finance")); // false — matching is case-sensitive
```

### Check a Permission With `hasPermission`

`hasPermission` reports whether a principal holds a permission. As with roles, matching is exact.

```typescript
import { hasPermission } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read"],
};

console.log(hasPermission(principal, "invoice:read")); // true
console.log(hasPermission(principal, "invoice:write")); // false
console.log(hasPermission(principal, "invoice:read:extra")); // false — no prefix matching
```

### Evaluate a Requirement in "any" Mode

"Any" is the default mode: the requirement passes when the principal holds at least one of the listed roles or permissions.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read"],
};

const readOrWrite: AccessRequirement = {
    permissions: ["invoice:read", "invoice:write"],
};

console.log(satisfiesAccess(principal, readOrWrite)); // true — "invoice:read" is held

console.log(
    satisfiesAccess(principal, {
        mode: "any",
        permissions: ["invoice:write", "audit:read"],
    })
); // false — none of the listed values is held
```

### Evaluate a Requirement in "all" Mode

In "all" mode the principal must hold every listed role and permission.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read"],
};

const readAndWrite: AccessRequirement = {
    mode: "all",
    permissions: ["invoice:read", "invoice:write"],
};

console.log(satisfiesAccess(principal, readAndWrite)); // false — "invoice:write" is missing

console.log(
    satisfiesAccess(principal, { mode: "all", permissions: ["invoice:read"] })
); // true — the only listed value is held
```

### An Empty Requirement Is Always Satisfied

An absent or empty requirement passes for every principal, so an unconfigured rule never locks users out.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const anonymous: AccessPrincipal = { roles: [], permissions: [] };

console.log(satisfiesAccess(anonymous, {})); // true
console.log(satisfiesAccess(anonymous, { roles: [] })); // true
console.log(satisfiesAccess(anonymous, { mode: "all" })); // true
```

### Combine Roles and Permissions in One Requirement

`satisfiesAccess` evaluates the requirement's roles and permissions as one combined result set; the mode applies across both lists.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["admin"],
    permissions: [],
};

console.log(
    satisfiesAccess(principal, { roles: ["admin"], permissions: ["invoice:read"] })
); // true — "any" mode: the held role alone is enough

console.log(
    satisfiesAccess(principal, {
        mode: "all",
        roles: ["admin"],
        permissions: ["invoice:read"],
    })
); // false — the permission is not held
```

---

## Application Vocabulary

The application owns every role and permission string; these examples show how to declare that vocabulary and build the principals evaluation reads.

### Declare Roles and Permissions as Shared Constants

Both `Role` and `Permission` are plain string aliases, so one `as const` declaration per concept gives the server and the browser the same literal types.

```typescript
import type { Permission, Role } from "blendsdk/authz";

const ROLES = {
    Admin: "admin",
    Finance: "finance",
    User: "user",
} as const;

const PERMISSIONS = {
    InvoiceRead: "invoice:read",
    InvoiceWrite: "invoice:write",
    AuditRead: "audit:read",
} as const;

const admin: Role = ROLES.Admin;
const invoiceRead: Permission = PERMISSIONS.InvoiceRead;

console.log(admin); // "admin"
console.log(invoiceRead); // "invoice:read"
```

### Build a Principal From the Application Constants

A principal is a plain object with two arrays and no methods, so it can be assembled anywhere — at sign-in, from a session, or in a test.

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

console.log(hasRole(principal, ROLES.Finance)); // true
console.log(hasPermission(principal, PERMISSIONS.InvoiceRead)); // true
console.log(hasPermission(principal, PERMISSIONS.InvoiceWrite)); // false
```

---

## Built-in Claim Profiles

Profiles read a `ProviderIdentity` and report the namespaced keys found in its claims; they decide nothing about authority.

### Read Generic OIDC Claims

`genericClaimsProfile` reads the `roles` array into `role:` keys and the `permissions` array into `permission:` keys.

```typescript
import { genericClaimsProfile } from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

const identity: ProviderIdentity = {
    userInfo: {
        roles: ["admin", "user"],
        permissions: ["invoice:read"],
    },
};

const keys = genericClaimsProfile.extract(identity);

console.log(keys);
// ["role:admin", "role:user", "permission:invoice:read"]
```

### Read Azure Entra ID Claims

`azureClaimsProfile` reads the `roles` array, splits the whitespace-delimited `scp` claim, and reads the `groups` array. It never emits `permission:` keys, because Azure scopes are not application permissions.

```typescript
import { azureClaimsProfile } from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

const identity: ProviderIdentity = {
    userInfo: {},
    accessTokenClaims: {
        roles: ["App.Admin"],
        scp: "Invoice.Read Invoice.Write",
        groups: ["Finance"],
    },
};

console.log(azureClaimsProfile.extract(identity));
// ["role:App.Admin", "scp:Invoice.Read", "scp:Invoice.Write", "group:Finance"]

// Even when a permissions claim is present, the Azure profile ignores it.
console.log(
    azureClaimsProfile.extract({
        userInfo: {},
        accessTokenClaims: { permissions: ["p"], scp: "Invoice.Read" },
    })
);
// ["scp:Invoice.Read"]
```

### Observe Claim Precedence Across Sources

Claims merge with the order `userInfo` → `idTokenClaims` → `accessTokenClaims`: the access token wins when several sources carry the same claim, and each claim resolves independently.

```typescript
import { genericClaimsProfile } from "blendsdk/authz";
import type { ProviderIdentity } from "blendsdk/authz";

const identity: ProviderIdentity = {
    userInfo: { roles: ["user-info"], permissions: ["invoice:read"] },
    idTokenClaims: { roles: ["id-token"] },
    accessTokenClaims: { roles: ["access-token"] },
};

console.log(genericClaimsProfile.extract(identity));
// ["role:access-token", "permission:invoice:read"]
//  - `roles` resolves to the access token value; it overrides both other sources.
//  - `permissions` resolves independently from user info, the only source defining it.
```

### Ignore Malformed Claims

Malformed claim data is dropped, not thrown: a claim that is not an array is ignored, and non-string entries inside an array are filtered out.

```typescript
import { azureClaimsProfile, genericClaimsProfile } from "blendsdk/authz";

console.log(genericClaimsProfile.extract({ userInfo: { roles: "admin" } }));
// [] — a non-array claim is ignored.

console.log(
    genericClaimsProfile.extract({ userInfo: { roles: ["admin", 42, null, "user"] } })
);
// ["role:admin", "role:user"] — non-string entries are dropped.

console.log(
    azureClaimsProfile.extract({ userInfo: {}, accessTokenClaims: { scp: 123 } })
);
// [] — a malformed scope claim contributes nothing.
```

---

## Grant Translation

Translation turns the keys a profile reports into canonical grants. These examples cover building keys, pure aggregation, the allowlist, and the translator factory.

### Build Namespaced Keys With `grantKey`

`grantKey` joins a claim family and a raw value into the `source:value` format translation understands; custom profiles use it to stay consistent with the built-ins.

```typescript
import { grantKey } from "blendsdk/authz";
import type { GrantSource } from "blendsdk/authz";

const source: GrantSource = "role";

console.log(grantKey(source, "admin")); // "role:admin"
console.log(grantKey("scp", "Invoice.Read")); // "scp:Invoice.Read"
console.log(grantKey("group", "Finance")); // "group:Finance"
console.log(grantKey("permission", "invoice:read")); // "permission:invoice:read"
```

### Aggregate Keys With `resolveGrants`

`resolveGrants` is the pure step from keys to canonical grants: mapped keys grant their mapped values, and unmapped canonical keys grant allowlisted values only. Values are de-duplicated in first-seen order.

```typescript
import { resolveGrants } from "blendsdk/authz";
import type { AccessPrincipal, GrantMap } from "blendsdk/authz";

const map: GrantMap = {
    "group:Finance": { roles: ["finance"] },
    "scp:Invoice.Read": { permissions: ["invoice:read"] },
};

const principal: AccessPrincipal = resolveGrants(
    ["group:Finance", "scp:Invoice.Read", "role:user"],
    map,
    { roles: ["user"] }
);

console.log(principal);
// { roles: ["finance", "user"], permissions: ["invoice:read"] }
//  - "group:Finance" and "scp:Invoice.Read" are mapped and grant their mapped values.
//  - "role:user" is unmapped but allowlisted, so it grants the canonical "user" role.
```

### Fail Closed Without an Allowlist

When no allowlist is supplied, an unmapped key grants nothing; only mapped keys confer authority. This is the package's fail-closed default.

```typescript
import { resolveGrants } from "blendsdk/authz";

console.log(resolveGrants(["role:admin"], {}));
// { roles: [], permissions: [] } — no map entry and no allowlist: nothing is granted.

console.log(resolveGrants(["role:admin"], {}, { roles: ["admin"] }));
// { roles: ["admin"], permissions: [] } — the allowlist names the value, so it is granted.
```

### Build a Translator for Your Provider

`createClaimsTranslator` pairs a profile with the application's grant map and options; it is the entry point most applications use.

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";

const ROLES = { Admin: "admin" } as const;

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: [ROLES.Admin] } },
    { allowed: { permissions: ["invoice:read"] } }
);

const principal = translator.translate({
    userInfo: {
        roles: ["app-admin", "user"],
        permissions: ["invoice:read"],
    },
});

console.log(principal);
// { roles: ["admin"], permissions: ["invoice:read"] }
//  - "role:app-admin" is declared in the map, so it grants the canonical "admin" role.
//  - "role:user" has no mapping and no roles allowlist, so it grants nothing.
//  - "permission:invoice:read" has no mapping but is allowlisted, so it is granted directly.

console.log(satisfiesAccess(principal, { permissions: ["invoice:read"] })); // true
```

### Audit Unmapped Keys With `onUnmapped`

`onUnmapped` is called once for every key that yields no grant; it receives the key name only, never a claim value, so the key is safe to log.

```typescript
import { azureClaimsProfile, createClaimsTranslator } from "blendsdk/authz";

const unmappedKeys: string[] = [];

const translator = createClaimsTranslator(
    azureClaimsProfile,
    {
        "group:Finance": { roles: ["finance"] },
        "scp:Invoice.Read": { permissions: ["invoice:read"] },
    },
    {
        onUnmapped: (key: string): void => {
            unmappedKeys.push(key);
        },
    }
);

const principal = translator.translate({
    userInfo: {},
    accessTokenClaims: {
        scp: "Invoice.Read Invoice.Write",
        groups: ["Finance"],
    },
});

console.log(principal);
// { roles: ["finance"], permissions: ["invoice:read"] }

console.log(unmappedKeys);
// ["scp:Invoice.Write"] — mapped keys never trigger the callback.
```

---

## Grant Maps and the Authority Model

The application, not the identity provider, decides which keys grant authority. These examples show the three rules: mapped keys are trusted, a mapping overrides the canonical fallback, and provider-specific sources never grant on their own.

### Map Provider-Specific Keys to Canonical Grants

Azure groups and scopes become the application's vocabulary only through an explicit map entry; this is where provider-specific labels are translated.

```typescript
import { azureClaimsProfile, createClaimsTranslator } from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

const map: GrantMap = {
    "group:Finance": { roles: ["finance"] },
    "group:HR": { permissions: ["employee:read"] },
    "scp:Invoice.Write": { permissions: ["invoice:write"] },
};

const translator = createClaimsTranslator(azureClaimsProfile, map);

const principal = translator.translate({
    userInfo: {},
    accessTokenClaims: {
        scp: "Invoice.Write",
        groups: ["Finance", "HR"],
    },
});

console.log(principal);
// { roles: ["finance"], permissions: ["invoice:write", "employee:read"] }
```

### A Mapped Key Overrides Its Canonical Fallback

When a key is declared in the map, its mapped values are granted instead of — never in addition to — the canonical value the key would otherwise carry.

```typescript
import { resolveGrants } from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

const map: GrantMap = { "role:admin": { roles: ["super"] } };

const principal = resolveGrants(["role:admin"], map, { roles: ["admin", "super"] });

console.log(principal);
// { roles: ["super"], permissions: [] }
// The mapping wins: "role:admin" grants "super", never the canonical "admin".
```

### Provider-Specific Keys Are Never Canonical

`scp:` and `group:` keys never grant authority on their own, whatever the allowlist contains; only the canonical `role:` and `permission:` sources qualify for allowlist grants.

```typescript
import { resolveGrants } from "blendsdk/authz";

console.log(
    resolveGrants(["scp:Invoice.Read"], {}, { permissions: ["Invoice.Read"] })
);
// { roles: [], permissions: [] } — an scp key is never a canonical permission.

console.log(resolveGrants(["group:Finance"], {}, { roles: ["Finance"] }));
// { roles: [], permissions: [] } — a group key is never a canonical role.

console.log(
    resolveGrants(["permission:Invoice.Read"], {}, { permissions: ["Invoice.Read"] })
);
// { roles: [], permissions: ["Invoice.Read"] } — the canonical source is eligible.
```

---

## Custom Claim Profiles

When a provider's claims match neither built-in profile, implement `ClaimsProfile`: `extract` reports namespaced keys, and translation applies the same map and allowlist rules as for the built-ins.

### Implement a Custom `ClaimsProfile`

This directory service reports a `department` string and an `entitlements` array instead of OIDC-style roles and permissions.

```typescript
import { createClaimsTranslator, grantKey } from "blendsdk/authz";
import type { ClaimsProfile, ProviderIdentity } from "blendsdk/authz";

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

console.log(
    directoryProfile.extract({
        userInfo: {
            department: "it-support",
            entitlements: ["invoice:read", "admin:everything"],
        },
    })
);
// ["role:it-support", "permission:invoice:read", "permission:admin:everything"]

const translator = createClaimsTranslator(
    directoryProfile,
    { "role:it-support": { roles: ["support"] } },
    { allowed: { permissions: ["invoice:read"] } }
);

console.log(
    translator.translate({
        userInfo: {
            department: "it-support",
            entitlements: ["invoice:read", "admin:everything"],
        },
    })
);
// { roles: ["support"], permissions: ["invoice:read"] }
//  - "role:it-support" is mapped to the canonical "support" role.
//  - "permission:invoice:read" is allowlisted and granted directly.
//  - "permission:admin:everything" is unmapped and not allowlisted, so it grants nothing.
```

---

## Untrusted Input Guarding

`isOneOf` validates values that arrive from tokens or requests against application-owned values and narrows `unknown` to the resulting union — without a cast.

### Narrow a Raw Claim With `isOneOf`

The guard accepts a value only when it is a string present in the allowed list; because it is a type predicate, the caller can use the narrowed value directly.

```typescript
import { isOneOf } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;

// A raw value decoded from an untrusted token payload.
const raw: unknown = "admin";

if (isOneOf(raw, Object.values(ROLES))) {
    const role: "admin" | "user" = raw; // narrowed — no cast needed
    console.log(`Accepted role claim: ${role}`);
} else {
    console.warn("Rejected an unknown role claim.");
}
// Accepted role claim: admin
```

### Reject Malformed and Unknown Values

Membership is exact and the type check comes first, so non-strings are rejected rather than coerced.

```typescript
import { isOneOf } from "blendsdk/authz";

const SCOPES = ["invoice:read", "invoice:write"] as const;

console.log(isOneOf("invoice:read", SCOPES)); // true
console.log(isOneOf("invoice:delete", SCOPES)); // false — not an application value
console.log(isOneOf(42, SCOPES)); // false — not a string
console.log(isOneOf(null, SCOPES)); // false — not a string
console.log(isOneOf(["invoice:read"], SCOPES)); // false — an array is not a string
```

### Filter a Raw Claim Array

A provider can send a role claim that contains values the application does not know; apply the guard per entry to keep only trusted values.

```typescript
import { isOneOf } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;
const allowedRoles = Object.values(ROLES);

// A roles claim as decoded from a token: an array of unknown entries.
const rawRolesClaim: readonly unknown[] = ["admin", "root", 42, "user"];

const trustedRoles: ("admin" | "user")[] = [];
for (const entry of rawRolesClaim) {
    if (isOneOf(entry, allowedRoles)) {
        trustedRoles.push(entry);
    }
}

console.log(trustedRoles);
// ["admin", "user"] — "root" and 42 are rejected.
```

---

## End-to-End Recipes

Complete flows that combine translation and evaluation: sign-in, session storage, server-side request checks, and browser-side UI gating.

### Translate a Provider Identity at Sign-In

Build the translator once, translate the identity a single time, and store the resulting principal on the session; every later check reads the stored principal instead of re-translating.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";
import type { AccessPrincipal, ProviderIdentity } from "blendsdk/authz";

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: ["admin"] } },
    {
        allowed: {
            roles: ["user"],
            permissions: ["invoice:read"],
        },
        onUnmapped: (key: string): void => {
            console.warn(`Unmapped claim key at sign-in: ${key}`);
        },
    }
);

// Everything the application collected from the identity provider after sign-in.
const identity: ProviderIdentity = {
    userInfo: {
        roles: ["app-admin", "user", "partner"],
        permissions: ["invoice:read"],
    },
};

const principal: AccessPrincipal = translator.translate(identity);

console.log(principal);
// { roles: ["admin", "user"], permissions: ["invoice:read"] }
// "role:partner" is unmapped and not allowlisted: it warns once and grants nothing.
```

### Serialize a Principal Into the Session and Restore It

A principal is plain data — two arrays of strings — so it survives a JSON round trip; narrow the restored payload before trusting it.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read"],
};

// Store: the principal is JSON-safe by construction.
const stored: string = JSON.stringify(principal);
console.log(stored);
// {"roles":["finance"],"permissions":["invoice:read"]}

// Restore: read the payload back and narrow each list before trusting it.
const payload: Record<string, unknown> = JSON.parse(stored);

function readStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const result: string[] = [];
    for (const entry of value) {
        if (typeof entry === "string") {
            result.push(entry);
        }
    }
    return result;
}

const restored: AccessPrincipal = {
    roles: readStringList(payload["roles"]),
    permissions: readStringList(payload["permissions"]),
};

console.log(satisfiesAccess(restored, { permissions: ["invoice:read"] })); // true
```

### Evaluate a Requirement per Server Request

Map each protected route to an `AccessRequirement` and evaluate the session principal; an unconfigured route throws instead of silently passing.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

/** The principal translated at sign-in and stored on the session. */
const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read"],
};

/** One requirement per protected route. */
const REQUIREMENTS: Record<string, AccessRequirement> = {
    "GET /invoices": { permissions: ["invoice:read"] },
    "POST /invoices": {
        mode: "all",
        roles: ["finance"],
        permissions: ["invoice:write"],
    },
};

function authorize(route: string): boolean {
    const requirement: AccessRequirement | undefined = REQUIREMENTS[route];
    if (requirement === undefined) {
        throw new Error(`No authorization requirement configured for ${route}`);
    }
    return satisfiesAccess(principal, requirement);
}

console.log(authorize("GET /invoices")); // true
console.log(authorize("POST /invoices")); // false — "invoice:write" is not held

try {
    authorize("DELETE /invoices");
} catch (error) {
    const message = error instanceof Error ? error.message : "Authorization failed.";
    console.error(message);
    // No authorization requirement configured for DELETE /invoices
}
```

### Gate UI in the Browser With the Same Principal

The browser restores the same principal and runs the same `satisfiesAccess` checks, so client and server agree by construction.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal, AccessRequirement } from "blendsdk/authz";

const PERMISSIONS = {
    InvoiceRead: "invoice:read",
    InvoiceWrite: "invoice:write",
} as const;

/** Restored from the session payload issued at sign-in. */
const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: [PERMISSIONS.InvoiceRead],
};

/** A single gate shared by every client view. */
function mayAccess(requirement: AccessRequirement): boolean {
    return satisfiesAccess(principal, requirement);
}

console.log(mayAccess({ permissions: [PERMISSIONS.InvoiceWrite] })); // false — hide the editor
console.log(mayAccess({ permissions: [PERMISSIONS.InvoiceRead] })); // true — show the list
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
