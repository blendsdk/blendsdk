> **Package**: `blendsdk/webafx-authz`

# webafx-authz Core Concepts

---

## Authorization Helpers

### What It Is
Authorization helpers in the `blendsdk/webafx-authz` package provide functions that facilitate role- and permission-based access control within WebAFX applications. They allow developers to enforce security requirements directly in their routing logic.

### How It Works
The package includes helpers like `requireAccess` and `requireScopes`, which take authorization requirements (such as specific roles or permissions) and transform them into `AuthorizeFunction` shapes expected by WebAFX's routing system. The helpers evaluate the grants available to the user (or principal) upon making a request and determine if those grants satisfy the specified requirements.

### Complete Example
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

### Key Methods/Properties Table

| Name              | Type/Signature                                       | Description                                                  |
|-------------------|-----------------------------------------------------|--------------------------------------------------------------|
| `requireAccess`   | `(requirement: AccessRequirement, options?: RequireAccessOptions) => AuthorizeFunction` | Builds an authorization callback for access requirements.     |
| `requireScopes`   | `(scopes: readonly string[]) => AuthorizeFunction` | Builds an authorization callback that checks for requested scopes. |

---

## Claims Translator

### What It Is
The Claims Translator functionality allows for the registration of a claims translation mechanism that processes and transforms claims from external identity providers into a consistent format understood by the application.

### How It Works
Developers can create a claims translator plugin using the `createClaimsTranslatorPlugin` function. This registers a translator service within the application's dependency injection system. The plugin can be resolved during request handling to translate claims whenever authentication occurs.

### Complete Example
```typescript
import { createClaimsTranslatorPlugin } from 'blendsdk/webafx-authz';
import type { ClaimsTranslator } from 'blendsdk/authz';
import { WebApplication } from 'blendsdk/webafx';

// Example translator implementation
const translator: ClaimsTranslator = {
    translate: () => ({
        roles: ["admin"],
        permissions: ["invoice:read"],
    }),
};

const app = new WebApplication();
app.use(createClaimsTranslatorPlugin(translator));
```

### Key Methods/Properties Table

| Name                           | Type/Signature                                         | Description                                                  |
|--------------------------------|-------------------------------------------------------|--------------------------------------------------------------|
| `createClaimsTranslatorPlugin` | `(translator: ClaimsTranslator, options?: ClaimsTranslatorPluginOptions) => PluginDefinition` | Creates a claims translator plugin for registering a translator in the application. |

---

## Principal Selector

### What It Is
The Principal Selector is a mechanism that determines how to extract access roles and permissions from an authenticated user (principal) based on the claims available in the request context.

### How It Works
By default, the `defaultPrincipalSelector` reads roles and permissions from specific claims, but developers can provide their own selection strategy through a custom selector. This flexibility allows for different claim structures, such as nested claims, facilitating diverse authentication mechanisms.

### Complete Example
```typescript
import { defaultPrincipalSelector } from 'blendsdk/webafx-authz';
import type { AuthResult } from 'blendsdk/webafx-auth';

// Example principal object received after authentication
const principal: AuthResult = {
    sub: "user-1",
    claims: { roles: ["admin"], permissions: ["invoice:read"] },
    token: "your-token",
};

const grants = defaultPrincipalSelector(principal);
console.log(grants); // { roles: ["admin"], permissions: ["invoice:read"] }
```

### Key Methods/Properties Table

| Name                      | Type/Signature                                               | Description                                                  |
|---------------------------|-------------------------------------------------------------|--------------------------------------------------------------|
| `defaultPrincipalSelector` | `(principal: AuthResult | undefined) => AccessPrincipal` | Extracts roles and permissions from the claims of the principal. |

---

## Identity Assembly

### What It Is
Identity assembly refers to the process of constructing a user identity by decoding tokens received from an external identity provider and extracting relevant claims necessary for authorization checks.

### How It Works
The package provides functions like `decodeJwtClaims` and `buildProviderIdentity` that decode JWT tokens and organize claims into a structured identity object. This identity can then be used for authorization purposes, determining what roles and permissions the user possesses.

### Complete Example
```typescript
import {
    buildProviderIdentity,
    decodeJwtClaims,
} from 'blendsdk/webafx-authz';

// Example tokens received from an identity provider
const tokens = {
    idToken: "your-id-token",
    accessToken: "your-access-token",
};

const userInfo = { email: "user@example.com" };
const identity = buildProviderIdentity(tokens, userInfo);
console.log(identity);
```

### Key Methods/Properties Table

| Name                         | Type/Signature                                                    | Description                                                  |
|------------------------------|------------------------------------------------------------------|--------------------------------------------------------------|
| `decodeJwtClaims`            | `(token: string | undefined) => Record<string, unknown> | undefined` | Decodes claims from a JWT token.                            |
| `buildProviderIdentity`      | `(tokens: { accessToken?: string; idToken?: string; scope?: string }, userInfo: Record<string, unknown>) => ProviderIdentity` | Builds a structured identity object from tokens and user info. |

---

## Access Guards

### What It Is
Access Guards are functions that enforce authorization requirements on routes by ensuring that incoming requests adhere to specified security constraints, such as roles and permissions.

### How It Works
Access guards like `requireAccess` and `requireScopes` are applied to routes, allowing developers to define precise access controls by specifying necessary roles or scopes in a declarative manner. The guards abstract away manual checks, promoting cleaner routing code.

### Complete Example
```typescript
import { requireAccess } from 'blendsdk/webafx-authz';
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication();

app.route()
    .get("/secure-endpoint")
    .secure()
    .authorize(requireAccess({ roles: ["admin"], permissions: ["data:read"] }))
    .handle((req, res) => {
        res.send("Secure Data Accessed");
    });
```

### Key Methods/Properties Table

| Name               | Type/Signature                                       | Description                                                  |
|--------------------|-----------------------------------------------------|--------------------------------------------------------------|
| `requireAccess`    | `(requirement: AccessRequirement, options?: RequireAccessOptions) => AuthorizeFunction` | Builds an authorization callback for access requirements.     |
| `requireScopes`    | `(scopes: readonly string[]) => AuthorizeFunction` | Constructs an authorization callback that checks for requested scopes. |

---

# webafx-authz Basic Usage

---

## Installation

To get started with the `blendsdk/webafx-authz` package, you can install it via npm:

```bash
npm install blendsdk/webafx-authz
```

Alternatively, if you are using Yarn:

```bash
yarn add blendsdk/webafx-authz
```

---

## Quick Start

Here’s a minimal setup to get you started with route authorization using `blendsdk/webafx-authz`:

```typescript
import { requireAccess, createClaimsTranslatorPlugin } from 'blendsdk/webafx-authz';
import { WebApplication } from 'blendsdk/webafx';
import type { ClaimsTranslator } from 'blendsdk/authz';

const app = new WebApplication();
// Your claims translator implementation here
const translator: ClaimsTranslator = {
    translate: () => ({ roles: [], permissions: [] }),
};

app.use(createClaimsTranslatorPlugin(translator));

app.route()
    .get("/secured-route")
    .secure()
    .authorize(requireAccess({ permissions: ["example:read"] }))
    .handle((req, res) => {
        res.send("You have accessed a secured route!");
    });
```

---

## Fundamentals

### Authorization Helpers

The `requireAccess` function is a key authorization helper that checks if the authenticated user has the required permissions.

#### Example: Basic Access Requirement

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';
import { WebApplication } from 'blendsdk/webafx';

const app = new WebApplication();

app.route()
    .get("/data")
    .secure()
    .authorize(requireAccess({ permissions: ["data:read"] }))
    .handle((req, res) => {
        res.send("Here is your data!");
    });
```

#### Example: Combined Roles and Permissions

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';

app.route()
    .get("/admin")
    .secure()
    .authorize(requireAccess({ roles: ["admin"], permissions: ["data:write"] }))
    .handle((req, res) => {
        res.send("Welcome, administrator!");
    });
```

---

### Claims Translator

The `createClaimsTranslatorPlugin` function allows you to create a plugin that registers a claims translator, essential for interpreting user claims from external identity providers.

#### Example: Registering a Claims Translator

```typescript
import { createClaimsTranslatorPlugin } from 'blendsdk/webafx-authz';

const translator = {
    // Your translator logic here
    translate: (identity) => ({
        roles: identity.idTokenClaims.roles || [],
        permissions: identity.accessTokenClaims.permissions || []
    })
};

app.use(createClaimsTranslatorPlugin(translator));
```

---

### Principal Selector

The principal selector determines how to extract role and permission values from the user's claims. By default, it uses the `defaultPrincipalSelector`, which is sufficient for most cases.

#### Example: Custom Principal Selector

```typescript
import { defaultPrincipalSelector } from 'blendsdk/webafx-authz';

const customSelector = (principal) => {
    return {
        roles: principal?.claims.roles || [],
        permissions: principal?.claims.permissions || []
    };
};

app.route()
    .get("/custom")
    .secure()
    .authorize(requireAccess({ roles: ["user"] }, { select: customSelector }))
    .handle((req, res) => {
        res.send("Access granted using custom selector!");
    });
```

---

## Configuration

### Common Configuration Options

| Name              | Type                                 | Default                            | Description                                                       |
|-------------------|--------------------------------------|-----------------------------------|-------------------------------------------------------------------|
| `serviceName`     | `string`                             | `claims-translator`               | The service name to register the translator under.                |
| `select`          | `PrincipalSelector`                  | `defaultPrincipalSelector`        | Function to select grants from the principal.                     |

---

## Error Handling

When using the `blendsdk/webafx-authz` package, proper error handling mechanisms are essential to manage authorization failures.

### Example: Handling Authorization Errors

```typescript
import { requireAccess } from 'blendsdk/webafx-authz';

app.route()
    .get("/secure-data")
    .secure()
    .authorize(requireAccess({ permissions: ["data:read"] }))
    .handle(async (req, res) => {
        try {
            // Handle secure data access
            res.send("You can access secure data!");
        } catch (error) {
            res.status(403).send("Authorization failed: " + error.message);
        }
    });
```

### Error Types

A denied route is answered by WebAFX: an authorization failure raises `ForbiddenError` (HTTP 403). The package itself does not define error classes. `decodeJwtClaims` never throws; it returns `undefined` for an opaque or malformed token.

---

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
