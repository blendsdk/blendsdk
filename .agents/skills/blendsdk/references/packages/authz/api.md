> **Package**: `blendsdk/authz`

# authz API Reference

---

## API Overview

The `blendsdk/authz` package provides a set of functions and interfaces for handling authorization in a provider-agnostic manner. This includes role and permission management, claims translation, and access evaluation.

---

## Interfaces

### ClaimsProfile

The `ClaimsProfile` interface defines a contract for extracting claims from a provider identity, mapping them to application-specific roles and permissions.

#### Properties

| Property | Type                      | Description                                   |
|----------|---------------------------|-----------------------------------------------|
| name     | `string`                  | The human-readable name of the profile.      |
| extract  | `(identity: ProviderIdentity) => readonly string[]` | Method to extract namespaced keys from the provider identity. |

---

## Functions

### createClaimsTranslator

Creates a claims translator that reads a claims profile and translates provider-specific claims into canonical roles and permissions.

```typescript fragment
createClaimsTranslator(
    profile: ClaimsProfile,
    map: GrantMap,
    options?: TranslatorOptions
): ClaimsTranslator;
```

#### Parameters

| Parameter | Type                | Required | Default | Description                                                  |
|-----------|---------------------|----------|---------|--------------------------------------------------------------|
| profile   | `ClaimsProfile`     | Yes      |         | The claims profile that defines how to extract claims.       |
| map       | `GrantMap`          | Yes      |         | A mapping from namespaced keys to internal roles/permissions. |
| options    | `TranslatorOptions` | No       | `{}`    | Options for allowed values and unmapped claim handling.      |

#### Returns
- `ClaimsTranslator`: A translator object that can convert provider identities into canonical grants.

#### Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
} from 'blendsdk/authz';

const translator = createClaimsTranslator(
    genericClaimsProfile,
    {},
    { allowed: { roles: ['admin'] } }
);

const principal = translator.translate({
    userInfo: { roles: ['admin'], permissions: [] },
});

console.log(principal); // { roles: ['admin'], permissions: [] }
```

---

### satisfiesAccess

Evaluates whether a principal satisfies the access requirements defined by roles and permissions.

```typescript fragment
satisfiesAccess(
    principal: AccessPrincipal,
    requirement: AccessRequirement
): boolean;
```

#### Parameters

| Parameter  | Type               | Required | Default | Description                                              |
|------------|--------------------|----------|---------|----------------------------------------------------------|
| principal  | `AccessPrincipal`   | Yes      |         | The principal whose roles and permissions will be checked against the requirements. |
| requirement| `AccessRequirement` | Yes      |         | The requirement that specifies the required roles and permissions. |

#### Returns
- `boolean`: Returns `true` if the principal meets the access requirement; `false` otherwise.

#### Example
```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ['admin'],
    permissions: ['invoice:read'],
};

const requirement = {
    roles: ['admin'],
    permissions: ['invoice:write'],
    mode: 'any',
};

console.log(satisfiesAccess(principal, requirement)); // true
```

---

### hasRole

Checks if a principal holds a specific role.

```typescript fragment
hasRole(
    principal: AccessPrincipal,
    role: Role
): boolean;
```

#### Parameters

| Parameter | Type               | Required | Default | Description                                           |
|-----------|--------------------|----------|---------|-------------------------------------------------------|
| principal | `AccessPrincipal`   | Yes      |         | The principal to check the role against.             |
| role      | `Role`             | Yes      |         | The role to check for in the principal’s held roles. |

#### Returns
- `boolean`: Returns `true` if the principal holds the specified role; `false` otherwise.

#### Example
```typescript
import { hasRole } from 'blendsdk/authz';

const principal = {
    roles: ['admin'],
    permissions: [],
};

console.log(hasRole(principal, 'admin')); // true
```

---

### hasPermission

Checks if a principal holds a specific permission.

```typescript fragment
hasPermission(
    principal: AccessPrincipal,
    permission: Permission
): boolean;
```

#### Parameters

| Parameter  | Type               | Required | Default | Description                                           |
|------------|--------------------|----------|---------|-------------------------------------------------------|
| principal  | `AccessPrincipal`   | Yes      |         | The principal to check the permission against.       |
| permission | `Permission`       | Yes      |         | The permission to check for in the principal’s held permissions. |

#### Returns
- `boolean`: Returns `true` if the principal holds the specified permission; `false` otherwise.

#### Example
```typescript
import { hasPermission } from 'blendsdk/authz';

const principal = {
    roles: [],
    permissions: ['invoice:read'],
};

console.log(hasPermission(principal, 'invoice:read')); // true
```

---

## Types & Interfaces

### AccessPrincipal

Represents the grants held by a principal.

#### Properties

| Property   | Type                   | Description                                   |
|------------|------------------------|-----------------------------------------------|
| roles      | `readonly Role[]`      | Array of role strings held by the principal. |
| permissions| `readonly Permission[]` | Array of permission strings held by the principal. |

### AccessRequirement

Represents a requirement to be satisfied by a principal.

#### Properties

| Property   | Type                        | Description                                   |
|------------|-----------------------------|-----------------------------------------------|
| roles      | `readonly Role[]`           | Array of roles that the principal must hold. |
| permissions| `readonly Permission[]`      | Array of permissions that the principal must hold. |
| mode       | `AccessMode`                | Specifies the combination method of roles and permissions (defaults to `'any'`). |

### GrantMap

Maps namespaced keys to the canonical grants they confer.

#### Type Definition
```typescript
type GrantMap = Record<string, Partial<AccessPrincipal>>;
```

### TranslatorOptions

Options for configuring a claims translator.

#### Properties

| Property     | Type                            | Description                                   |
|--------------|---------------------------------|-----------------------------------------------|
| allowed      | `AllowedGrants`                 | Canonical values allowed without a map entry. |
| onUnmapped   | `(key: string) => void`        | Callback invoked for each key that yields no grant. |

---

## Types

### AccessMode

Defines how access requirements combine lists of roles and permissions.

| Value  | Description                                         |
|--------|-----------------------------------------------------|
| `any`  | The principal must hold at least one listed role or permission. |
| `all`  | The principal must hold every listed role and permission. |

--- 

This API Reference provides an overview of the `blendsdk/authz` package, detailing its key functionalities, types, and methods for managing authorization effectively in a TypeScript environment.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
