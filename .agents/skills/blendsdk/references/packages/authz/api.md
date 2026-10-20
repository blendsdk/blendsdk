> **Package**: `blendsdk/authz`

# authz API Reference

This is the complete reference for all 21 public exports of `blendsdk/authz` — 7 functions, 2 claim-profile constants, and 12 type-only declarations. Every symbol is available from the package root; there are no subpath exports, no classes, no default export, and no import side effects. Signatures below match the compiled declarations; bare signatures are shown as `typescript fragment` blocks, and each function has a complete, runnable example.

For concepts and the authority model, see Core Concepts; for architecture and dependencies, the Overview.

---

## API Surface at a Glance

| Symbol | Kind | Summary |
| --- | --- | --- |
| `hasRole` | Function | Returns `true` when the principal holds a role. |
| `hasPermission` | Function | Returns `true` when the principal holds a permission. |
| `satisfiesAccess` | Function | Evaluates a requirement against a principal. |
| `isOneOf` | Function | Narrows an untrusted value to an application-owned union. |
| `grantKey` | Function | Joins a source and a value into a namespaced key. |
| `resolveGrants` | Function | Aggregates namespaced keys into canonical grants. |
| `createClaimsTranslator` | Function | Creates a translator from a profile, grant map, and options. |
| `genericClaimsProfile` | Constant | The generic OIDC claim profile (`roles`, `permissions`). |
| `azureClaimsProfile` | Constant | The Azure Entra ID claim profile (`roles`, `scp`, `groups`). |
| `Role` | Type | `string` — a coarse authorization label. |
| `Permission` | Type | `string` — a fine-grained capability. |
| `AccessMode` | Type | `"any" \| "all"` — how a requirement combines its lists. |
| `AccessPrincipal` | Interface | The roles and permissions a principal holds. |
| `AccessRequirement` | Interface | A check to run against a principal. |
| `AllowedGrants` | Interface | Canonical values that may be granted without a map entry. |
| `ProviderIdentity` | Interface | The provider claims and tokens collected for one identity. |
| `GrantSource` | Type | `"role" \| "scp" \| "group" \| "permission"` — a key's claim family. |
| `GrantMap` | Type | Maps namespaced keys to the canonical grants they confer. |
| `ClaimsProfile` | Interface | Converts a provider identity into namespaced keys. |
| `ClaimsTranslator` | Interface | Converts a provider identity into canonical grants. |
| `TranslatorOptions` | Interface | Options for `createClaimsTranslator`. |

---

## Evaluation Functions

Pure, synchronous membership and requirement checks over plain data — safe to call in a hot request path or in the browser. Matching is exact and case-sensitive throughout.

### `hasRole`

Returns `true` when the principal holds the given role. This is the single-value check that `satisfiesAccess` builds its role results from.

```typescript fragment
function hasRole(principal: AccessPrincipal, role: Role): boolean
```

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `principal` | `AccessPrincipal` | Yes | — | The grants held by the caller. |
| `role` | `Role` | Yes | — | The role to look for. |

**Returns**: `boolean` — `true` when the role is held; `false` otherwise.

Matching is exact and case-sensitive, so `"Admin"` does not satisfy `"admin"`. Duplicates in `principal.roles` change nothing.

```typescript
import { hasRole } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = { roles: ["admin"], permissions: [] };

hasRole(principal, "admin"); // true
hasRole(principal, "Admin"); // false — matching is exact and case-sensitive
```

### `hasPermission`

Returns `true` when the principal holds the given permission. This is the single-value check that `satisfiesAccess` builds its permission results from.

```typescript fragment
function hasPermission(principal: AccessPrincipal, permission: Permission): boolean
```

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `principal` | `AccessPrincipal` | Yes | — | The grants held by the caller. |
| `permission` | `Permission` | Yes | — | The permission to look for. |

**Returns**: `boolean` — `true` when the permission is held; `false` otherwise.

```typescript
import { hasPermission } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = { roles: [], permissions: ["invoice:read"] };

hasPermission(principal, "invoice:read"); // true
hasPermission(principal, "invoice:write"); // false
```

### `satisfiesAccess`

Evaluates a requirement against a principal.

```typescript fragment
function satisfiesAccess(principal: AccessPrincipal, requirement: AccessRequirement): boolean
```

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `principal` | `AccessPrincipal` | Yes | — | The grants held by the caller. |
| `requirement` | `AccessRequirement` | Yes | — | The roles and permissions to check. |

**Returns**: `boolean` — `true` when the requirement is satisfied.

An absent or empty requirement is always satisfied, so an unconfigured rule does not accidentally lock users out. Otherwise every listed role and permission produces a membership result, and the results are combined according to `requirement.mode`: `"any"` (the default) passes when at least one value is held, and `"all"` passes only when every value is held. Roles and permissions are combined into a single result set, so in `"any"` mode a held role satisfies a requirement that also lists permissions.

```typescript
import { satisfiesAccess } from "blendsdk/authz";
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["finance"],
    permissions: ["invoice:read"],
};

satisfiesAccess(principal, { permissions: ["invoice:read", "invoice:write"] }); // true — "any" is the default
satisfiesAccess(principal, { mode: "all", permissions: ["invoice:read", "invoice:write"] }); // false
satisfiesAccess(principal, {}); // true — an empty requirement is always satisfied
```

---

## Translation Functions

Grant translation turns the namespaced keys a [claim profile](#claim-profiles) reports into the canonical roles and permissions a principal holds. Two rules keep authority with the application: a key declared in the grant map always grants its mapped values, and an unmapped `role:`/`permission:` key grants only a value listed in `AllowedGrants`. Without an allowlist, unmapped keys grant nothing — translation fails closed.

### `grantKey`

Joins a grant source and a value into the namespaced key format that translation understands.

```typescript fragment
function grantKey(source: GrantSource, value: string): string
```

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `source` | `GrantSource` | Yes | — | The claim family, such as `"role"` or `"scp"`. |
| `value` | `string` | Yes | — | The raw value, such as `"admin"` or `"Invoice.Read"`. |

**Returns**: `string` — the namespaced key, for example `"role:admin"`.

Keys are split at the first colon during resolution, so a value may itself contain colons: `grantKey("permission", "invoice:read")` produces `"permission:invoice:read"`, which resolves as source `permission` plus value `invoice:read`. Use this helper in custom profiles so the `source:value` format stays consistent.

```typescript
import { grantKey } from "blendsdk/authz";

grantKey("role", "admin"); // "role:admin"
grantKey("scp", "Invoice.Read"); // "scp:Invoice.Read"
grantKey("permission", "invoice:read"); // "permission:invoice:read"
```

### `resolveGrants`

Aggregates namespaced keys into canonical grants. This is the pure aggregation step; `createClaimsTranslator` wraps it with a profile and options.

```typescript fragment
function resolveGrants(keys: readonly string[], map: GrantMap, allowed?: AllowedGrants): AccessPrincipal
```

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `keys` | `readonly string[]` | Yes | — | The namespaced keys to translate. |
| `map` | `GrantMap` | Yes | — | The application-provided grant map. |
| `allowed` | `AllowedGrants` | No | `undefined` | Canonical values that may be granted without a map entry. Absent means fail closed. |

**Returns**: `AccessPrincipal` — the canonical roles and permissions conferred by the keys.

Behavior:

- **Mapped keys win.** A key that is an own property of `map` grants its mapped roles and permissions immediately and takes precedence over the canonical fallback — `"role:admin"` mapped to `{ roles: ["super"] }` grants `super`, never `admin`. Mapped values are exempt from `allowed`. An own property whose mapping is empty (or `undefined`) grants nothing and does not fall back.
- **Unmapped canonical keys are allowlisted.** A `role:` or `permission:` key with no map entry grants its value only when `allowed` lists that value. When `allowed` is omitted, unmapped keys grant nothing, so translation fails closed.
- **Provider-specific keys are never canonical.** `scp:` and `group:` keys grant nothing on their own, whatever the allowlist contains; they must be mapped explicitly.
- **Key parsing.** A key without a colon is ignored, and only the first colon separates source from value, so values may contain colons.
- **Stable output.** Granted values are filtered to strings and de-duplicated in first-seen order, so the resulting arrays are stable.
- **Malformed data never throws.** A mapped entry that is not an object, or a mapped list that is not an array of strings, contributes nothing. Lookups use own-property checks, so an inherited property never grants.

```typescript
import { resolveGrants } from "blendsdk/authz";
import type { GrantMap } from "blendsdk/authz";

const map: GrantMap = { "scp:Invoice.Read": { permissions: ["invoice:read"] } };

resolveGrants(["scp:Invoice.Read"], map);
// { roles: [], permissions: ["invoice:read"] }

resolveGrants(["role:admin"], {}, { roles: ["admin"] });
// { roles: ["admin"], permissions: [] }

resolveGrants(["role:admin"], {});
// { roles: [], permissions: [] } — no allowlist, so translation fails closed
```

### `createClaimsTranslator`

Creates a translator that reads a profile's keys and applies a grant map.

```typescript fragment
function createClaimsTranslator(profile: ClaimsProfile, map: GrantMap, options?: TranslatorOptions): ClaimsTranslator
```

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `profile` | `ClaimsProfile` | Yes | — | The claims profile that reads the identity. |
| `map` | `GrantMap` | Yes | — | The application-provided grant map. |
| `options` | `TranslatorOptions` | No | `undefined` | The allowlist and unmapped-key callback. |

**Returns**: `ClaimsTranslator` — a translator that produces canonical grants from an identity.

On each `translate` call the translator extracts the keys from the identity with `profile.extract` and aggregates them exactly as `resolveGrants` does, using the same `map` and `options.allowed`. When `options.onUnmapped` is provided, it is called once for every key that yields no grant; a key the map lists never triggers the callback, even when its mapped values are empty, and neither does a canonical key the allowlist accepts. Build the translator once, translate once per identity — typically at sign-in — and store the resulting `AccessPrincipal` for later [`satisfiesAccess`](#satisfiesaccess) checks.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: ["admin"] } },
    { allowed: { roles: ["user"] } }
);

translator.translate({ userInfo: { roles: ["app-admin", "user"] } });
// { roles: ["admin", "user"], permissions: [] }
```

---

## Claim Profiles

A claim profile adapts one provider's claim shapes to namespaced keys; deciding what those keys confer happens later, in [translation](#translation-functions). Both built-ins read claims with the merge order `userInfo` → `idTokenClaims` → `accessTokenClaims`, so the access token wins when sources disagree, and each claim resolves independently across sources. Malformed input is dropped, not fatal: a claim whose shape does not fit is ignored, and non-string entries inside an array are dropped.

### `genericClaimsProfile`

The generic OIDC claim profile. Reads a `roles` array and a `permissions` array from the merged claims and emits `role:` and `permission:` keys. Use it when the provider sends application-friendly claim names.

```typescript fragment
const genericClaimsProfile: ClaimsProfile
```

**Members**

| Member | Type | Description |
| --- | --- | --- |
| `name` | `string` | Always `"generic"` — the profile name. |
| `extract` | `(identity: ProviderIdentity) => readonly string[]` | Emits the keys listed below. |

**Emitted keys**

| Merged claim | Expected shape | Emitted keys |
| --- | --- | --- |
| `roles` | Array of strings | `role:<entry>` for each string entry, in order. |
| `permissions` | Array of strings | `permission:<entry>` for each string entry, in order. |

A `roles` or `permissions` claim that is not an array is ignored; nothing else is read.

```typescript
import { genericClaimsProfile } from "blendsdk/authz";

genericClaimsProfile.extract({
    userInfo: { roles: ["admin"], permissions: ["invoice:read"] },
});
// ["role:admin", "permission:invoice:read"]
```

### `azureClaimsProfile`

The Azure Entra ID claim profile. Reads the `roles` array, the whitespace-delimited `scp` (scope) claim, and the `groups` array from the merged claims, emitting `role:`, `scp:`, and `group:` keys. It never emits `permission:`, because Azure scopes are not application permissions; grant permissions by mapping `scp:` and `group:` keys in the grant map.

```typescript fragment
const azureClaimsProfile: ClaimsProfile
```

**Members**

| Member | Type | Description |
| --- | --- | --- |
| `name` | `string` | Always `"azure"` — the profile name. |
| `extract` | `(identity: ProviderIdentity) => readonly string[]` | Emits the keys listed below. |

**Emitted keys**

| Merged claim | Expected shape | Emitted keys |
| --- | --- | --- |
| `roles` | Array of strings | `role:<entry>` for each string entry, in order. |
| `scp` | Whitespace-delimited string | `scp:<scope>` per scope, in order; empty segments are skipped. |
| `groups` | Array of strings | `group:<entry>` for each string entry, in order. |

A `scp` claim that is not a string is ignored; `roles` and `groups` claims that are not arrays are ignored; non-string entries are dropped.

```typescript
import { azureClaimsProfile } from "blendsdk/authz";

azureClaimsProfile.extract({
    userInfo: {},
    accessTokenClaims: {
        roles: ["App.Admin"],
        scp: "Invoice.Read Invoice.Write",
        groups: ["Finance"],
    },
});
// ["role:App.Admin", "scp:Invoice.Read", "scp:Invoice.Write", "group:Finance"]
```

---

## Runtime Guard

Validate values that arrive from outside the application — a claim read from a token payload, a value passed as a request parameter — before trusting them.

### `isOneOf`

Returns `true` when `value` is a string that appears in `allowed`.

```typescript fragment
function isOneOf<const T extends string>(value: unknown, allowed: readonly T[]): value is T
```

**Type parameters**

| Type parameter | Constraint | Description |
| --- | --- | --- |
| `T` | `string` | The union of application-owned values; inferred from `allowed` via the `const` modifier. |

**Parameters**

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `value` | `unknown` | Yes | — | The untrusted value to check. |
| `allowed` | `readonly T[]` | Yes | — | The application-owned values that are acceptable. |

**Returns**: `value is T` — a type predicate; `true` when `value` is one of the allowed strings.

The value's type is checked first and membership second, so a number, an object, or `null` is rejected rather than coerced, and a string must match an allowed value exactly and case-sensitively. Because the parameter is `unknown`, the guard also rejects values of the wrong type instead of failing later. The `const` type parameter narrows `unknown` to the derived union without a cast.

```typescript
import { isOneOf } from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;
const raw: unknown = "admin";

if (isOneOf(raw, Object.values(ROLES))) {
    const role: "admin" | "user" = raw; // narrowed — no cast needed
    console.log(`Granting role: ${role}`);
}

isOneOf("root", Object.values(ROLES)); // false
isOneOf(42, Object.values(ROLES)); // false — a non-string value is rejected
```

---

## Vocabulary Types

Type-only declarations that define the authorization vocabulary. All are erased at runtime and can be imported with `import type`. Roles and permissions are plain strings — the package ships no default names, so an application owns its vocabulary.

### `Role`

```typescript fragment
type Role = string
```

A named role that groups related permissions. Roles are free-form strings; applications define their own values, usually in one shared constant object, and reuse them on the server and in the browser. There is no registry, and every comparison is exact and case-sensitive.

### `Permission`

```typescript fragment
type Permission = string
```

A named capability, conventionally written `resource:action` — for example `invoice:read`. Permissions are free-form strings, so an application can adopt any naming scheme; the convention keeps related capabilities grouped and reads well in logs.

### `AccessPrincipal`

```typescript fragment
interface AccessPrincipal {
    roles: readonly Role[];
    permissions: readonly Permission[];
}
```

| Property | Type | Description |
| --- | --- | --- |
| `roles` | `readonly Role[]` | The roles the principal holds. |
| `permissions` | `readonly Permission[]` | The permissions the principal holds. |

The grants a principal holds, and the only input the evaluation functions read. Plain, serializable data with no methods: it can be stored on a session, survive a JSON round-trip, and be re-evaluated in the browser.

### `AccessMode`

```typescript fragment
type AccessMode = "any" | "all"
```

How an access requirement combines its lists.

| Value | Description |
| --- | --- |
| `"any"` | The principal must hold at least one listed role or permission. The default when `AccessRequirement.mode` is omitted. |
| `"all"` | The principal must hold every listed role and permission. |

### `AccessRequirement`

```typescript fragment
interface AccessRequirement {
    roles?: readonly Role[];
    permissions?: readonly Permission[];
    mode?: AccessMode;
}
```

| Property | Type | Description |
| --- | --- | --- |
| `roles` | `readonly Role[] \| undefined` | Roles the principal must hold, subject to `mode`. Absent is treated as empty. |
| `permissions` | `readonly Permission[] \| undefined` | Permissions the principal must hold, subject to `mode`. Absent is treated as empty. |
| `mode` | `AccessMode \| undefined` | How the two lists combine. Defaults to `"any"`. |

A check to run against a principal, evaluated by [`satisfiesAccess`](#satisfiesaccess). An absent or empty requirement is always satisfied, which makes it safe to pass through a requirement the application did not configure.

### `AllowedGrants`

```typescript fragment
interface AllowedGrants {
    roles?: readonly Role[];
    permissions?: readonly Permission[];
}
```

| Property | Type | Description |
| --- | --- | --- |
| `roles` | `readonly Role[] \| undefined` | Canonical roles that may be granted directly from an unmapped `role:` key. |
| `permissions` | `readonly Permission[] \| undefined` | Canonical permissions that may be granted directly from an unmapped `permission:` key. |

The application-owned values that may grant authority without a map entry — the allowlist for canonical claims. A claim such as `role:admin` grants the `admin` role only when the application lists `admin` here, which keeps authority with the application instead of the identity provider. When the object (or the relevant list) is absent, unmapped keys grant nothing: translation fails closed.

---

## Identity and Translation Types

Type-only declarations used by the claim profiles and the translator.

### `ProviderIdentity`

```typescript fragment
interface ProviderIdentity {
    userInfo: Record<string, unknown>;
    idTokenClaims?: Record<string, unknown>;
    accessTokenClaims?: Record<string, unknown>;
    scopes?: readonly string[];
}
```

| Property | Type | Description |
| --- | --- | --- |
| `userInfo` | `Record<string, unknown>` | User info returned by the provider, such as the OIDC `/userinfo` response. Required. |
| `idTokenClaims` | `Record<string, unknown> \| undefined` | Claims decoded from the OIDC identity token, when one is available. |
| `accessTokenClaims` | `Record<string, unknown> \| undefined` | Claims decoded from the access token, when one is available. Wins on claim conflicts. |
| `scopes` | `readonly string[] \| undefined` | OAuth scopes granted to the access token; read by custom profiles only. |

Everything the application collected from the identity provider about one caller. The package never contacts the provider, decodes a token, or refreshes credentials — the application assembles the identity from claims it already holds. Profiles resolve each claim independently across the three claim sources with the merge order `userInfo` → `idTokenClaims` → `accessTokenClaims`: when several sources define the same claim, the access token wins, and a later source's array replaces an earlier one wholesale rather than concatenating with it. Claim values are deliberately typed `unknown`; the built-in profiles narrow them and drop malformed values.

### `GrantSource`

```typescript fragment
type GrantSource = "role" | "scp" | "group" | "permission"
```

| Value | Key prefix | Canonical | Description |
| --- | --- | --- | --- |
| `"role"` | `role:` | Yes | A role claim, for example an OIDC `roles` array. |
| `"scp"` | `scp:` | No | An OAuth scope claim, for example the Azure `scp` string. |
| `"group"` | `group:` | No | A directory group claim. |
| `"permission"` | `permission:` | Yes | A canonical permission value. |

The claim family a namespaced key came from. Only the canonical sources `role` and `permission` are eligible for direct grants through `AllowedGrants`; `scp` and `group` keys grant authority only through an explicit grant map entry.

### `GrantMap`

```typescript fragment
type GrantMap = Record<string, Partial<AccessPrincipal>>
```

Maps a namespaced key to the canonical grants it confers. Keys are namespaced keys such as `"role:admin"`, `"scp:Invoice.Read"`, or `"group:Finance"`; each value is a partial principal:

| Property | Type | Description |
| --- | --- | --- |
| `roles` | `readonly Role[] \| undefined` | Canonical roles the key grants. |
| `permissions` | `readonly Permission[] \| undefined` | Canonical permissions the key grants. |

The map is trusted application configuration: a listed key always grants its mapped values, even when those values are not in an allowlist — that is how provider-specific labels such as Azure groups become canonical roles and permissions. Lookups use own-property checks, so an inherited property never grants.

```typescript
import type { GrantMap } from "blendsdk/authz";

const map: GrantMap = {
    "group:Finance": { roles: ["finance"] },
    "scp:Invoice.Read": { permissions: ["invoice:read"] },
};
```

### `ClaimsProfile`

```typescript fragment
interface ClaimsProfile {
    readonly name: string;
    extract(identity: ProviderIdentity): readonly string[];
}
```

**Properties**

| Property | Type | Description |
| --- | --- | --- |
| `name` | `readonly string` | Human-readable profile name, for example `"generic"` or `"azure"`. |

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `extract` | `(identity: ProviderIdentity) => readonly string[]` | `readonly string[]` | Returns the namespaced keys such as `role:admin` or `scp:Invoice.Read` found in the identity. |

Converts a provider identity into the namespaced keys translation understands. Implement it to support a provider whose claims do not match a built-in profile. Use [`grantKey`](#grantkey) to build keys so the `source:value` format stays consistent, and keep the implementation pure — a function of the identity alone.

### `ClaimsTranslator`

```typescript fragment
interface ClaimsTranslator {
    translate(identity: ProviderIdentity): AccessPrincipal;
}
```

**Methods**

| Method | Signature | Returns | Description |
| --- | --- | --- | --- |
| `translate` | `(identity: ProviderIdentity) => AccessPrincipal` | `AccessPrincipal` | Translates the identity into the roles and permissions it holds. |

Converts a provider identity into the canonical grants a principal holds. Create one with [`createClaimsTranslator`](#createclaimstranslator); the translator closes over the profile, grant map, and options, so it can be reused for every identity.

### `TranslatorOptions`

```typescript fragment
interface TranslatorOptions {
    allowed?: AllowedGrants;
    onUnmapped?: (key: string) => void;
}
```

| Property | Type | Description |
| --- | --- | --- |
| `allowed` | `AllowedGrants \| undefined` | Canonical values that may grant authority without a map entry. When omitted, an unmapped key grants nothing, so translation fails closed. |
| `onUnmapped` | `((key: string) => void) \| undefined` | Called for every key that yields no grant. Receives the key name only, never a claim value, so the key is safe to log. |

---

## Full Import Statement

Every public symbol in one place — values with a regular import, types with `import type`:

```typescript
import {
    azureClaimsProfile,
    createClaimsTranslator,
    genericClaimsProfile,
    grantKey,
    hasPermission,
    hasRole,
    isOneOf,
    resolveGrants,
    satisfiesAccess,
} from "blendsdk/authz";
import type {
    AccessMode,
    AccessPrincipal,
    AccessRequirement,
    AllowedGrants,
    ClaimsProfile,
    ClaimsTranslator,
    GrantMap,
    GrantSource,
    Permission,
    ProviderIdentity,
    Role,
    TranslatorOptions,
} from "blendsdk/authz";
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
