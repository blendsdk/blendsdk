> **Package**: `blendsdk/authz`

# authz Best Practices

---

## Do / Don't Pairs

### Do: Use Strict Type Definitions
❌ **Wrong**
```typescript
import { hasRole } from "blendsdk/authz";

const principal = {
    roles: ["admin"],
    permissions: null, // Should not use null, as it's not a string array
};

hasRole(principal, "admin");
```
✅ **Correct**
```typescript
import { hasRole } from "blendsdk/authz";

const principal = {
    roles: ["admin"],
    permissions: [], // Correctly using an empty array for permissions
};

hasRole(principal, "admin");
```
**Why:** Using `null` for permissions breaks the expected type for an `AccessPrincipal`. Always ensure that `roles` and `permissions` are defined as arrays, maintaining strict type consistency.

---

### Don't: Ignore Unmapped Claims
❌ **Wrong**
```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const translator = createClaimsTranslator(genericClaimsProfile, {});

const principal = translator.translate({
    userInfo: { roles: ["unknown-role"] }, // Unmapped role
});
```
✅ **Correct**
```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const onUnmapped = (key: string) => {
    console.warn(`Unmapped claim detected: ${key}`);
};

const translator = createClaimsTranslator(genericClaimsProfile, {}, { onUnmapped });

const principal = translator.translate({
    userInfo: { roles: ["unknown-role"] },
}); // Logs warning
```
**Why:** Ignoring unmapped claims can lead to unhandled situations in your application's authorization logic. Implementing an `onUnmapped` callback allows you to handle such cases effectively.

---

### Do: Utilize Grants Map
❌ **Wrong**
```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const translator = createClaimsTranslator(genericClaimsProfile, {});

const principal = translator.translate({
    userInfo: { roles: ["provider-admin"] },
});
```
✅ **Correct**
```typescript
import { createClaimsTranslator, genericClaimsProfile } from "blendsdk/authz";

const grantMap = {
    "role:provider-admin": { roles: ["admin"] },
};

const translator = createClaimsTranslator(genericClaimsProfile, grantMap);

const principal = translator.translate({
    userInfo: { roles: ["provider-admin"] },
});
```
**Why:** Mapping provider-specific roles to your application's roles enhances security and maintainability by explicitly defining how incoming roles are translated.

---

### Don't: Overuse Roles and Permissions
❌ **Wrong**
```typescript
import { satisfiesAccess } from "blendsdk/authz";

const principal = {
    roles: ["admin", "editor"],
    permissions: ["invoice:read", "invoice:write"], // Excessive permissions
};

const requirement = {
    permissions: ["invoice:read"],
};

satisfiesAccess(principal, requirement); // May be overly permissive
```
✅ **Correct**
```typescript
import { satisfiesAccess } from "blendsdk/authz";

const principal = {
    roles: ["admin"],
    permissions: ["invoice:read"], // Streamlined permissions
};

const requirement = {
    permissions: ["invoice:read"],
};

satisfiesAccess(principal, requirement); // Clean and clear
```
**Why:** Reducing the number of roles and permissions a principal has minimizes complexity and potential security risks, making it easier to manage authorization logic.

---

## Anti-Patterns

### 1. Hardcoding Role Strings
Hardcoding role strings in multiple places can lead to inconsistencies and maintenance challenges.

**Avoid this:**
```typescript
const isAdmin = hasRole(principal, "admin");
const isEditor = hasRole(principal, "editor");
```

### Fix:
Define roles as constants and reuse them.
```typescript
const ROLES = { Admin: "admin", Editor: "editor" } as const;

const isAdmin = hasRole(principal, ROLES.Admin);
```

### 2. Overly Complex Grant Maps
Complex mappings can lead to confusion and errors. Ensure mappings are straightforward.

**Avoid this:**
```typescript
const grantMap = {
    "role:admin": { roles: ["admin"], permissions: ["manage:users"] },
    "role:editor": { roles: ["editor"], permissions: ["edit:pages", "view:pages"], additional: "unexpected" }, // Mixed responsibilities
};
```

### Fix:
Keep the mapping focused on roles and permissions.
```typescript
const grantMap = {
    "role:admin": { roles: ["admin"], permissions: ["manage:users"] },
    "role:editor": { roles: ["editor"], permissions: ["edit:pages"] },
};
```

---

## Performance Tips

### 1. Limit Role Checks
Minimize the number of role checks within high-frequency loops (e.g., request processing) to boost performance.

**Example:**
```typescript
for (let i = 0; i < requests.length; i++) {
    if (!hasRole(principal, "admin")) continue; // Only check once
}
```

### 2. Cache Principal Results
Cache the results of costly evaluations of principals when the same principal access requirements are checked multiple times.

### Example:
```typescript
const accessCache = new Map<string, boolean>();

const checkAccess = (principal: AccessPrincipal, requirement: AccessRequirement) => {
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

## Security Considerations

### 1. Validate Claims
Always validate incoming claims against expected roles and permissions to prevent unauthorized access.

```typescript
const validateClaims = (claims: unknown): claims is ProviderIdentity => {
    // Perform validation logic to ensure claims structure
};
```

### 2. Sanitize Inputs
When using role names or permissions derived from user input or external sources, ensure that they're sanitized accordingly.

```typescript
const sanitizedRole = isOneOf(rawInput, Object.values(ROLES)) ? rawInput : null;
```

### 3. Fine-Grained Permissions
Implement fine-grained permissions to better control what actions a user can perform.

```typescript
const requirement = {
    roles: [],
    permissions: ["invoice:read", "invoice:write"],
};
```

By adhering to these best practices, you can ensure that your application using the `blendsdk/authz` package is both secure and efficient.

---

# authz Testing Patterns

---

## Test Setup

Before writing tests for the `blendsdk/authz` package, ensure that you have the necessary imports and configuration in place.

### Required Imports
```typescript
import { describe, it, expect } from 'vitest';
import {
    hasPermission,
    hasRole,
    satisfiesAccess,
    createClaimsTranslator,
    genericClaimsProfile,
} from 'blendsdk/authz';
import type { AccessPrincipal } from 'blendsdk/authz';
```

### Test Framework Configuration
To configure Vitest for your tests, you may need to adjust your `vitest.config.ts` file. Here is a minimal sample configuration that you can elaborate on:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
    },
});
```

### Test Helpers
Create helper functions to set up common scenarios or test data.
```typescript
/** Build a principal that holds the given roles and permissions. */
function createPrincipal(roles: string[] = [], permissions: string[] = []): AccessPrincipal {
    return { roles, permissions };
}
```

---

## Unit Testing

### How to Unit Test with authz

Unit tests for the `blendsdk/authz` package involve testing individual functions such as `hasRole`, `hasPermission`, and `satisfiesAccess`. Each test should focus on confirming the expected behavior for a specific input or condition.

### Example: Testing Role and Permission Functions
```typescript
describe('Authorization Functions', () => {
    it('should correctly identify held roles', () => {
        const principal = createPrincipal(['admin']);
        expect(hasRole(principal, 'admin')).toBe(true);
        expect(hasRole(principal, 'user')).toBe(false);
    });

    it('should correctly identify held permissions', () => {
        const principal = createPrincipal([], ['invoice:read']);
        expect(hasPermission(principal, 'invoice:read')).toBe(true);
        expect(hasPermission(principal, 'invoice:write')).toBe(false);
    });
});
```

### Example: Testing satisfiesAccess Function
```typescript
describe('satisfiesAccess', () => {
    it('should grant access when principal holds required roles and permissions', () => {
        const principal = createPrincipal(['admin'], ['invoice:read']);
        const requirement = {
            roles: ['admin'],
            permissions: ['invoice:read'],
            mode: 'all',
        };

        expect(satisfiesAccess(principal, requirement)).toBe(true);
    });

    it('should deny access when required permissions are missing', () => {
        const principal = createPrincipal(['admin'], ['invoice:read']);
        const requirement = {
            roles: ['admin'],
            permissions: ['invoice:write'],
            mode: 'all',
        };

        expect(satisfiesAccess(principal, requirement)).toBe(false);
    });
});
```

---

## Integration Testing

Integration tests for `blendsdk/authz` verify how different components of the package work together. You can use actual data or mock configurations to simulate interactions.

### Example: Testing Claims Translation
```typescript
describe('Claims Translation', () => {
    it('should correctly translate provider claims to application roles', () => {
        const grantMap = {
            'role:app-admin': { roles: ['admin'] },
        };

        const translator = createClaimsTranslator(
            genericClaimsProfile,
            grantMap,
            { allowed: { roles: ['admin'] } }
        );

        const principal = translator.translate({
            userInfo: { roles: ['app-admin'] },
        });

        expect(principal).toEqual({
            roles: ['admin'],
            permissions: [],
        });
    });
});
```

---

## Mocking & Stubbing

Mocking allows you to simulate components and test how your code interacts with them. This is especially useful for functions that rely on external state or services.

### Example: Mocking onUnmapped Callback
```typescript
describe('Unmapped Claims Handling', () => {
    it('should invoke onUnmapped callback for unmapped claims', () => {
        const onUnmapped = vi.fn();
        
        const translator = createClaimsTranslator(
            genericClaimsProfile,
            {},
            { onUnmapped }
        );

        translator.translate({
            userInfo: { roles: ['unknown-role'] },
        });

        expect(onUnmapped).toHaveBeenCalledWith('role:unknown-role');
    });
});
```

## Test Patterns by Feature

### Access Evaluation Patterns
When testing access evaluation, ensure that various scenarios are covered:
- Principal has all required roles and permissions
- Principal is missing roles or permissions
- Principal holds duplicate roles or permissions

### Claims Translation Patterns
For testing claims translation:
- Validate proper mapping from provider claims to internal roles
- Ensure fallback behavior works correctly when claims are missing
- Test the `onUnmapped` callback for handling unexpected claims.

### Common Testing Snippets
```typescript
// Testing for unmapped keys
describe('Claims Translation Unmapped Keys', () => {
    it('should log unknown role when untranslated claim is encountered', () => {
        const onUnmapped = vi.fn();
        
        const translator = createClaimsTranslator(
            genericClaimsProfile,
            {},
            { onUnmapped }
        );

        translator.translate({
            userInfo: { roles: ['unknown'] },
        });

        expect(onUnmapped).toHaveBeenCalledWith('role:unknown');
    });
});
```
```typescript
// Testing boundary scenarios for roles and permissions
describe('Boundary Tests for Access Evaluation', () => {
    it('should accept empty requirements as satisfied', () => {
        const principal = createPrincipal(['user'], []);
        expect(satisfiesAccess(principal, {})).toBe(true);
    });

    it('should handle duplicated roles in the principal', () => {
        const principal = createPrincipal(['admin', 'admin'], []);
        const requirement = { roles: ['admin'] };
        expect(satisfiesAccess(principal, requirement)).toBe(true);
    });
});
```

By following these testing patterns and utilizing the provided examples, you can effectively ensure the functionality and reliability of your application using the `blendsdk/authz` package.

---

# authz Troubleshooting

---

## Common Errors

### Incorrectly formatted role or permission strings
**Error Message / Symptom**: `TypeError: Cannot read properties of undefined (reading 'some')`

**Cause**: This error typically occurs when the `roles` or `permissions` array is undefined or not properly formatted within the principal passed to authorization checks.

**Fix**: Ensure that the `roles` and `permissions` arrays are always initialized as empty arrays when no roles or permissions are present.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: [],               // Correct initialization
    permissions: [],        // Correct initialization
};

const requirement = {
    roles: ['admin'],
    permissions: ['invoice:read'],
};

console.log(satisfiesAccess(principal, requirement)); // false
```

---

### Unmapped claim warnings
**Error Message / Symptom**: `Unmapped claim detected: role:unknown-role`

**Cause**: This warning is raised when a claim in the provided identity does not have a corresponding entry in the grant map or is not recognized by the claims translator.

**Fix**: Define a mapping for all roles and permissions that can be expected from the identity provider.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from 'blendsdk/authz';

const grantMap = {
    'role:admin': { roles: ['admin'] },
};

const onUnmapped = (key: string) => {
    console.warn(`Unmapped claim detected: ${key}`);
};

const translator = createClaimsTranslator(genericClaimsProfile, grantMap, { onUnmapped });

const principal = translator.translate({ userInfo: { roles: ['unknown-role'] } });
// Check console for unmapped claim warning
```

---

### Improper requirement structure
**Error Message / Symptom**: `TypeError: Cannot read properties of undefined (reading 'mode')`

**Cause**: This occurs when the access requirement structure does not properly define properties such as `roles`, `permissions`, or `mode`.

**Fix**: Always ensure the access requirement is an object and adheres to the `AccessRequirement` interface.

```typescript
import { satisfiesAccess } from 'blendsdk/authz';

const principal = {
    roles: ['admin'],
    permissions: ['invoice:read'],
};

const requirement = {
    roles: ['admin'],
    permissions: [], // Ensure it's an array
    mode: 'any',     // Ensure mode is defined
};

console.log(satisfiesAccess(principal, requirement)); // true
```

---

### Missing key assignments in grant maps
**Error Message / Symptom**: `Access denied: Unmapped claim encountered`

**Cause**: When there are roles or permissions in the input claims that are not defined in the grant map, the translator may not assign any roles to the principal.

**Fix**: Add appropriate mappings in the grant map that correlate to the roles and permissions given by the provider.

```typescript
import { createClaimsTranslator, genericClaimsProfile } from 'blendsdk/authz';

const grantMap = {
    'role:admin': { roles: ['admin'] },
    'role:user': { roles: ['user'] },
};

const translator = createClaimsTranslator(genericClaimsProfile, grantMap, {});

const principal = translator.translate({ userInfo: { roles: ['admin', 'user'] } });
console.log(principal); // { roles: ['admin', 'user'], permissions: [] }
```

---

## Debugging Strategies

### Use console logs effectively
Insert console log statements to track the structure of your principals, access requirements, and any translations happening during your application's execution. 

### Monitor unmapped keys
Implement an `onUnmapped` callback in the claims translator to keep track of any claims that are not mapped to your application's vocabulary. This can help identify gaps in your grant mappings.

### Validate the initialization of roles and permissions
Before performing any authorizations, validate that your `principal` object contains correctly initialized arrays for both `roles` and `permissions`.

### Error catching
Wrap access evaluations with `try/catch` blocks. This way, you can gracefully handle any unexpected errors that may disrupt your flow without crashing your application.

```typescript
try {
    const accessGranted = satisfiesAccess(principal, requirement);
    if (!accessGranted) {
        throw new Error('Access denied.');
    }
} catch (error) {
    console.error(error.message);
}
```

---

## Known Pitfalls

### Forgetting to initialize properties
If `roles` or `permissions` are left undefined for a principal, it can lead to runtime errors.

### Overly permissive roles
Be cautious when mapping external roles directly to application roles. This can lead to unintentional access.

### Insufficient testing for edge cases
Always include tests for edge scenarios, such as empty roles or permissions and overlapping roles. Failing to do so might result in unexpected behavior in production.

### Failure to keep grant maps updated
As your application evolves, the grant map may need updates to reflect new roles or permissions. Regularly review and update your mappings to avoid issues with unmapped claims.

### Ignoring the TypeScript strict type-checking
Make sure to adhere to strict TypeScript settings. Avoid using types like `any` or ignoring potential `null` options, as this could undermine type safety and lead to hidden bugs.

```typescript
const principal: AccessPrincipal = {
    roles: ['admin'],
    permissions: [], // Ensure compliance with types
};
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
