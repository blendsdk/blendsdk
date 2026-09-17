> **Package**: `blendsdk/authz`

# authz Advanced Patterns

---

## Claims-Based Role Mapping

### When to Use
This pattern is useful when you need to map roles from an external identity provider to your internal application roles while ensuring flexibility and adherence to strict type safety.

### Code Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";

const ROLES = { Admin: "admin", User: "user" } as const;
const PERMISSIONS = { InvoiceRead: "invoice:read" } as const;

const grantMap = {
    "role:provider-admin": { roles: [ROLES.Admin] },
    "role:provider-user": { roles: [ROLES.User] },
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    grantMap,
    {
        allowed: {
            roles: Object.values(ROLES),
            permissions: Object.values(PERMISSIONS),
        },
    }
);

const principal = translator.translate({
    userInfo: { roles: ["provider-admin"], permissions: [] },
});

console.log(satisfiesAccess(principal, { roles: [ROLES.Admin] })); // true
```

### Explanation
This approach allows seamless integration with multiple identity providers, enabling you to translate provider-specific roles directly into your application's roles. By defining a grant map, you can precisely control which external roles map to your internal architecture, promoting security and manageability.

### Caveats
- Ensure that the provided roles and permissions within the grant map are defined in your `AllowedGrants`.
- The application should always verify that mapped roles align with known roles to avoid security pitfalls.

---

## Dynamic Access Control Based on Permissions

### When to Use
Utilize this pattern when your application requires dynamic evaluation of access permissions based on user attributes or environmental conditions at runtime.

### Code Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
    hasPermission,
} from "blendsdk/authz";

const translator = createClaimsTranslator(genericClaimsProfile, {}, {});

const userIdentity = {
    userInfo: { roles: ["user"], permissions: ["invoice:read"] },
};
const principal = translator.translate(userIdentity);

const resourceAction = "invoice:write";
const requirement = { permissions: [resourceAction] };

if (hasPermission(principal, resourceAction)) {
    console.log(`User has access to perform ${resourceAction}`); // Dynamic evaluation
} else {
    console.log(`Access denied for ${resourceAction}`);
}

console.log(satisfiesAccess(principal, requirement)); // false
```

### Explanation
This pattern enables dynamic access control by evaluating specific permissions that may change depending on user roles, actions, or contextual conditions. It leverages the `hasPermission` function for straightforward checks against the principal's granted permissions.

### Caveats
- Evaluate performance impacts if permission checks are conducted frequently in high-load scenarios; consider caching strategies if necessary.
- Ensure that the permissions and actions align with your application's business logic and security requirements.

---

## Combining Role and Permission Checks

### When to Use
This pattern should be applied when both roles and permissions need to be checked together to grant access to more complex resources or actions.

### Code Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";

const ROLES = { Admin: "admin", Editor: "editor", Viewer: "viewer" } as const;
const PERMISSIONS = { ManageUsers: "manage:users", ReadInvoices: "read:invoices" } as const;

const grantMap = {
    "role:admin": { roles: [ROLES.Admin], permissions: [PERMISSIONS.ManageUsers] },
    "role:editor": { roles: [ROLES.Editor], permissions: [PERMISSIONS.ReadInvoices] },
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    grantMap,
    { allowed: { roles: Object.values(ROLES), permissions: Object.values(PERMISSIONS) } }
);

const principal = translator.translate({
    userInfo: { roles: ["admin"], permissions: [] },
});

// Require both a specific role and permission
const requirement = {
    roles: [ROLES.Admin],
    permissions: [PERMISSIONS.ManageUsers],
    mode: "all", // ensuring 'all' should be held
};

console.log(satisfiesAccess(principal, requirement)); // true
```

### Explanation
By combining checks for both roles and permissions, applications can enforce finer-grained access control, ensuring that users have both the necessary roles and the requisite permissions for specific actions.

### Caveats
- Evaluate the complexity of your access requirements and their implications for performance.
- Maintain clear documentation of roles and permissions to prevent misconfigurations.

---

## Unmapped Claims Handling

### When to Use
This pattern is essential when dealing with claims from identity providers that may not have a direct mapping to your application roles or permissions, necessitating a robust error handling strategy.

### Code Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
} from "blendsdk/authz";

// Define a function to handle unmapped claims
const onUnmapped = (key: string) => {
    console.warn(`Unmapped claim detected: ${key}`);
};

// Create a translator with an unmapped callback
const translator = createClaimsTranslator(
    genericClaimsProfile,
    {},
    { onUnmapped }
);

// Simulate receiving an identity with unknown roles
const userIdentity = {
    userInfo: { roles: ["unknown-role"] },
};

const principal = translator.translate(userIdentity); // Logs warning for unmapped role
```

### Explanation
Implementing an `onUnmapped` callback allows developers to gracefully handle unexpected or unknown claims. Logging or alerting administrators about unmapped claims can facilitate troubleshooting and improve security monitoring.

### Caveats
- Ensure appropriate logging levels for unmapped claims; excessive logging can lead to performance overhead or log flooding.
- Regularly review and update your mappings based on the claims you expect from identity providers to reduce the frequency of unmapped claims.

--- 

## Complex Role Hierarchies with Inheritance

### When to Use
This pattern is valuable in applications where roles have hierarchical relationships, allowing for inheritance of permissions from parent roles.

### Code Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from "blendsdk/authz";

const ROLES = { Admin: "admin", Editor: "editor", Viewer: "viewer" } as const;
const PERMISSIONS = { Read: "read", Write: "write" } as const;

// Role hierarchy: Admin > Editor > Viewer
const grantMap = {
    "role:admin": { roles: [ROLES.Admin], permissions: [PERMISSIONS.Write, PERMISSIONS.Read] },
    "role:editor": { roles: [ROLES.Editor], permissions: [PERMISSIONS.Read] },
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    grantMap,
    { allowed: { roles: Object.values(ROLES), permissions: Object.values(PERMISSIONS) } }
);

const principal = translator.translate({
    userInfo: { roles: ["editor"], permissions: [] },
});

const requirement = {
    mode: "any",
    permissions: [PERMISSIONS.Write],
};

console.log(satisfiesAccess(principal, requirement)); // false
```

### Explanation
By establishing a role hierarchy, applications can effectively manage which roles inherit the capabilities of others, streamlining permission management and reducing redundancy in permission assignments.

### Caveats
- Be cautious with circular inheritance; it could lead to logical issues in access evaluations.
- Ensure that your role hierarchy is well-defined and documented to avoid misconfigurations.

---

---

# authz Common Scenarios

---

## How do I create a claims translator?

Creating a claims translator allows you to map provider-specific claims into your application's standardized roles and permissions.

### Code Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
} from 'blendsdk/authz';

const grantMap = {
    "role:admin": { roles: ["admin"] },
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    grantMap,
    { allowed: { roles: ["admin"] } }
);
```

---

## How do I translate provider claims?

To translate provider claims into roles and permissions, use the `translate` method of the claims translator.

### Code Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
} from 'blendsdk/authz';

const grantMap = {
    "role:admin": { roles: ["admin"] },
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    grantMap,
    { allowed: { roles: ["admin"] } }
);

const principal = translator.translate({
    userInfo: { roles: ["admin"] },
});

console.log(principal); // { roles: ["admin"], permissions: [] }
```

---

## How do I check if a principal has a specific role?

You can check if a principal holds a specific role using the `hasRole` function.

### Code Example
```typescript
import { hasRole } from 'blendsdk/authz';

const principal = {
    roles: ["admin"],
    permissions: [],
};

const isAdmin = hasRole(principal, "admin");
console.log(isAdmin); // true
```

---

## How do I check if a principal has a specific permission?

To check if a principal has a specific permission, use the `hasPermission` function.

### Code Example
```typescript
import { hasPermission } from 'blendsdk/authz';

const principal = {
    roles: [],
    permissions: ["invoice:read"],
};

const canReadInvoice = hasPermission(principal, "invoice:read");
console.log(canReadInvoice); // true
```

---

## How do I evaluate access requirements against a principal?

Use the `satisfiesAccess` function to determine whether a principal meets the specified access requirements.

### Code Example
```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["admin"],
    permissions: ["invoice:read"],
};

const requirement = {
    roles: ["admin"],
    permissions: ["invoice:read"],
};

const accessGranted = satisfiesAccess(principal, requirement);
console.log(accessGranted); // true
```

---

## How do I handle unmapped claims?

You can use an `onUnmapped` callback when creating the claims translator to handle any unmapped claims effectively.

### Code Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
} from 'blendsdk/authz';

const onUnmapped = (key: string) => {
    console.warn(`Unmapped claim detected: ${key}`);
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    {},
    { onUnmapped }
);

const principal = translator.translate({
    userInfo: { roles: ["unknown-role"] },
});
```

---

## How do I ensure that roles and permissions are defined correctly?

Using strict TypeScript definitions can help ensure that roles and permissions are accurately represented.

### Code Example
```typescript
import type { AccessPrincipal } from 'blendsdk/authz';

const principal: AccessPrincipal = {
    roles: ["admin"], // Correctly defining roles
    permissions: [],  // Correctly defining permissions as an array
};
```

---

## How do I map provider roles to application roles?

You can define a grant map that specifies how roles from the provider are mapped to roles in your application.

### Code Example
```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
} from 'blendsdk/authz';

const grantMap = {
    "role:provider-admin": { roles: ["admin"] },
    "role:provider-editor": { roles: ["editor"] },
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    grantMap,
    { allowed: { roles: ["admin", "editor"] } }
);
```

---

## How do I combine role and permission checks?

You can check both roles and permissions when evaluating access requirements using the same `satisfiesAccess` function.

### Code Example
```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["admin"],
    permissions: ["invoice:read"],
};

const requirement = {
    roles: ["admin"],
    permissions: ["invoice:read"],
    mode: "all", // Ensures that all specified roles and permissions must be held
};

const accessGranted = satisfiesAccess(principal, requirement);
console.log(accessGranted); // true
```

---

## How do I use custom claim profiles?

You can define custom claim profiles to dictate how claims from providers should be interpreted and translated.

### Code Example
```typescript
import {
    createClaimsTranslator,
    ClaimsProfile,
} from 'blendsdk/authz';

const customProfile: ClaimsProfile = {
    name: "custom",
    extract(identity) {
        const roles = identity.userInfo.roles || [];
        return roles.map(role => `role:${role}`);
    },
};

const translator = createClaimsTranslator(
    customProfile,
    {},
    { allowed: { roles: ["custom-role"] } }
);

const principal = translator.translate({
    userInfo: { roles: ["custom-role"] },
});

console.log(principal); // { roles: ["custom-role"], permissions: [] }
```

---

## How do I implement error handling for access checks?

This can be done by wrapping access checks in try/catch blocks to handle potential errors gracefully.

### Code Example
```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["user"],
    permissions: [],
};

const requirement = {
    roles: ["admin"],
};

try {
    const accessGranted = satisfiesAccess(principal, requirement);
    if (!accessGranted) {
        throw new Error("Access denied");
    }
} catch (error) {
    console.error(error.message); // Log the access denial reason
}
```

---

## How do I optimize performance with access checks?

Consider caching the results of access checks when they are performed frequently to enhance performance.

### Code Example
```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const accessCache = new Map<string, boolean>();

const checkAccess = (principal, requirement) => {
    const cacheKey = JSON.stringify(principal) + JSON.stringify(requirement);
    if (accessCache.has(cacheKey)) {
        return accessCache.get(cacheKey);
    }
    
    const accessGranted = satisfiesAccess(principal, requirement);
    accessCache.set(cacheKey, accessGranted);
    return accessGranted;
};
```

---

## How do I ensure minimal permissions for principals?

By ensuring principals hold only the permissions they need, you can uphold the principle of least privilege.

### Code Example
```typescript
const principal = {
    roles: ["admin"],
    permissions: ["invoice:read"], // Only granting necessary permissions
};

const requirement = {
    permissions: ["invoice:write"], // Prevents overprivileging
};

const accessGranted = satisfiesAccess(principal, requirement);
console.log(accessGranted); // false
```

---

# authz Examples Library

---

## Basic Usage

### Create a Claims Translator
This example shows how to create a claims translator using the generic claims profile.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from 'blendsdk/authz';

const grantMap = {
    "role:admin": { roles: ["admin"] },
    "role:editor": { roles: ["editor"] },
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    grantMap,
    { allowed: { roles: ["admin", "editor"] } }
);

// Output translator object
console.log(translator);
```

---

### Translate Provider Claims
Translate provider claims into roles and permissions using the claims translator.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from 'blendsdk/authz';

const grantMap = {
    "role:admin": { roles: ["admin"] },
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    grantMap,
    { allowed: { roles: ["admin"] } }
);

const principal = translator.translate({
    userInfo: { roles: ["admin"] },
});

console.log(principal); // { roles: ["admin"], permissions: [] }
```

---

### Check if a Principal Has a Specific Role
This example checks if the principal holds a specific role.

```typescript
import { hasRole } from 'blendsdk/authz';

const principal = {
    roles: ["admin"],
    permissions: [],
};

const isAdmin = hasRole(principal, "admin");
console.log(isAdmin); // true
```

---

### Check if a Principal Has a Specific Permission
Use this example to check if the principal has a specific permission.

```typescript
import { hasPermission } from 'blendsdk/authz';

const principal = {
    roles: [],
    permissions: ["invoice:read"],
};

const canReadInvoice = hasPermission(principal, "invoice:read");
console.log(canReadInvoice); // true
```

---

### Evaluate Access Requirements
This example demonstrates how to evaluate whether a principal meets access requirements.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["admin"],
    permissions: ["invoice:read"],
};

const requirement = {
    roles: ["admin"],
    permissions: ["invoice:read"],
    mode: "all",
};

const accessGranted = satisfiesAccess(principal, requirement);
console.log(accessGranted); // true
```

---

### Handle Unmapped Claims
Handle unmapped claims by providing an `onUnmapped` callback during the translator creation.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from 'blendsdk/authz';

const onUnmapped = (key: string) => {
    console.warn(`Unmapped claim detected: ${key}`);
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    {},
    { onUnmapped }
);

const principal = translator.translate({
    userInfo: { roles: ["unknown-role"] },
});
// Check console for unmapped claim warning
```

---

## Advanced Usage

### Role Hierarchies
This example shows how to set up a role hierarchy to manage permissions.

```typescript
import {
    createClaimsTranslator,
    genericClaimsProfile,
    satisfiesAccess,
} from 'blendsdk/authz';

const ROLES = { Admin: "admin", Editor: "editor" } as const;
const grantMap = {
    "role:admin": { roles: [ROLES.Admin], permissions: ["manage:all"] },
    "role:editor": { roles: [ROLES.Editor], permissions: ["edit:content"] },
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    grantMap,
    { allowed: { roles: Object.values(ROLES) } }
);

const principal = translator.translate({
    userInfo: { roles: ["admin"] },
});

const requirement = {
    roles: [ROLES.Admin],
    permissions: ["manage:all"],
};

console.log(satisfiesAccess(principal, requirement)); // true
```

---

### Custom Claims Profiles
This example illustrates how to create and utilize a custom claims profile for specific scenarios.

```typescript
import {
    createClaimsTranslator,
    ClaimsProfile,
    satisfiesAccess,
} from 'blendsdk/authz';

const customProfile: ClaimsProfile = {
    name: "customProfile",
    extract(identity) {
        const roles = identity.userInfo.roles || [];
        return roles.map(role => `role:${role}`);
    },
};

const translator = createClaimsTranslator(
    customProfile,
    {},
    { allowed: { roles: ["admin"] } }
);

const principal = translator.translate({
    userInfo: { roles: ["admin"] },
});

console.log(principal); // { roles: ["admin"], permissions: [] }
```

---

### Error Handling in Access Checks
This example demonstrates how to handle errors gracefully during access evaluations.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["user"],
    permissions: [],
};

const requirement = {
    roles: ["admin"],
};

try {
    const accessGranted = satisfiesAccess(principal, requirement);
    if (!accessGranted) {
        throw new Error("Access denied.");
    }
} catch (error) {
    console.error(error.message); // Log the access denial reason
}
```

---

### Performance Optimization
This example showcases caching access evaluation results to improve performance.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const accessCache = new Map<string, boolean>();

const checkAccess = (principal, requirement) => {
    const cacheKey = JSON.stringify(principal) + JSON.stringify(requirement);
    if (accessCache.has(cacheKey)) {
        return accessCache.get(cacheKey);
    }
    
    const accessGranted = satisfiesAccess(principal, requirement);
    accessCache.set(cacheKey, accessGranted);
    return accessGranted;
};

const principal = {
    roles: ["admin"],
    permissions: ["invoice:read"],
};

const requirement = {
    roles: ["admin"],
    permissions: ["invoice:read"],
};

console.log(checkAccess(principal, requirement)); // true
```

--- 

## Edge Cases

### Empty Access Requirements
When the requirements are empty, access should be granted by default.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["admin"],
    permissions: [],
};

console.log(satisfiesAccess(principal, {})); // true
```

---

### Handling Duplicate Roles
The system should ignore duplicate roles when checking access.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["admin", "admin"],
    permissions: [],
};

const requirement = {
    roles: ["admin"],
};

console.log(satisfiesAccess(principal, requirement)); // true
```

---

### Unmapped Role Claims
Unmapped roles should trigger the defined callback.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from 'blendsdk/authz';

const onUnmapped = (key: string) => {
    console.warn(`Unmapped claim detected: ${key}`);
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    {},
    { onUnmapped }
);

const principal = translator.translate({
    userInfo: { roles: ["unknown-role"] },
});
// Console log warning for unmapped claims
```

---

## Assertions

### Validate Principal Structure
Ensure that your principal adheres to the structure required by the `AccessPrincipal`.

```typescript
import type { AccessPrincipal } from 'blendsdk/authz';

const principal: AccessPrincipal = {
    roles: ["admin"],
    permissions: [], // Always initialize these as arrays
};

console.log(principal);
```

---

### Check Access with Multiple Conditions
Evaluate access based on different permissions and roles.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["editor"],
    permissions: ["read:documents"],
};

const requirement = {
    roles: ["admin", "editor"],
    permissions: ["edit:documents"],
    mode: "any",
};

console.log(satisfiesAccess(principal, requirement)); // true
```

---

### Handle Role & Permission Combinations
Evaluate mixed conditions for granting access.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["admin", "editor"],
    permissions: ["edit:documents"],
};

const requirement = {
    roles: ["admin"],
    permissions: ["edit:documents"],
    mode: "all",
};

console.log(satisfiesAccess(principal, requirement)); // true
```

---

### Ensure all Required Permissions are Held
The requirement behaves correctly under the "all" mode.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["admin"],
    permissions: ["view:invoice"],
};

const requirement = {
    roles: ["admin"],
    permissions: ["view:invoice", "edit:invoice"],
    mode: "all",
};

console.log(satisfiesAccess(principal, requirement)); // false
```

--- 

### Satisfaction of Role-based Access
Confirm that access is granted when the principal satisfies role-based access as required.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["editor"],
    permissions: [],
};

const requirement = {
    roles: ["editor"],
};

console.log(satisfiesAccess(principal, requirement)); // true
```

---

### Unrecognized Permissions
If the principal has permissions that are not recognized, ensure that access reflects that appropriately.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ["user"],
    permissions: ["unknown:permission"],
};

const requirement = {
    roles: ["user"],
    permissions: ["known:permission"],
    mode: "all", // Requires the held role and the unrecognized permission
};

console.log(satisfiesAccess(principal, requirement)); // false, because the required permission is not held
```

---

### Handle Multiple Unmapped Claims
Ensure that multiple unmapped claims are handled together.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from 'blendsdk/authz';

const onUnmapped = (key: string) => {
    console.warn(`Unmapped claim detected: ${key}`);
};

const translator = createClaimsTranslator(
    genericClaimsProfile,
    {},
    { onUnmapped }
);

const principal = translator.translate({
    userInfo: { roles: ["unknown-role1", "unknown-role2"] },
});

// Console logs for each unmapped claim
```

---

## Conclusion

The examples provided here demonstrate how to effectively utilize the `blendsdk/authz` package. This library empowers developers to implement flexible and secure authorization strategies in TypeScript applications. By leveraging claims translation, access evaluation, and structured role/permission management, developers can enhance the security and maintainability of their applications.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
