# BlendSDK Skill References

Generated routing map for the BlendSDK agent skill. Each package exposes five focused references.

| Package | Overview | Usage | API | Recipes | Pitfalls |
|---------|----------|-------|-----|---------|----------|
| api-client | [overview](packages/api-client/overview.md) | [usage](packages/api-client/usage.md) | [api](packages/api-client/api.md) | [recipes](packages/api-client/recipes.md) | [pitfalls](packages/api-client/pitfalls.md) |
| authz | [overview](packages/authz/overview.md) | [usage](packages/authz/usage.md) | [api](packages/authz/api.md) | [recipes](packages/authz/recipes.md) | [pitfalls](packages/authz/pitfalls.md) |
| blendscript | [overview](packages/blendscript/overview.md) | [usage](packages/blendscript/usage.md) | [api](packages/blendscript/api.md) | [recipes](packages/blendscript/recipes.md) | [pitfalls](packages/blendscript/pitfalls.md) |
| cmdline | [overview](packages/cmdline/overview.md) | [usage](packages/cmdline/usage.md) | [api](packages/cmdline/api.md) | [recipes](packages/cmdline/recipes.md) | [pitfalls](packages/cmdline/pitfalls.md) |
| codegen | [overview](packages/codegen/overview.md) | [usage](packages/codegen/usage.md) | [api](packages/codegen/api.md) | [recipes](packages/codegen/recipes.md) | [pitfalls](packages/codegen/pitfalls.md) |
| dbcore | [overview](packages/dbcore/overview.md) | [usage](packages/dbcore/usage.md) | [api](packages/dbcore/api.md) | [recipes](packages/dbcore/recipes.md) | [pitfalls](packages/dbcore/pitfalls.md) |
| expression | [overview](packages/expression/overview.md) | [usage](packages/expression/usage.md) | [api](packages/expression/api.md) | [recipes](packages/expression/recipes.md) | [pitfalls](packages/expression/pitfalls.md) |
| i18n | [overview](packages/i18n/overview.md) | [usage](packages/i18n/usage.md) | [api](packages/i18n/api.md) | [recipes](packages/i18n/recipes.md) | [pitfalls](packages/i18n/pitfalls.md) |
| postgresql | [overview](packages/postgresql/overview.md) | [usage](packages/postgresql/usage.md) | [api](packages/postgresql/api.md) | [recipes](packages/postgresql/recipes.md) | [pitfalls](packages/postgresql/pitfalls.md) |
| react | [overview](packages/react/overview.md) | [usage](packages/react/usage.md) | [api](packages/react/api.md) | [recipes](packages/react/recipes.md) | [pitfalls](packages/react/pitfalls.md) |
| stdlib | [overview](packages/stdlib/overview.md) | [usage](packages/stdlib/usage.md) | [api](packages/stdlib/api.md) | [recipes](packages/stdlib/recipes.md) | [pitfalls](packages/stdlib/pitfalls.md) |
| webafx | [overview](packages/webafx/overview.md) | [usage](packages/webafx/usage.md) | [api](packages/webafx/api.md) | [recipes](packages/webafx/recipes.md) | [pitfalls](packages/webafx/pitfalls.md) |
| webafx-auth | [overview](packages/webafx-auth/overview.md) | [usage](packages/webafx-auth/usage.md) | [api](packages/webafx-auth/api.md) | [recipes](packages/webafx-auth/recipes.md) | [pitfalls](packages/webafx-auth/pitfalls.md) |
| webafx-authz | [overview](packages/webafx-authz/overview.md) | [usage](packages/webafx-authz/usage.md) | [api](packages/webafx-authz/api.md) | [recipes](packages/webafx-authz/recipes.md) | [pitfalls](packages/webafx-authz/pitfalls.md) |
| webafx-cache | [overview](packages/webafx-cache/overview.md) | [usage](packages/webafx-cache/usage.md) | [api](packages/webafx-cache/api.md) | [recipes](packages/webafx-cache/recipes.md) | [pitfalls](packages/webafx-cache/pitfalls.md) |
| webafx-i18n | [overview](packages/webafx-i18n/overview.md) | [usage](packages/webafx-i18n/usage.md) | [api](packages/webafx-i18n/api.md) | [recipes](packages/webafx-i18n/recipes.md) | [pitfalls](packages/webafx-i18n/pitfalls.md) |
| webafx-mailer | [overview](packages/webafx-mailer/overview.md) | [usage](packages/webafx-mailer/usage.md) | [api](packages/webafx-mailer/api.md) | [recipes](packages/webafx-mailer/recipes.md) | [pitfalls](packages/webafx-mailer/pitfalls.md) |
| webafx-mailer-azure | [overview](packages/webafx-mailer-azure/overview.md) | [usage](packages/webafx-mailer-azure/usage.md) | [api](packages/webafx-mailer-azure/api.md) | [recipes](packages/webafx-mailer-azure/recipes.md) | [pitfalls](packages/webafx-mailer-azure/pitfalls.md) |
| webafx-pino | [overview](packages/webafx-pino/overview.md) | [usage](packages/webafx-pino/usage.md) | [api](packages/webafx-pino/api.md) | [recipes](packages/webafx-pino/recipes.md) | [pitfalls](packages/webafx-pino/pitfalls.md) |

## Task routing

| Task family | Read |
|-------------|------|
| CRUD API | [overview](packages/webafx/overview.md), [01-web-api-crud](patterns/01-web-api-crud.md) |
| Authentication | [overview](packages/webafx-auth/overview.md), [02-authentication-jwt](patterns/02-authentication-jwt.md) |
| Authorization | [overview](packages/authz/overview.md), [overview](packages/webafx-authz/overview.md), [overview](packages/react/overview.md) |
| Caching | [overview](packages/webafx-cache/overview.md), [03-caching-patterns](patterns/03-caching-patterns.md) |
| Database | [overview](packages/dbcore/overview.md), [overview](packages/postgresql/overview.md), [04-database-queries](patterns/04-database-queries.md) |
| Email | [overview](packages/webafx-mailer/overview.md), [07-email-sending](patterns/07-email-sending.md) |
| Internationalization | [overview](packages/i18n/overview.md), [overview](packages/webafx-i18n/overview.md), [08-internationalization](patterns/08-internationalization.md) |
| Logging | [overview](packages/webafx-pino/overview.md) |
| Code generation | [overview](packages/codegen/overview.md), [06-code-generation](patterns/06-code-generation.md) |
| Typed API client | [overview](packages/api-client/overview.md), [overview](packages/codegen/overview.md), [10-client-sdk-generation](patterns/10-client-sdk-generation.md) |
| Testing | [09-testing-patterns](patterns/09-testing-patterns.md) |

## Architecture

See [architecture](architecture.md) and [dependency-graph](dependency-graph.md).

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
