> **Package**: `blendsdk/authz`

# authz Core Concepts

---

## Access Principal

### What It Is
An `AccessPrincipal` represents the subject of authorization checks, detailing the roles and permissions it holds. This structure is essential for determining what actions a user can perform based on their assigned roles and corresponding permissions.

### How It Works
The `AccessPrincipal` interface has two properties: `roles` and `permissions`, both of which are arrays of strings. The roles represent broad categories of authority, while permissions denote specific actions that can be executed. This encapsulation enables the authorization evaluation functions to work uniformly regardless of how the roles or permissions are obtained.

### Complete Example
```typescript
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["admin", "editor"],
    permissions: ["invoice:read", "invoice:write"],
};

console.log(principal); // { roles: ["admin", "editor"], permissions: ["invoice:read", "invoice:write"] }
```

### Key Methods/Properties Table
| Name         | Type                  | Description                                   |
|--------------|-----------------------|-----------------------------------------------|
| roles        | readonly Role[]       | Array of role strings held by the principal. |
| permissions  | readonly Permission[]  | Array of permission strings held by the principal. |

---

## Access Requirement

### What It Is
An `AccessRequirement` defines the criteria that must be satisfied for a principal to access a resource or perform an action. It allows applications to specify what roles or permissions are required.

### How It Works
The `AccessRequirement` interface consists of optional properties: `roles`, `permissions`, and `mode`. The `mode` determines whether any or all of the specified roles/permissions must be held for access to be granted. If it is absent, the default is `any`.

### Complete Example
```typescript
import type { AccessRequirement } from "blendsdk/authz";

const requirement: AccessRequirement = {
    roles: ["admin"],
    permissions: ["invoice:read"],
    mode: "all",
};

console.log(requirement); // { roles: ["admin"], permissions: ["invoice:read"], mode: "all" }
```

### Key Methods/Properties Table
| Name         | Type                  | Description                                   |
|--------------|-----------------------|-----------------------------------------------|
| roles        | readonly Role[]       | Array of required role strings.               |
| permissions  | readonly Permission[]  | Array of required permission strings.         |
| mode         | AccessMode            | Specifies whether `any` or `all` roles/permissions must be held. |

---

## Claims Translator

### What It Is
The `ClaimsTranslator` provides an interface for converting authorization claims from an identity provider into a standardized format of roles and permissions that your application can understand and use.

### How It Works
Using a `ClaimsProfile`, this translator reads claims from a `ProviderIdentity`, transforms them into application-friendly roles and permissions, and utilizes a grant map to correlate provider-specific claims to canonical values.

### Complete Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
} from "blendsdk/authz";

const translator = createClaimsTranslator(
    genericClaimsProfile,
    { "role:app-admin": { roles: ["admin"] } },
    { allowed: { roles: ["user"], permissions: ["invoice:read"] } }
);

const principal = translator.translate({
    userInfo: { roles: ["app-admin", "user"] },
});

console.log(principal); // { roles: ["admin", "user"], permissions: [] }
```

### Key Methods/Properties Table
| Name         | Type                  | Description                                   |
|--------------|-----------------------|-----------------------------------------------|
| translate    | (identity: ProviderIdentity) => AccessPrincipal | Converts an identity provider's claims to canonical roles and permissions. |

---

## Access Evaluation

### What It Is
Access evaluation entails assessing whether a given principal meets the criteria specified by an `AccessRequirement`. This function helps determine if a user is authorized to perform an action.

### How It Works
Functions like `satisfiesAccess`, `hasRole`, and `hasPermission` take the principal and the requirement, then evaluate whether the conditions are satisfied. The evaluation considers both roles and permissions based on the specified mode.

### Complete Example
```typescript
import { satisfiesAccess } from "blendsdk/authz";

const principal = {
    roles: ["editor"],
    permissions: ["invoice:read"],
};

const requirement = {
    roles: ["admin"],
    permissions: ["invoice:read"],
    mode: "any",
};

const accessGranted = satisfiesAccess(principal, requirement);
console.log(accessGranted); // true, because permissions satisfy the requirement
```

### Key Methods/Properties Table
| Name         | Type                  | Description                                   |
|--------------|-----------------------|-----------------------------------------------|
| satisfiesAccess | (principal: AccessPrincipal, requirement: AccessRequirement) => boolean | Checks if the principal meets the access requirement. |
| hasRole      | (principal: AccessPrincipal, role: Role) => boolean | Determines if the principal holds a specific role. |
| hasPermission | (principal: AccessPrincipal, permission: Permission) => boolean | Checks if the principal has a specific permission. |

---

## Claims Profiles

### What It Is
Claims profiles define the mapping between claims from an identity provider and the corresponding roles and permissions that your application recognizes. Built-in profiles facilitate seamless integration with common identity providers.

### How It Works
Each claims profile implements the `ClaimsProfile` interface and is responsible for extracting roles and permissions from a `ProviderIdentity`. For example, the `genericClaimsProfile` covers general claims from standard OIDC providers.

### Complete Example
```typescript
import { genericClaimsProfile } from "blendsdk/authz";

const keys = genericClaimsProfile.extract({
    userInfo: { roles: ["admin"], permissions: ["invoice:read"] },
});

console.log(keys); // ["role:admin", "permission:invoice:read"]
```

### Key Methods/Properties Table
| Name         | Type                      | Description                                   |
|--------------|---------------------------|-----------------------------------------------|
| extract      | (identity: ProviderIdentity) => readonly string[] | Extracts namespaced keys from the identity claims. |

---

---

# authz Basic Usage

---

## Installation

To install the `blendsdk/authz` package, use either npm or yarn:

```bash
npm install blendsdk/authz
```

or

```bash
yarn add blendsdk/authz
```

---

## Quick Start

Here's a minimal setup to get started with the `blendsdk/authz` package:

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";

const translator = createClaimsTranslator(
    genericClaimsProfile,
    {},
    { allowed: { roles: ["admin"] } }
);

const principal = translator.translate({ userInfo: { roles: ["admin"] } });
console.log(satisfiesAccess(principal, { roles: ["admin"] })); // true
```

---

## Fundamentals

### 1. Access Principal

An `AccessPrincipal` represents the subject of authorization checks, containing the roles and permissions held by the user.

```typescript
import type { AccessPrincipal } from "blendsdk/authz";

const principal: AccessPrincipal = {
    roles: ["admin"],
    permissions: ["invoice:read"],
};
```

### 2. Access Requirement

An `AccessRequirement` defines the criteria that must be fulfilled for access to be granted. 

```typescript
import type { AccessRequirement } from "blendsdk/authz";

const requirement: AccessRequirement = {
    roles: ["admin"],
    permissions: ["invoice:read"],
    mode: "any",
};
```

### 3. Claims Translator

The `ClaimsTranslator` is used to convert identity provider claims into application-friendly roles and permissions.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const translator = createClaimsTranslator(
    genericClaimsProfile,
    {},
    {}
);
```

### 4. Evaluating Access

You can evaluate whether a principal satisfies an access requirement using `satisfiesAccess`.

```typescript
import { satisfiesAccess } from "blendsdk/authz";

const principal = {
    roles: ["admin"],
    permissions: ["invoice:read"],
};

const requirement = {
    roles: ["admin"],
    permissions: ["invoice:write"],
    mode: "all", // Requires every listed role and permission
};

const accessGranted = satisfiesAccess(principal, requirement);
console.log(accessGranted); // false, because the required permission is not held
```

---

## Configuration

When creating a claims translator, you can provide a grant map and allowed values. Here are common configuration options:

| Name  | Type                | Default | Description                                      |
|-------|---------------------|---------|--------------------------------------------------|
| map   | GrantMap            | {}      | A mapping of provider claims to canonical roles/permissions. |
| allowed | AllowedGrants     | {}      | Canonical roles and permissions that may be granted directly without a map entry. |

---

## Error Handling

When using the `blendsdk/authz` package, it's important to implement error handling mechanisms effectively. Here are some common patterns:

### Handling Invalid Claims

The `createClaimsTranslator` function may be provided an `onUnmapped` callback to handle unmapped keys.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const onUnmapped = (key: string) => {
    console.warn(`Unmapped claim: ${key}`);
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    {},
    { onUnmapped }
);

const principal = translator.translate({ userInfo: { roles: ["unknown-role"] } });
```

### Checking for Access Denied

You can check whether access is denied as follows:

```typescript
import { satisfiesAccess } from "blendsdk/authz";

try {
    const accessGranted = satisfiesAccess(principal, requirement);
    if (!accessGranted) {
        throw new Error("Access denied");
    }
} catch (error) {
    console.error(error.message); // Log the access denial reason
}
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
