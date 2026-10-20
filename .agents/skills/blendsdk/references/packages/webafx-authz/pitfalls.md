> **Package**: `blendsdk/webafx-authz`

# webafx-authz Best Practices

---

## Do / Don't Pairs

### Do: Always Decode Tokens from Trusted Channels
```typescript fragment
// ❌ Wrong
const claims = decodeJwtClaims(clientSuppliedToken); // Decoding untrusted client-supplied token

// ✅ Correct
const claims = decodeJwtClaims(providerToken); // Only decode tokens received from trusted identity provider
```
**Why**: Decoding tokens from untrusted sources can lead to security vulnerabilities like token forgery. Always ensure tokens are obtained directly from the identity provider.

---

### Do: Use Async/Await for Asynchronous Code
```typescript fragment
// ❌ Wrong
const dataPromise = fetchData(); // Fetching data with raw Promises
dataPromise.then(data => { 
    // process data
});

// ✅ Correct
const data = await fetchData(); // Using async/await for clearer asynchronous code
```
**Why**: Async/await provides a cleaner syntax and helps with better error handling compared to raw Promises, making the code more readable and maintainable.

---

### Don't: Ignore Role and Permission Checks
```typescript fragment
// ❌ Wrong
app.route()
    .get("/admin")
    .secure()
    .handle(() => {
        // No authorization checks
    });

// ✅ Correct
app.route()
    .get("/admin")
    .secure()
    .authorize(requireAccess({ roles: ["admin"] }))
    .handle(() => {
        // Authorization checks implemented
    });
```
**Why**: Ignoring authorization checks can expose sensitive routes to unauthorized access, compromising the integrity of your application.

---

### Don't: Use Placeholder Comments in Code
```typescript fragment
// ❌ Wrong
app.route()
    .get("/endpoint")
    .secure()
    .handle(() => {
        // ... your code here
    });

// ✅ Correct
app.route()
    .get("/endpoint")
    .secure()
    .handle((req, res) => {
        res.send("Handled request correctly."); // Complete implementation
    });
```
**Why**: Placeholder comments indicate incomplete implementations, which can lead to confusion and potential security flaws during deployment.

---

## Anti-Patterns

### 1. Decoding User-Supplied Tokens
Developers sometimes decode tokens received from the client instead of the trusted identity provider.
```typescript
// Decoding a user-supplied token
const claims = decodeJwtClaims(clientToken); // Often leads to vulnerabilities
```
**Solution**: Always decode tokens received directly from the identity provider over a secure channel.

### 2. Hardcoding Permissions in Route Definitions
Using hardcoded strings for permissions can lead to maintenance challenges as they may need to be updated in multiple places.
```typescript
// Hardcoded permission
authorize(requireAccess({ permissions: ["invoice:read"] }));
```
**Solution**: Define permissions/constants in a centralized configuration to ensure consistency and ease of changes.

### 3. Failing to Handle Missing Claims Gracefully
Some applications might crash if claimed attributes are missing or of unexpected types.
```typescript
const roles = principal?.claims.roles; // Unsafe access
```
**Solution**: Use a safe access pattern, checking for the presence and type of claims.

---

## Performance Tips

### 1. Caching Authorization Results
To improve the performance of route authorization, consider caching the results of expensive authorization checks based on user roles and permissions.
```typescript
const cache = new Map();

// Caching result
const key = principal.token;
if (!cache.has(key)) {
    const result = await checkAccess(principal);
    cache.set(key, result);
}
```
**Reasoning**: This can significantly reduce the overhead for frequently accessed routes once a user’s permissions have been verified.

### 2. Regularly Review Claims Translation Logic
Claims translation should be optimized for performance. Ensure that the logic used to transform claims is as efficient as possible.
```typescript
const translatedClaims = translateClaims(claims); // Ensure this is efficient
```
**Reasoning**: Complex transformations can become a bottleneck if accessed frequently during request processing.

---

## Security Considerations

### 1. Validate Incoming Tokens
Always validate the structure of tokens before processing them to ensure they are well-formed and have not been tampered with.
```typescript
if (!isValidToken(token)) {
    throw new Error("Invalid token received.");
}
```

### 2. Rate Limiting
Implement rate limiting on secured routes to reduce the risk of brute-force attacks on the authorization endpoints.
```typescript
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // Limit each IP to 100 requests per windowMs
}));
```

### 3. Avoid Exposing Sensitive Information in Errors
When authorization fails, be cautious not to reveal information that can help an attacker.
```typescript
// ❌ Wrong
res.status(403).send("Access denied: you lack the necessary permissions.");

// ✅ Correct
res.status(403).json({ error: "Access denied." });
```

---

---

# webafx-authz Testing Patterns

---

## Test Setup

To begin testing with the `blendsdk/webafx-authz` package, ensure you have the following imports and configurations in place.

```typescript
import { describe, it, expect, afterEach } from "vitest";
import supertest from "supertest";
import { WebApplication, BaseController } from "blendsdk/webafx";
import { createAuthPlugin, MemoryAuthProvider } from "blendsdk/webafx-auth";
import type { AuthResult } from "blendsdk/webafx-auth";
import { requireAccess, requireScopes, createClaimsTranslatorPlugin } from "blendsdk/webafx-authz";
```

### Test Helpers

You may want to include some test helpers that streamline common test setups.

```typescript
/** Create a web application with a memory auth provider. */
function createTestApp(validTokens: Record<string, AuthResult>): WebApplication {
    const app = new WebApplication({ PORT: 0, ENV_MODE: "test", LOG_LEVEL: "ERROR" });
    app.use(createAuthPlugin(new MemoryAuthProvider({ validTokens })));
    return app;
}
```

---

## Unit Testing

### Testing Access Control with Require Access

Unit tests can be employed to verify that the `requireAccess` guard functions correctly:

```typescript
describe("Access Guard Unit Tests", () => {
    const validTokens = {
        "valid-token": { sub: "user-1", claims: { roles: ["admin"] }, token: "valid-token" },
    };

    it("should allow access for a valid user role", async () => {
        const app = createTestApp(validTokens);
        app.route()
            .get("/protected")
            .secure()
            .authorize(requireAccess({ roles: ["admin"] }))
            .handle((req, res) => res.send("Access granted"));

        const response = await supertest(app.express)
            .get("/protected")
            .set("Authorization", `Bearer valid-token`)
            .expect(200);

        expect(response.text).toBe("Access granted");
    });
    
    it("should deny access for an invalid user role", async () => {
        const app = createTestApp(validTokens);
        app.route()
            .get("/protected")
            .secure()
            .authorize(requireAccess({ roles: ["user"] }))
            .handle((req, res) => res.send("Access granted"));

        await supertest(app.express)
            .get("/protected")
            .set("Authorization", `Bearer valid-token`)
            .expect(403);
    });
});
```

---

## Integration Testing

### Testing with Real Instances

Integration tests verify the interaction between the application components and the actual behavior in a more realistic environment:

```typescript
describe("Integration Tests with Claims Translation", () => {
    const validTokens = {
        "valid-token": { sub: "user-1", claims: { roles: ["admin"] }, token: "valid-token" },
    };

    const translator = {
        translate: (identity) => ({
            roles: identity.idTokenClaims.roles || [],
            permissions: identity.accessTokenClaims.permissions || [],
        }),
    };

    it("should integrate claims translator and allow access", async () => {
        const app = createTestApp(validTokens);
        app.use(createClaimsTranslatorPlugin(translator));
        app.route()
            .get("/admin")
            .secure()
            .authorize(requireAccess({ roles: ["admin"] }))
            .handle((req, res) => res.send("Welcome Admin!"));

        const response = await supertest(app.express)
            .get("/admin")
            .set("Authorization", `Bearer valid-token`)
            .expect(200);

        expect(response.text).toBe("Welcome Admin!");
    });
});
```

---

## Mocking & Stubbing

To effectively test components relying on `blendsdk/webafx-authz`, you may want to mock or stub specific behaviors or responses.

### Example: Mocking Response from Claims Translator

```typescript
import { vi } from 'vitest';

vi.mock('blendsdk/webafx-authz', async () => ({
    ...(await vi.importActual('blendsdk/webafx-authz')),
    createClaimsTranslatorPlugin: vi.fn().mockReturnValue({
        translate: () => ({
            roles: ["admin"],
            permissions: []
        })
    }),
}));
```

---

## Test Patterns by Feature

### 1. Access Guards

#### Testing Require Access

```typescript
describe("Require Access Guard Tests", () => {
    const validTokens = {
        "valid-token": { sub: "user-1", claims: { roles: ["admin"] }, token: "valid-token" },
        "invalid-token": { sub: "user-2", claims: { roles: [] }, token: "invalid-token" },
    };

    it("should allow access based on roles", async () => {
        const app = createTestApp(validTokens);
        app.route()
            .get("/restricted")
            .secure()
            .authorize(requireAccess({ roles: ["admin"] }))
            .handle((req, res) => res.send("Access granted"));

        const response = await supertest(app.express)
            .get("/restricted")
            .set("Authorization", `Bearer valid-token`)
            .expect(200);

        expect(response.text).toBe("Access granted");
    });

    it("should deny access when no valid roles are present", async () => {
        const app = createTestApp(validTokens);
        app.route()
            .get("/restricted")
            .secure()
            .authorize(requireAccess({ roles: ["admin"] }))
            .handle((req, res) => res.send("Access granted"));

        await supertest(app.express)
            .get("/restricted")
            .set("Authorization", `Bearer invalid-token`)
            .expect(403);
    });
});
```

### 2. Scope Guards

#### Testing Require Scopes

```typescript
describe("Require Scopes Guard Tests", () => {
    const validTokens = {
        "valid-token": { sub: "user-1", scopes: ["scope:read"], claims: {}, token: "valid-token" },
    };

    it("should allow access based on scopes", async () => {
        const app = createTestApp(validTokens);
        app.route()
            .get("/scoped-resource")
            .secure()
            .authorize(requireScopes(["scope:read"]))
            .handle((req, res) => res.send("Scoped access granted"));

        const response = await supertest(app.express)
            .get("/scoped-resource")
            .set("Authorization", `Bearer valid-token`)
            .expect(200);

        expect(response.text).toBe("Scoped access granted");
    });

    it("should deny access when the required scope is not held", async () => {
        const app = createTestApp(validTokens);
        app.route()
            .get("/scoped-resource")
            .secure()
            .authorize(requireScopes(["scope:write"]))
            .handle((req, res) => res.send("Scoped access granted"));

        await supertest(app.express)
            .get("/scoped-resource")
            .set("Authorization", `Bearer valid-token`)
            .expect(403);
    });
});
```

### 3. Testing Claims Translator

You can also write tests focused on how claims translators behave within your application:

```typescript
describe("Claims Translator Tests", () => {
    it("should translate claims correctly", async () => {
        const app = new WebApplication();
        const translator = {
            translate: (identity) => {
                return {
                    roles: identity.idTokenClaims.roles || [],
                    permissions: identity.accessTokenClaims.permissions || [],
                };
            }
        };

        app.use(createClaimsTranslatorPlugin(translator));
        const result = translator.translate({ idTokenClaims: { roles: ["admin"] }, accessTokenClaims: {} });
        
        expect(result.roles).toEqual(["admin"]);
    });
});
```

---

## Summary

This document outlines robust testing strategies for the `blendsdk/webafx-authz` package, covering unit tests, integration tests, and various feature test patterns. By utilizing these patterns, you can ensure that your authorization logic is reliable, flexible, and well-validated. Tailor these examples to fit your application's specific needs and integrate testing seamlessly into your development workflow for more secure and maintainable code.

---

# webafx-authz Troubleshooting

---

## Common Errors

### Invalid Token Error

1. **Error Message / Symptom**: `Error: Invalid token received.`
2. **Cause**: This error occurs when the token is either malformed or not formatted correctly as a JWT.
3. **Fix**:
   Ensure that the token is correctly structured and obtained from a trusted identity provider.

   ```typescript
   import { decodeJwtClaims } from 'blendsdk/webafx-authz';

   const token = "your-valid-jwt-token"; // Replace with your token
   const claims = decodeJwtClaims(token);

   if (!claims) {
       throw new Error("Invalid token received.");
   }
   ```

---

### Unauthorized Access

1. **Error Message / Symptom**: `403 Forbidden`
2. **Cause**: This occurs when a user attempts to access a resource for which they do not have the required roles or permissions.
3. **Fix**:
   Verify that the user's roles and permissions match the requirements set for the route.

   ```typescript
   import { requireAccess } from 'blendsdk/webafx-authz';

   app.route()
       .get("/admin")
       .secure()
       .authorize(requireAccess({ roles: ["admin"] }))
       .handle((req, res) => {
           // Handle admin access logic
           res.send("Welcome Admin!");
       });
   ```

---

### Missing Claims

1. **Error Message / Symptom**: `Error: Claims not found on the principal.`
2. **Cause**: The claims structure returned by the identity provider may not match the expected shape, resulting in missing claims during authorization.
3. **Fix**:
   Check the implementation of your claims translator and ensure it aligns with the response structure of the identity provider.

   ```typescript
   import { createClaimsTranslatorPlugin } from 'blendsdk/webafx-authz';

   const translator = {
       translate: (identity) => ({
           roles: identity.idTokenClaims?.roles || [],
           permissions: identity.accessTokenClaims?.permissions || [],
       }),
   };

   app.use(createClaimsTranslatorPlugin(translator));
   ```

---

### Async Processing Error

1. **Error Message / Symptom**: `Error: Asynchronous operation failed.`
2. **Cause**: This occurs when there is an unhandled error in asynchronous code, often within route handlers that perform async operations.
3. **Fix**:
   Use try/catch blocks in async route handlers to catch and handle potential errors gracefully.

   ```typescript
   app.route()
       .get("/data")
       .secure()
       .authorize(requireAccess({ roles: ["user"] }))
       .handle(async (req, res) => {
           try {
               const data = await fetchData();
               res.send(data);
           } catch (error) {
               console.error("Async operation failed:", error);
               res.status(500).send("Internal server error.");
           }
       });
   ```

---

## Debugging Strategies

1. **Logging**:
   - Add logging throughout your authorization logic to trace the flow and identify where issues occur. Use `console.log` or a dedicated logging library to capture necessary information.

   ```typescript
   import type { AuthResult } from 'blendsdk/webafx-auth';

   const logger = console; // or use a logging library

   app.route()
       .get("/secure-resource")
       .secure()
       .authorize(requireAccess({ roles: ["user"] }))
       .handle(async (req, res) => {
           const principal = await req.services.get<AuthResult>('user', undefined);
           logger.log("User access attempt:", Boolean(principal));
           res.send("Access granted.");
       });
   ```

2. **Error Stack Traces**:
   - Make use of error stack traces to gain insight into where the error originated within your code.

3. **Unit Tests**:
   - Implement unit tests for your route handlers and guards to ensure they behave as expected under various conditions, including error scenarios.

---

## Known Pitfalls

1. **Not Handling Authentication Errors**:
   - Make sure to handle authentication errors properly so that they do not crash your application.

2. **Improperly Configured Claims Translators**:
   - Ensure that your claims translator handles the identity structure as expected. Failure to do so can lead to undefined behaviors or access denials.

3. **Ignoring Async Errors**:
   - Omitting error handling in async functions can lead to silent failures. Always wrap your async logic in try/catch statements.

4. **Assuming Claim Availability**:
   - Claims may not always be present. Always validate claims existence before accessing them.

5. **Overly Broad Permissions**:
   - Be cautious about using overly broad permissions, which can compromise your application's security. Prefer defined roles with specific permissions.

---

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
