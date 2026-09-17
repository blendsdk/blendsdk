> **Package**: `blendsdk/webafx-authz`

# webafx-authz Advanced Patterns

---

## Pattern 1: Integrated Role and Permissions Check with Custom Translator

### When to Use
Use this pattern when you need to enforce both role and permission checks in a consistent way across different routes, particularly when a custom claims translator is necessary to align claims with the application's data access policies.

### Complete Example
```typescript
import { WebApplication } from 'blendsdk/webafx';
import { requireAccess, createClaimsTranslatorPlugin, buildProviderIdentity } from 'blendsdk/webafx-authz';

const app = new WebApplication();

const translator = {
    translate: (identity) => ({
        roles: Array.isArray(identity.idTokenClaims.roles) ? identity.idTokenClaims.roles : [],
        permissions: Array.isArray(identity.accessTokenClaims.permissions) ? identity.accessTokenClaims.permissions : [],
    }),
};

app.use(createClaimsTranslatorPlugin(translator));

app.route()
    .get("/admin-dashboard")
    .secure()
    .authorize(requireAccess({ roles: ["admin"], permissions: ["dashboard:access"] }))
    .handle(async (req, res) => {
        res.send("Welcome to the Admin Dashboard!");
    });
```

### Explanation
This pattern demonstrates the flexibility of combining both roles and permissions checks along with a custom claims translator. Having separate roles and permissions improves clarity in security requirements. Using a claims translator allows the application to adapt to various identity provider responses without modifying core application logic.

### Caveats and Performance Considerations
- Ensure that the performance overhead of the claims translation does not impact endpoint responsiveness, especially if the translation involves complex logic.
- Avoid overly complex role and permission structures as they can create misunderstandings and lead to maintenance challenges.

---

## Pattern 2: Nested Claims Handling with Custom Principal Selector

### When to Use
Implement this pattern when working with complex identity claims that are nested or require special handling to extract roles and permissions effectively.

### Complete Example
```typescript
import { WebApplication, BaseController } from 'blendsdk/webafx';
import { requireAccess, defaultPrincipalSelector } from 'blendsdk/webafx-authz';

const app = new WebApplication();

const customSelector = (principal) => {
    const user = principal?.claims.user || {};
    return {
        roles: Array.isArray(user.roles) ? user.roles : [],
        permissions: []
    };
};

class UserController extends BaseController {
    routes() {
        return [
            this.route()
                .get("/user-profile")
                .secure()
                .authorize(requireAccess({ roles: ["user"] }, { select: customSelector }))
                .handle((req, res) => {
                    res.send("User Profile Information");
                }),
        ];
    }
}

app.registerController("", UserController);
```

### Explanation
The use of a custom principal selector in this pattern allows for flexibility when dealing with user claims that could be nested within the claims object. This adaptability becomes essential when different identity providers format their claims variably.

### Caveats and Performance Considerations
- Custom selectors should always fail gracefully for untrusted or malformed claims to prevent denial-of-service scenarios.
- Overly complex claims handling logic can introduce latency into requests, thus proper optimization and profiling should be part of the implementation process.

---

## Pattern 3: Scoped Access with Authorization Caching

### When to Use
Adopt this pattern when you need to enforce scoped access in an application and wish to enhance performance by caching authorization checks.

### Complete Example
```typescript
import { WebApplication } from 'blendsdk/webafx';
import { requireScopes, createClaimsTranslatorPlugin } from 'blendsdk/webafx-authz';
import type { AuthResult } from 'blendsdk/webafx-auth';

const app = new WebApplication();

const translator = {
    translate: (identity) => ({
        roles: [],
        permissions: [],
    }),
};

app.use(createClaimsTranslatorPlugin(translator));

// Cache for authorized scopes
const cache = new Map();

app.route()
    .get("/resource")
    .secure()
    .authorize(requireScopes(["resource:read"]))
    .handle(async (req, res) => {
        const principal = await req.services.get<AuthResult>('user', undefined);
        const key = principal?.token;

        if (!cache.has(key)) {
            // Perform authorization logic and cache the result
            const allowed = await performScopeCheck(principal);
            cache.set(key, allowed);
        }

        const allowed = cache.get(key);
        if (allowed) {
            res.send("Access to the resource granted.");
        } else {
            res.status(403).json({ error: "Access denied" });
        }
    });

// A function simulating scope-check logic
async function performScopeCheck(principal) {
    return principal.scopes.includes("resource:read");
}
```

### Explanation
This pattern demonstrates managing access to resources via scoped permissions while implementing a caching layer to enhance performance by reducing redundant checks. The caching of authorization results allows for faster responses for frequent requests, especially in high-traffic scenarios.

### Caveats and Performance Considerations
- The cache can grow large and consume memory; thus, it should include a strategy for eviction or expiration based on typical usage patterns.
- Ensure that the underlying claims and associated tokens are sufficiently secured to avoid discrepancies between the cache and actual user tokens.

---

## Pattern 4: Async Claims Resolution in Route Handlers

### When to Use
This pattern is applicable when the claims resolution requires asynchronous operations, typically when fetching additional data from external services based on the initial claims.

### Complete Example
```typescript
import { WebApplication } from 'blendsdk/webafx';
import { requireAccess, createClaimsTranslatorPlugin } from 'blendsdk/webafx-authz';
import type { AuthResult } from 'blendsdk/webafx-auth';

const app = new WebApplication();

const translator = {
    translate: (identity) => ({
        roles: identity.idTokenClaims.roles || [],
        permissions: identity.accessTokenClaims.permissions || [],
    }),
};

app.use(createClaimsTranslatorPlugin(translator));

app.route()
    .get("/async-dashboard")
    .secure()
    .authorize(requireAccess({ permissions: ["dashboard:view"] }))
    .handle(async (req, res) => {
        const principal = await req.services.get<AuthResult>('user', undefined);
        const additionalData = await fetchExtraData(principal);
        res.send({
            message: "Dashboard loaded successfully",
            data: additionalData,
        });
    });

async function fetchExtraData(principal) {
    // Simulate an async operation like a database call
    return Promise.resolve({ info: `User ID: ${principal.sub}` });
}
```

### Explanation
The pattern illustrates how to integrate asynchronous operations within route handlers after the authorization checks have taken place. This allows for assembling rich responses based on user identities while adhering to security protocols.

### Caveats and Performance Considerations
- Overusing async operations within critical paths can slow down overall request handling. Only use them when necessary.
- Ensure to handle potential failures of asynchronous calls gracefully to avoid exposing sensitive error information.

---

---

# webafx-authz Common Scenarios

---

## How do I require access based on permissions?

To enforce access control on a route based on specific permissions, use the `requireAccess` function.

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';

// Example route setup requiring specific permissions
app.route()
    .get("/invoices")
    .secure()
    .authorize(requireAccess({ permissions: ["invoice:read"] }))
    .handle((req, res) => {
        res.send("Here are your invoices.");
    });
```

---

## How do I require access based on roles?

If you need to restrict a route to certain user roles, apply the `requireAccess` function with role requirements.

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';

// Route requiring admin role
app.route()
    .get("/admin")
    .secure()
    .authorize(requireAccess({ roles: ["admin"] }))
    .handle((req, res) => {
        res.send("Welcome, Admin!");
    });
```

---

## How do I use scopes for authorization?

To enforce scope-based access control, utilize the `requireScopes` function.

```typescript
import { requireScopes } from 'blendsdk/webafx-authz';

// Route requiring specific scopes
app.route()
    .get("/reports")
    .secure()
    .authorize(requireScopes(["reports:read"]))
    .handle((req, res) => {
        res.send("Report details.");
    });
```

---

## How do I handle missing permissions gracefully?

Ensure that your code handles situations where permissions are absent in the claims safely.

```typescript
import { defaultPrincipalSelector, requireAccess } from 'blendsdk/webafx-authz';
import type { AuthResult } from 'blendsdk/webafx-auth';

app.route()
    .get("/secure-data")
    .secure()
    .authorize(requireAccess({ permissions: ["data:write"] }))
    .handle(async (req, res) => {
        const principal = await req.services.get<AuthResult>('user', undefined);
        const grants = defaultPrincipalSelector(principal);
        if (grants.permissions.length === 0) {
            return res.status(403).send("Permission denied.");
        }
        res.send("You have access to secure data.");
    });
```

---

## How do I create a claims translator plugin?

You can set up a claims translator using the `createClaimsTranslatorPlugin` to handle and transform claims effectively.

```typescript
import { createClaimsTranslatorPlugin } from 'blendsdk/webafx-authz';

// Define your translator logic
const translator = {
    translate: (identity) => ({
        roles: identity.idTokenClaims.roles || [],
        permissions: identity.accessTokenClaims.permissions || [],
    }),
};

// Add the claims translator plugin to your app
app.use(createClaimsTranslatorPlugin(translator));
```

---

## How do I deal with nested claims in user roles?

If user roles are nested within claims, you can create a custom principal selector to extract them correctly.

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';

const customPrincipalSelector = (principal) => {
    const roles = principal?.claims.user?.roles || [];
    return { roles, permissions: [] };
};

// Use the custom selector in route authorization
app.route()
    .get("/nested-roles")
    .secure()
    .authorize(requireAccess({ roles: ["admin"] }, { select: customPrincipalSelector }))
    .handle((req, res) => {
        res.send("Access granted to nested roles.");
    });
```

---

## How do I decode a JWT token safely?

Ensure that you check the structure of the JWT token before decoding it, avoiding any client-supplied tokens.

```typescript
import { decodeJwtClaims } from 'blendsdk/webafx-authz';

const token = "your-jwt-token"; // Received from a trusted source
const claims = decodeJwtClaims(token);

if (claims) {
    console.log("Decoded claims:", claims);
} else {
    console.error("Failed to decode the token.");
}
```

---

## How do I test authorization functionality?

You can write tests for authorization checks using a testing framework like Vitest to ensure that your guards work as expected.

```typescript
import { describe, it, expect } from "vitest";
import supertest from "supertest";
import { WebApplication } from 'blendsdk/webafx';
import { requireAccess } from 'blendsdk/webafx-authz';

const app = new WebApplication();

app.route()
    .get("/secure-route")
    .secure()
    .authorize(requireAccess({ roles: ["user"] }))
    .handle((req, res) => res.send("Secure data."));

describe("Authorization Tests", () => {
    it("should allow access to authorized user", async () => {
        const response = await supertest(app.express)
            .get("/secure-route")
            .set("Authorization", "Bearer valid-token-with-user-role") // Simulate valid authorization
            .expect(200);
        
        expect(response.text).toBe("Secure data.");
    });

    it("should deny access to unauthorized user", async () => {
        await supertest(app.express)
            .get("/secure-route")
            .set("Authorization", "Bearer invalid-token") // Simulate invalid authorization
            .expect(403);
    });
});
```

---

## How do I implement logging for unauthorized access attempts?

Logging failed authorization attempts can help track security issues and adjust your access policies.

```typescript
app.route()
    .get("/secure-data")
    .secure()
    .authorize(requireAccess({ roles: ["user"] }))
    .handle(async (req, res, next) => {
        try {
            await next();
        } catch (error) {
            console.error("Authorization failed:", error.message);
            res.status(403).send("Unauthorized access attempt.");
        }
    });
```

---

## How do I implement error handling for token validation?

It's essential to catch and handle errors during token validation to maintain application stability and security.

```typescript
app.use(async (req, res, next) => {
    try {
        const claims = decodeJwtClaims(req.headers["authorization"]);
        if (!claims) {
            return res.status(401).send("Invalid token.");
        }
        // Proceed with the request handling
        next();
    } catch (error) {
        console.error("Token validation error:", error);
        res.status(500).send("Internal server error.");
    }
});
```

---

---

# webafx-authz Examples Library

---

## Authorization Helpers

### Require Access Based on Permissions
Use `requireAccess` to enforce access control on routes based on specific permissions.

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication();

app.route()
    .get("/invoices")
    .secure()
    .authorize(requireAccess({ permissions: ["invoice:read"] }))
    .handle((req, res) => {
        res.send("Here are your invoices.");
    });
```

### Require Access Based on Roles
You can restrict a route to certain user roles using the `requireAccess` function.

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication();

app.route()
    .get("/admin")
    .secure()
    .authorize(requireAccess({ roles: ["admin"] }))
    .handle((req, res) => {
        res.send("Welcome, Admin!");
    });
```

### Require Access Based on Both Roles and Permissions
This example shows how to combine role and permission checks in a single route.

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication();

app.route()
    .get("/dashboard")
    .secure()
    .authorize(requireAccess({ roles: ["user"], permissions: ["dashboard:access"] }))
    .handle((req, res) => {
        res.send("Dashboard access granted.");
    });
```

---

## Claims Translator

### Creating a Claims Translator Plugin
You can set up a claims translator to handle and transform claims effectively from an identity provider.

```typescript
import { createClaimsTranslatorPlugin } from 'blendsdk/webafx-authz';
import { WebApplication } from 'blendsdk/webafx';
import type { ClaimsTranslator } from 'blendsdk/authz';

const translator: ClaimsTranslator = {
    translate: () => ({
        roles: [],
        permissions: [],
    }),
};

const app = new WebApplication();
app.use(createClaimsTranslatorPlugin(translator));
```

---

## Principal Selection

### Using Default Principal Selector
The `defaultPrincipalSelector` is used to extract roles and permissions from the user’s claims.

```typescript
import { defaultPrincipalSelector } from 'blendsdk/webafx-authz';
import type { AuthResult } from 'blendsdk/webafx-auth';

const principal: AuthResult = {
    sub: "user-1",
    claims: { roles: ["admin"], permissions: ["invoice:read"] },
    token: "your-token"
};

const grants = defaultPrincipalSelector(principal);
console.log(grants); // { roles: ["admin"], permissions: ["invoice:read"] }
```

### Customized Principal Selector
You can define a custom principal selector if your claims structure is different.

```typescript
import { requireAccess, PrincipalSelector } from 'blendsdk/webafx-authz';

const customSelector: PrincipalSelector = (principal) => ({
    roles: principal?.claims.userRoles || [],
    permissions: principal?.claims.userPermissions || []
});

const app = new WebApplication();
app.route()
    .get("/custom-access")
    .secure()
    .authorize(requireAccess({ roles: ["admin"] }, { select: customSelector }))
    .handle((req, res) => {
        res.send("Custom access granted!");
    });
```

---

## Token Decoding

### Decoding JWT Claims Safely
Always decode tokens from trusted sources to avoid security vulnerabilities.

```typescript
import { decodeJwtClaims } from 'blendsdk/webafx-authz';

const token = "your-trusted-jwt-token"; // Token received from trusted source
const claims = decodeJwtClaims(token);

if (claims) {
    console.log("Decoded claims:", claims);
} else {
    console.error("Failed to decode the token.");
}
```

---

## Error Handling

### Handling Authorization Errors in Route Handlers
Implement error handling for secure routes to manage failed authorization attempts.

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication();

app.route()
    .get("/secure-data")
    .secure()
    .authorize(requireAccess({ roles: ["user"] }))
    .handle(async (req, res) => {
        try {
            res.send("You have secure access to this data.");
        } catch (error) {
            console.error("Authorization failed:", error.message);
            res.status(403).send("Unauthorized access.");
        }
    });
```

---

## Integration with Frameworks

### Combining with WebAFX
This example shows the integration of `blendsdk/webafx-authz` with WebAFX.

```typescript
import {
    WebApplication,
    BaseController
} from 'blendsdk/webafx';
import {
    requireAccess,
    createClaimsTranslatorPlugin,
} from 'blendsdk/webafx-authz';

const app = new WebApplication();
const translator = {
    translate: (identity) => ({
        roles: identity.idTokenClaims.roles || [],
        permissions: []
    })
};

app.use(createClaimsTranslatorPlugin(translator));

app.route()
    .get("/protected-resource")
    .secure()
    .authorize(requireAccess({ roles: ["admin"] }))
    .handle((req, res) => {
        res.send("You have access to the protected resource.");
    });
```

---

## Testing Patterns

### Testing Access Guards with Valid Tokens
Use integration tests to ensure that access guards operate correctly.

```typescript
import { describe, it, expect } from "vitest";
import supertest from "supertest";
import { WebApplication } from 'blendsdk/webafx';
import { requireAccess } from 'blendsdk/webafx-authz';

const app = new WebApplication();
app.route()
    .get("/secure-endpoint")
    .secure()
    .authorize(requireAccess({ roles: ["user"] }))
    .handle((req, res) => {
        res.send("Secure content accessed!");
    });

describe("Access Control Tests", () => {
    it("should allow access for authorized user", async () => {
        const response = await supertest(app.express)
            .get("/secure-endpoint")
            .set("Authorization", "Bearer valid-user-token")
            .expect(200);
        expect(response.text).toBe("Secure content accessed!");
    });

    it("should deny access for unauthorized user", async () => {
        await supertest(app.express)
            .get("/secure-endpoint")
            .set("Authorization", "Bearer invalid-user-token")
            .expect(403);
    });
});
```

---

## Common Scenarios

### Requiring Multiple Permissions
Implement a route that checks for multiple permissions.

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication();

app.route()
    .get("/multiple-permissions")
    .secure()
    .authorize(requireAccess({ permissions: ["read:invoice", "update:invoice"] }))
    .handle((req, res) => {
        res.send("Access granted to multiple permissions!");
    });
```

### Nested Claims Handling
Account for situations where user roles are nested within claims.

```typescript
import { defaultPrincipalSelector, requireAccess } from 'blendsdk/webafx-authz';

const customSelector = (principal) => {
    return {
        roles: principal?.claims.user?.roles || [],
        permissions: []
    };
};

const app = new WebApplication();

app.route()
    .get("/nested-roles")
    .secure()
    .authorize(requireAccess({ roles: ["admin"] }, { select: customSelector }))
    .handle((req, res) => {
        res.send("Access granted to nested roles.");
    });
```

---

## Error Logging
Often helpful to log detailed messages for any authorization-related errors.

```typescript
app.route()
    .get("/error-logging")
    .secure()
    .authorize(requireAccess({ roles: ["admin"] }))
    .handle((req, res) => {
        try {
            res.send("Logging information here.");
        } catch (err) {
            console.error("An error occurred during access control:", err);
            res.status(500).send("Internal server error.");
        }
    });
```

---

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
