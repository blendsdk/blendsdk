> **Package**: `blendsdk/webafx-authz`

# webafx-authz API Reference

---

## Functions

### requireAccess

The `requireAccess` function builds an access control mechanism based on roles and permissions.

#### Methods

| Method              | Signature                                                                                          | Returns              | Description                                                           |
|---------------------|---------------------------------------------------------------------------------------------------|----------------------|-----------------------------------------------------------------------|
| `requireAccess`     | `(requirement: AccessRequirement, options?: RequireAccessOptions) => AuthorizeFunction`         | AuthorizeFunction    | Builds an authorization callback that checks a requirement against the request's principal. |

#### Example

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';

// Usage example
app.route()
    .get("/protected-resource")
    .secure()
    .authorize(requireAccess({ roles: ["admin"], permissions: ["resource:read"] }))
    .handle((req, res) => {
        res.send("Access granted: Protected Resource.");
    });
```

---

### requireScopes

The `requireScopes` function enforces scope-based access control for routes.

#### Methods

| Method        | Signature                                  | Returns            | Description                                                                    |
|---------------|--------------------------------------------|--------------------|--------------------------------------------------------------------------------|
| `requireScopes` | `(scopes: readonly string[]) => AuthorizeFunction` | AuthorizeFunction  | Builds an authorization callback that requires every listed scope.            |

#### Example

```typescript
import { requireScopes } from 'blendsdk/webafx-authz';

// Usage example
app.route()
    .get("/scoped-resource")
    .secure()
    .authorize(requireScopes(["scope:read"]))
    .handle((req, res) => {
        res.send("Access granted: Scoped Resource.");
    });
```

---

### decodeJwtClaims

This function decodes the claims of a JWT without verifying it.

#### Parameters

| Parameter | Type                      | Required | Default | Description                                                  |
|-----------|---------------------------|----------|---------|--------------------------------------------------------------|
| `token`   | `string | undefined`     | ✓        |         | The encoded token, if one is available                       |

#### Returns

- `Record<string, unknown> | undefined`: The decoded claims, or `undefined` when the token cannot be decoded.

#### Example

```typescript
import { decodeJwtClaims } from 'blendsdk/webafx-authz';

const claims = decodeJwtClaims("your-jwt-token");
console.log(claims); // Logs decoded claims or `undefined`
```

---

### buildProviderIdentity

This function collects the claims and scopes an application needs.

#### Parameters

| Parameter  | Type                                                        | Required | Default | Description                                                  |
|------------|-------------------------------------------------------------|----------|---------|--------------------------------------------------------------|
| `tokens`   | `{ accessToken?: string; idToken?: string; scope?: string }` | ✓        |         | The tokens returned by the provider's token endpoint          |
| `userInfo` | `Record<string, unknown>`                                   | ✓        |         | The user info returned by the provider                        |

#### Returns

- `ProviderIdentity`: The provider identity constructed from the tokens and user info.

#### Example

```typescript
import { buildProviderIdentity } from 'blendsdk/webafx-authz';

const identity = buildProviderIdentity({ accessToken: "token", idToken: "id-token" }, { userId: "user-1" });
console.log(identity); // Logs constructed provider identity
```

---

## Types & Interfaces

### RequireAccessOptions

Options used in the `requireAccess` function to specify custom selectors.

#### Properties

| Property | Type                        | Description                                                  |
|----------|-----------------------------|--------------------------------------------------------------|
| `select` | `PrincipalSelector`         | Resolves grants from the request's principal. Default is `defaultPrincipalSelector`. |

### ClaimsTranslatorPluginOptions

Options for the claims translator plugin.

#### Properties

| Property     | Type        | Description                                                         |
|--------------|-------------|---------------------------------------------------------------------|
| `serviceName`| `string`    | The service name to register the translator under (Defaults to `claims-translator`) |

### PrincipalSelector

A function type that resolves the canonical grants from the resolved principal.

```typescript fragment
type PrincipalSelector = (principal: AuthResult | undefined) => AccessPrincipal;
```

---

## Constants

### CLAIMS_TRANSLATOR_SERVICE

The default service name for registering the claims translator.

| Value                      | Description                         |
|----------------------------|-------------------------------------|
| `claims-translator`        | The service name registered for the claims translator plugin. |

---

## Error Handling

When utilizing the `blendsdk/webafx-authz` package, ensure to implement error handling practices as shown here:

```typescript
try {
    const identity = buildProviderIdentity(tokens, userInfo);
    // proceed with authorization logic
} catch (error) {
    console.error("Failed to build provider identity:", error);
}
```

### Best Practices
- Validate tokens before decoding.
- Handle missing claims gracefully.
- Use strict typing to prevent errors at compile time.

---

## Conclusion

This API Reference serves as a comprehensive guide for developers to utilize the `blendsdk/webafx-authz` functions, classes, and interfaces effectively within their TypeScript applications.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
