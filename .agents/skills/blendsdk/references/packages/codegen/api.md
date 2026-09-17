> **Package**: `blendsdk/codegen`

# codegen API Reference

Complete reference for every public class, function, type, and interface exported from
`blendsdk/codegen`'s single flat entry point. Signatures match the package source exactly; all
examples are complete, ESM-only TypeScript.

---

## Module Map

| Module group | Source | Key exports |
| --- | --- | --- |
| Data-shape schema | `src/schema` | `SchemaContainer`, `SchemaScope`, `SchemaObject`, `AnySchema`, `BooleanSchema`, `DateSchema`, `ObjectSchema`, `PrimitiveSchema`, `ReferenceSchema`, `StringSchema`, `SchemaUtils` |
| Generators | `src/generator` | `TypeGenerator`, `ZodGenerator`, `CTypeGenerator`, `PostgreSQLSchemaGenerator`, `OpenAPIGenerator`, `convertZodToJsonSchema`, `convertZodToQueryParameters`, `isZodSchema`, `sortByName`, `hoistDefinitions`, `generateClient`, `checkClient`, `ClientGeneratorOptions`, `GenerationResult`, OpenAPI document types |
| API contracts | `src/api` | `defineApiContract`, `ApiContract`, `ApiContractController`, `ResolvedApiContract` |
| Database schema model | `src/database/schema` | `DatabaseSchema`, `TableSchema`, `TableColumnSchema`, `IndexConstraint` |
| Introspection | `src/database/introspect` | `PostgreSQLIntrospector`, `ColumnMapper`, `ConstantType`, `ColumnIntrospection`, `ForeignKeyInfo`, `CheckConstraintInfo` |
| Migrations | `src/migration` | `defineMigrationConfig`, `generateBaseline`, `generateMigration`, `runMigrations`, `getMigrationStatus`, `validateMigrations`, `adoptBaseline`, `MigrationError`, `formatMigrationError` |

Shared generator behavior: a `Generator` subclass walks all objects in the container, skips objects
already rendered, refuses to render properties that were given explicit names (only root types may
be named), joins rendered blocks with a blank line, and formats the result with Prettier before
resolving. `CTypeGenerator`, `PostgreSQLSchemaGenerator`, and `OpenAPIGenerator` do not share this
base and are documented independently.

---

## Data-Shape Schema API

The data-shape model is a three-level hierarchy: a `SchemaContainer` owns named `SchemaScope`s, and
each scope is a factory for `SchemaObject`s (primitives, objects, references). Generators consume
the finished container.

### SchemaContainer

```typescript fragment
class SchemaContainer {
  constructor();
  scope(name?: string): SchemaScope;
  getAll(): SchemaObject[];
  find(scope: string | undefined, name: string): SchemaObject | undefined;
  clear(): void;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `new SchemaContainer()` | `SchemaContainer` | Creates an empty container with no scopes and no objects. |
| `scope` | `scope(name?: string): SchemaScope` | `SchemaScope` | Returns the scope for `name`, creating it on first access. Calling it without a name returns the default, unscoped scope. |
| `getAll` | `getAll(): SchemaObject[]` | `SchemaObject[]` | Returns every schema object registered across all scopes. Generators iterate this list. |
| `find` | `find(scope: string \| undefined, name: string): SchemaObject \| undefined` | `SchemaObject \| undefined` | Looks up a named object, optionally inside a specific scope. |
| `clear` | `clear(): void` | `void` | Removes all scopes and objects. |

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    name: scope.string(),
    email: scope.string().optional(),
  })
  .named('User');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

Generated output:

```typescript fragment
export interface User {
  id: number;
  name: string;
  email?: string;
}
```

### SchemaScope

A scope is a factory bound to one name (or to the default, unscoped group). Named root types from
different scopes receive scope-prefixed TypeScript names, so `scope('api_v1')` and `scope('api_v2')`
can both declare a `user_request` without colliding.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `string` | `string(): StringSchema` | `StringSchema` | Creates a string primitive schema (`string` / `z.string()`). |
| `number` | `number(): SchemaObject` | `SchemaObject` | Creates a numeric primitive schema (`number` / `z.number()`). |
| `boolean` | `boolean(): BooleanSchema` | `BooleanSchema` | Creates a boolean primitive schema. |
| `date` | `date(): DateSchema` | `DateSchema` | Creates a date primitive schema. |
| `any` | `any(): AnySchema` | `AnySchema` | Creates an unconstrained schema. |
| `object` | `object(properties: Record<string, SchemaObject>): ObjectSchema` | `ObjectSchema` | Creates an object schema whose properties are rendered inline. |
| `ref` | `ref(target: SchemaObject): ReferenceSchema` | `ReferenceSchema` | Creates a reference to another schema object; the referenced object is rendered as its own root declaration once. |

```typescript fragment
const scope = schema.scope('api_v1');
const directions = scope.number().named('directions').enum([1, 2, 3]);

scope
  .object({
    dir: scope.ref(directions).arrayed(),
  })
  .named('object1');
```

```typescript fragment
export type Directions = 1 | 2 | 3;
export interface Object1 {
  dir: Directions[];
}
```

### SchemaObject

The shared builder and accessor API implemented by every schema object.

```typescript fragment
class SchemaObject {
  named(name: string): this;
  description(text: string): this;
  optional(): this;
  nullable(): this;
  arrayed(): this;
  partial(): this;
  recordSet(): this;
  enum(values: number[] | string[]): this;
  metadata(data: Record<string, unknown>): this;
  getName(): string | undefined;
  getScope(): string | undefined;
  getNamedScoped(): string;
  isRendered(): boolean;
  reset(): void;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `named` | `named(name: string): this` | `this` | Assigns the schema name. Named root objects become exported declarations; naming a nested property is an error. |
| `description` | `description(text: string): this` | `this` | Appends description text. Generators render it as JSDoc (`@type`, `@optional`, `@nullable`, `@memberOf`, ... annotations are added automatically). |
| `optional` | `optional(): this` | `this` | Marks the property optional — `?` in TypeScript, `.optional()` in Zod, and excluded from OpenAPI `required`. |
| `nullable` | `nullable(): this` | `this` | Adds a null union — `\| null` in TypeScript, `.nullable()` in Zod, a JSON Schema type array in OpenAPI. |
| `arrayed` | `arrayed(): this` | `this` | Renders the type as an array (`T[]`). |
| `partial` | `partial(): this` | `this` | Wraps the type in `Partial<T>` (TypeScript) or `.partial()` (Zod). |
| `recordSet` | `recordSet(): this` | `this` | Wraps the type in `Record<string, T>` for dictionary shapes. |
| `enum` | `enum(values: number[] \| string[]): this` | `this` | Restricts the schema to a fixed literal set. |
| `metadata` | `metadata(data: Record<string, unknown>): this` | `this` | Attaches arbitrary metadata to the object; the introspector stores the raw catalog row here. |
| `getName` | `getName(): string \| undefined` | `string \| undefined` | Returns the assigned name, if any. |
| `getScope` | `getScope(): string \| undefined` | `string \| undefined` | Returns the owning scope name, if any. |
| `getNamedScoped` | `getNamedScoped(): string` | `string` | Returns the fully qualified name used in diagnostics and generated variable names. |
| `isRendered` | `isRendered(): boolean` | `boolean` | Reports whether this object has already been emitted; generators skip rendered objects. |
| `reset` | `reset(): void` | `void` | Clears render state; called by the generator base before a run. |

**Generator-facing members.** `getData()` returns the object's mutable descriptor and `setData()`
merges fields into it. Generators read these descriptor fields:

| Field | Type | Description |
|-------|------|-------------|
| `parent` | `SchemaObject \| undefined` | The enclosing object when this schema is a property. |
| `optional`, `nullable`, `arrayed`, `partial`, `recordSet` | `boolean \| undefined` | Active modifier flags. |
| `description` | `string \| undefined` | Accumulated description and annotation text. |
| `tsType` | `string \| undefined` | TypeScript type text assigned during rendering. |
| `zodType` | `string \| undefined` | Zod factory name used by `ZodGenerator` (`'string'`, `'object'`, ...). |
| `declType` | `'interface' \| 'type'` | Declaration keyword chosen by `TypeGenerator`. |
| `primitive` | `boolean \| undefined` | Whether the schema is a primitive. |
| `ref` | `SchemaObject \| undefined` | Reference target for `ReferenceSchema`. |
| `rendered` | `boolean \| undefined` | Render bookkeeping flag. |

### ObjectSchema

Returned by `SchemaScope.object()`.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getProperties` | `getProperties(): Record<string, SchemaObject>` | `Record<string, SchemaObject>` | Returns the object's property map in declaration order. |

### ReferenceSchema

Returned by `SchemaScope.ref()`. A reference points at another schema object through
`getData().ref`. When the target is a root type, the reference renders the target's generated name
and applies its own modifiers on top (`Partial<Row>[]`, `Row | null`, ...). When the reference is a
property, the target is rendered first if it has not been emitted yet, and an unnamed target raises
an error.

### Primitive Schema Classes

| Class | Created by | Description |
|-------|-----------|-------------|
| `StringSchema` | `SchemaScope.string()` | String primitive. |
| `BooleanSchema` | `SchemaScope.boolean()` | Boolean primitive. |
| `DateSchema` | `SchemaScope.date()` | Date primitive. |
| `AnySchema` | `SchemaScope.any()` | Unconstrained primitive. |
| `PrimitiveSchema` | `SchemaScope.number()` and other primitives | Generic primitive kind used by the generator dispatch. |

All primitives share the complete `SchemaObject` builder API.

### SchemaUtils

Static helpers used by the generators; available for custom generators and tooling.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `snakeToPascalCase` | `snakeToPascalCase(value: string): string` | `string` | Converts `snake_case` (and `_`-joined) text to `PascalCase`. |
| `formatMultilineComment` | `formatMultilineComment(lines: string[]): string[]` | `string[]` | Formats comment lines as a JSDoc block ready to push into an output buffer. |
| `getTypeScriptName` | `getTypeScriptName(obj: SchemaObject): string \| undefined` | `string \| undefined` | Returns the scope-aware TypeScript name assigned to a schema object during rendering. |

---

## Generator API

### TypeGenerator

Generates TypeScript `interface` and `type` declarations from a `SchemaContainer`. Plain root
objects become `interface` declarations; primitives, modified objects (partial/array/nullable), and
nested objects become `type` aliases.

```typescript fragment
class TypeGenerator {
  constructor(options?: TypeGeneratorOptions);
  generate(container: SchemaContainer): Promise<string>;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `new TypeGenerator(options?: TypeGeneratorOptions)` | `TypeGenerator` | Creates the generator. |
| `generate` | `generate(container: SchemaContainer): Promise<string>` | `Promise<string>` | Renders every named root object once and returns Prettier-formatted TypeScript source. |

Modifiers are applied in a fixed order: `Partial<T>` first, then `T[]`, then `Record<string, T>`,
and finally `T | null`.

```typescript
import { SchemaContainer, TypeGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope('api_v1');

const user = scope
  .object({
    username: scope.string(),
    password: scope.string(),
  })
  .named('user');

scope
  .object({
    user: scope.ref(user).nullable(),
  })
  .named('user_request');

const source = await new TypeGenerator().generate(schema);
console.log(source);
```

```typescript fragment
export interface ApiV1UserRequest {
  user: User | null;
}
export interface User {
  username: string;
  password: string;
}
```

### TypeGeneratorOptions

| Property | Type | Description |
|----------|------|-------------|
| — | — | Currently declares no options of its own; reserved for future extensibility. Accepts the base generator options object. |

### ZodGenerator

Generates Zod v4 validation schemas from a `SchemaContainer`, keeping runtime validation aligned
with the generated TypeScript types. The emitted source always begins with
`import * as z from 'zod';`.

```typescript fragment
class ZodGenerator {
  constructor(options?: ZodGeneratorOptions);
  generate(container: SchemaContainer): Promise<string>;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `new ZodGenerator(options?: ZodGeneratorOptions)` | `ZodGenerator` | Creates the generator and seeds the output with the Zod import. |
| `generate` | `generate(container: SchemaContainer): Promise<string>` | `Promise<string>` | Renders every named root object once and returns Prettier-formatted source. |

### ZodGeneratorOptions

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `zodVariablePostfix` | `string` | No | `'schema'` | Postfix appended to the generated variable name, e.g. `User` + `schema` → `UserSchema`. |

```typescript
import { SchemaContainer, ZodGenerator } from 'blendsdk/codegen';

const schema = new SchemaContainer();
const scope = schema.scope();

scope
  .object({
    id: scope.number(),
    name: scope.string(),
    email: scope.string().optional(),
  })
  .named('User');

const source = await new ZodGenerator().generate(schema);
console.log(source);
```

```typescript fragment
import * as z from 'zod';

export const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().optional(),
});
```

### CTypeGenerator

Generates `e<Name>` constant objects that map a `$TABLE` key and uppercase column keys to their
string values, for type-safe query code.

```typescript fragment
class CTypeGenerator {
  constructor();
  generate(ctypes: ConstantType): Promise<string>;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `new CTypeGenerator()` | `CTypeGenerator` | Creates the generator. |
| `generate` | `generate(ctypes: ConstantType): Promise<string>` | `Promise<string>` | Renders one exported constant per constant type and returns Prettier-formatted source. The input is the `ConstantType` map returned by `PostgreSQLIntrospector.introstectConstantTypes()`. |

```typescript
import { CTypeGenerator, type ConstantType } from 'blendsdk/codegen';

const ctypes: ConstantType = {
  'public.customer': ['id', 'name', 'email'],
};

const source = await new CTypeGenerator().generate(ctypes);
console.log(source);
```

```typescript fragment
/**
 * Constant type for relation public.customer
 * @export
 * @constant
 */
export const ePublicCustomer = {
  $TABLE: 'public.customer',
  ID: 'id',
  NAME: 'name',
  EMAIL: 'email',
};
```

### PostgreSQLSchemaGenerator

Renders a desired-state `DatabaseSchema` as complete bootstrap (initializer) DDL for provisioning
fresh databases. Output is grouped into schema, index, and view sections.

```typescript fragment
class PostgreSQLSchemaGenerator {
  constructor(db: DatabaseSchema);
  generateGrouped(params?: GenerateOptions): GeneratedDDL;
  generate(params?: GenerateOptions): string;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `new PostgreSQLSchemaGenerator(db: DatabaseSchema)` | `PostgreSQLSchemaGenerator` | Creates a generator for one database schema model. |
| `generateGrouped` | `generateGrouped(params?: GenerateOptions): GeneratedDDL` | `GeneratedDDL` | Returns DDL grouped by section: `schema` (extensions, schemas, tables, constraints, comments), `indexes`, `views`, and `all`. |
| `generate` | `generate(params?: GenerateOptions): string` | `string` | Returns the combined DDL as one string; equivalent to `generateGrouped(params).all`. |

### GenerateOptions

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `dropBeforeCreate` | `boolean` | No | `true` | Emits `DROP SCHEMA IF EXISTS ... CASCADE` and `DROP TABLE IF EXISTS ... CASCADE` before the `CREATE` statements. |

### GeneratedDDL

| Property | Type | Description |
|----------|------|-------------|
| `schema` | `string` | Extensions, schemas, `CREATE TABLE`, constraints, and comments. |
| `indexes` | `string` | All `CREATE [UNIQUE] INDEX` statements. |
| `views` | `string` | Regular and materialized view statements plus view comments. |
| `all` | `string` | Everything combined. |

```typescript
import { DatabaseSchema, PostgreSQLSchemaGenerator } from 'blendsdk/codegen';

const db = new DatabaseSchema('app');
const customer = db.table('customer');
customer.bigint('id').primaryKey();
customer.varchar('email', 255).nullable().unique();
customer.timestamp('created_at', 6).default('now()');

const ddl = new PostgreSQLSchemaGenerator(db).generate();
console.log(ddl);
```

```sql
DROP TABLE IF EXISTS public.customer CASCADE;

CREATE TABLE public.customer (
	id bigint NOT NULL,
	email varchar(255),
	created_at timestamp(6) DEFAULT now()
);

ALTER TABLE public.customer
	ADD CONSTRAINT customer_id_pkey PRIMARY KEY (id),
	ADD CONSTRAINT customer_email_unique_0 UNIQUE (email);
```

### OpenAPIGenerator

Generates an OpenAPI v3.1.0 document from `blendsdk/webafx` controller routes. Only routes that
carry `.openapi()` metadata are included — that metadata is the opt-in mechanism.

```typescript fragment
class OpenAPIGenerator {
  constructor(config: OpenAPIGeneratorConfig);
  addController(basePath: string, ControllerClass: ControllerConstructor): this;
  addRoutes(basePath: string, routeDefinitions: RouteDefinition[]): this;
  generate(): OpenAPIDocument;
  toJSON(indent?: number): string;
  toFile(filePath: string): void;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `new OpenAPIGenerator(config: OpenAPIGeneratorConfig)` | `OpenAPIGenerator` | Creates the generator with API metadata and security configuration. |
| `addController` | `addController(basePath: string, ControllerClass: ControllerConstructor): this` | `this` | Instantiates the controller with empty settings/services, calls `routes()`, and collects routes that carry OpenAPI metadata. |
| `addRoutes` | `addRoutes(basePath: string, routeDefinitions: RouteDefinition[]): this` | `this` | Adds route definitions directly; routes without `.openapi()` metadata are filtered out. |
| `generate` | `generate(): OpenAPIDocument` | `OpenAPIDocument` | Assembles the complete document: info, servers, paths, and components. |
| `toJSON` | `toJSON(indent: number = 2): string` | `string` | Returns the generated document as formatted JSON. |
| `toFile` | `toFile(filePath: string): void` | `void` | Writes the document to disk, creating parent directories when needed. |

Behavior notes:

- `:param` path segments are converted to OpenAPI `{param}` syntax; each path parameter becomes a required `in: 'path'` parameter.
- POST/PUT/PATCH routes with a Zod `validation` schema get a `requestBody` with `application/json` content.
- GET/DELETE routes with a Zod `validation` schema get query parameters instead.
- Routes marked `secure: true` (or with a principal service name) receive the configured `defaultSecurity`; when no default security is configured, `security: []` is emitted.
- Response definitions from `.openapi()` metadata are mapped keyed by status code; responses with a Zod `schema` gain `content['application/json'].schema`.

Protected extension points (override in a subclass):

| Method | Signature | Description |
|--------|-----------|-------------|
| `buildPaths` | `buildPaths(): Record<string, OpenAPIPathItem>` | Builds the `paths` object from collected routes. |
| `buildFullPath` | `buildFullPath(basePath: string, routePath: string): string` | Combines a controller base path and a route path. |
| `convertExpressPathToOpenAPI` | `convertExpressPathToOpenAPI(expressPath: string): string` | Rewrites `:param` segments to `{param}`. |
| `extractPathParamNames` | `extractPathParamNames(expressPath: string): string[]` | Extracts path parameter names from a route path. |
| `buildOperation` | `buildOperation(definition: RouteDefinition): OpenAPIOperation` | Assembles one operation object. |
| `buildParameters` | `buildParameters(definition: RouteDefinition): OpenAPIParameter[]` | Builds path and query parameters. |
| `buildRequestBody` | `buildRequestBody(definition: RouteDefinition)` | Builds the JSON request body for POST/PUT/PATCH routes. |
| `buildResponses` | `buildResponses(definition: RouteDefinition): Record<string, OpenAPIResponse>` | Maps response metadata to response objects. |
| `buildSecurity` | `buildSecurity(definition: RouteDefinition): SecurityRequirement[] \| undefined` | Applies default security to secure routes. |
| `isQueryParamMethod` | `isQueryParamMethod(method: HttpMethod): boolean` | Returns `true` for GET and DELETE. |
| `convertZodToQueryParameters` | `convertZodToQueryParameters(zodSchema: unknown): OpenAPIParameter[]` | Delegates to the public `convertZodToQueryParameters`. |

```typescript
import { OpenAPIGenerator } from 'blendsdk/codegen';
import type { RouteDefinition } from 'blendsdk/webafx';

class HealthController {
  constructor(_settings: Record<string, never>, _services: Record<string, never>) {}

  routes(): RouteDefinition[] {
    return [
      {
        method: 'get',
        path: '/',
        handler: () => undefined,
        openapi: {
          summary: 'Health check',
          responses: [{ statusCode: 200, description: 'Service is healthy' }],
        },
      } as RouteDefinition,
    ];
  }
}

const generator = new OpenAPIGenerator({
  title: 'Health API',
  version: '1.0.0',
  servers: [{ url: 'https://api.example.com' }],
});

generator.addController('/api/health', HealthController);
generator.toFile('./openapi.json');
```

### OpenAPI Document Types

#### OpenAPIDocument

| Property | Type | Description |
|----------|------|-------------|
| `openapi` | `'3.1.0'` | The OpenAPI specification version. |
| `info` | `OpenAPIInfo` | Metadata about the API. |
| `servers` | `OpenAPIServer[] \| undefined` | Server connectivity information. |
| `paths` | `Record<string, OpenAPIPathItem>` | Available paths and operations. |
| `components` | `OpenAPIComponents \| undefined` | Reusable schemas and security schemes. |

#### OpenAPIInfo

| Property | Type | Description |
|----------|------|-------------|
| `title` | `string` | The title of the API. |
| `version` | `string` | The version of the API (not the spec version). |
| `description` | `string \| undefined` | A description of the API (supports Markdown). |

#### OpenAPIServer

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | A URL to the target host. |
| `description` | `string \| undefined` | An optional description of the server. |

#### OpenAPISchema

| Property | Type | Description |
|----------|------|-------------|
| `type` | `string \| undefined` | Data type: `string`, `number`, `integer`, `boolean`, `array`, `object`. |
| `description` | `string \| undefined` | Description of the schema. |
| `format` | `string \| undefined` | Format hint (`int32`, `int64`, `float`, `double`, `date-time`, `email`, `uuid`, ...). |
| `enum` | `unknown[] \| undefined` | Allowed enumeration values. |
| `default` | `unknown \| undefined` | Default value. |
| `properties` | `Record<string, OpenAPISchema> \| undefined` | Property definitions for objects. |
| `required` | `string[] \| undefined` | Required property names for objects. |
| `additionalProperties` | `boolean \| OpenAPISchema \| undefined` | Whether additional properties are allowed. |
| `items` | `OpenAPISchema \| undefined` | Schema of array items. |
| `minimum` / `maximum` | `number \| undefined` | Numeric bounds. |
| `minLength` / `maxLength` | `number \| undefined` | String length or array length bounds. |
| `minItems` / `maxItems` | `number \| undefined` | Array item count bounds. |
| `pattern` | `string \| undefined` | Regex pattern for strings. |
| `nullable` | `boolean \| undefined` | Nullable value marker. |
| `allOf` / `anyOf` / `oneOf` | `OpenAPISchema[] \| undefined` | Schema composition lists. |
| `example` | `unknown \| undefined` | Example value. |
| `$ref` | `string \| undefined` | Reference to another schema. |

#### OpenAPIParameter

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | The parameter name. |
| `in` | `'query' \| 'header' \| 'path' \| 'cookie'` | Parameter location. |
| `required` | `boolean \| undefined` | Whether the parameter is required (path parameters are always required). |
| `description` | `string \| undefined` | Parameter description. |
| `schema` | `OpenAPISchema \| undefined` | Type and constraints. |
| `deprecated` | `boolean \| undefined` | Whether the parameter is deprecated. |

#### OpenAPIRequestBody

| Property | Type | Description |
|----------|------|-------------|
| `description` | `string \| undefined` | Description of the request body. |
| `required` | `boolean \| undefined` | Whether the body is required. |
| `content` | `Record<string, OpenAPIMediaType>` | Content keyed by media type. |

#### OpenAPIMediaType

| Property | Type | Description |
|----------|------|-------------|
| `schema` | `OpenAPISchema \| undefined` | Schema defining the content structure. |

#### OpenAPIResponse

| Property | Type | Description |
|----------|------|-------------|
| `description` | `string` | Response description (required by the spec). |
| `content` | `Record<string, OpenAPIMediaType> \| undefined` | Response content keyed by media type. |

#### OpenAPIOperation

| Property | Type | Description |
|----------|------|-------------|
| `summary` | `string \| undefined` | Short operation summary. |
| `description` | `string \| undefined` | Verbose description (supports Markdown). |
| `operationId` | `string \| undefined` | Unique operation identifier. |
| `tags` | `string[] \| undefined` | Documentation grouping tags. |
| `parameters` | `OpenAPIParameter[] \| undefined` | Parameters applicable to this operation. |
| `requestBody` | `OpenAPIRequestBody \| undefined` | Request body applicable to this operation. |
| `responses` | `Record<string, OpenAPIResponse> \| undefined` | Expected responses keyed by status code. |
| `security` | `SecurityRequirement[] \| undefined` | Security requirements for this operation. |
| `deprecated` | `boolean \| undefined` | Whether the operation is deprecated. |

#### OpenAPIPathItem

| Property | Type | Description |
|----------|------|-------------|
| `get` / `post` / `put` / `patch` / `delete` | `OpenAPIOperation \| undefined` | The operation for that HTTP method. |

#### OpenAPISecurityScheme

| Property | Type | Description |
|----------|------|-------------|
| `type` | `'apiKey' \| 'http' \| 'oauth2' \| 'openIdConnect'` | Security scheme type. |
| `description` | `string \| undefined` | Scheme description. |
| `name` | `string \| undefined` | Parameter name (for `apiKey`). |
| `in` | `'query' \| 'header' \| 'cookie' \| undefined` | API key location (for `apiKey`). |
| `scheme` | `string \| undefined` | HTTP authorization scheme (for `http`, e.g. `'bearer'`). |
| `bearerFormat` | `string \| undefined` | Bearer token format (e.g. `'JWT'`). |

#### SecurityRequirement

```typescript fragment
type SecurityRequirement = Record<string, string[]>;
```

Each key is a security scheme name; each value is the list of required scopes.

#### OpenAPIComponents

| Property | Type | Description |
|----------|------|-------------|
| `schemas` | `Record<string, OpenAPISchema> \| undefined` | Reusable schema definitions. |
| `securitySchemes` | `Record<string, OpenAPISecurityScheme> \| undefined` | Reusable security scheme definitions. |

### OpenAPIGeneratorConfig

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `title` | `string` | Yes | API title, emitted in `info`. |
| `version` | `string` | Yes | API version string, emitted in `info`. |
| `description` | `string` | No | API description (supports Markdown). |
| `servers` | `OpenAPIServer[]` | No | Server definitions. An empty array is omitted from the document. |
| `securitySchemes` | `Record<string, OpenAPISecurityScheme>` | No | Security scheme definitions placed in `components`. |
| `defaultSecurity` | `SecurityRequirement[]` | No | Security requirements applied to routes marked `secure`. |

### ControllerConstructor

```typescript fragment
type ControllerConstructor = new (settings: any, services: any) => {
  routes(): RouteDefinition[];
};
```

A loose constructor signature so code generation does not need to import the full
`ApplicationSettings`/`ServiceContainer` types at runtime. Controllers are instantiated with empty
mock dependencies because `routes()` only builds `RouteDefinition` objects.

### convertZodToJsonSchema

Converts a Zod v4 schema into an OpenAPI 3.1 JSON Schema object using Zod's native `z.toJSONSchema`
converter (`draft-2020-12`), so no third-party converter is needed. The root `$schema` marker is
removed and a simple nullable union is folded into a JSON Schema type array
(`type: ['string', 'null']`), which OpenAPI 3.1 understands.

```typescript fragment
function convertZodToJsonSchema(schema: ZodType, direction: 'input' | 'output'): OpenAPISchema;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `schema` | `ZodType` | Yes | — | Any Zod v4 schema instance (`z.string()`, `z.object({...})`, ...). Unrecognized values produce the fallback `{ type: 'object' }`. |
| `direction` | `'input' \| 'output'` | Yes | — | Which side of the wire the schema describes: `'input'` for request bodies and query schemas, `'output'` for response schemas. Determines how defaults and transforms resolve. |

**Returns:** `OpenAPISchema` — the converted JSON Schema object.

```typescript
import { z } from 'zod';
import { convertZodToJsonSchema } from 'blendsdk/codegen';

const schema = z.object({
  name: z.string().min(1),
  age: z.number().int().optional(),
});

const openApiSchema = convertZodToJsonSchema(schema, 'input');
console.log(openApiSchema);
// { type: 'object', properties: { name: { type: 'string', minLength: 1 }, age: { type: 'integer' } }, required: ['name'] }
```

### convertZodToQueryParameters

Converts a Zod v4 object schema into an array of OpenAPI query parameters — one parameter per
top-level property. Optional properties and properties with defaults become non-required
parameters.

```typescript fragment
function convertZodToQueryParameters(schema: ZodType): OpenAPIParameter[];
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `schema` | `ZodType` | Yes | — | A Zod v4 object schema (`z.object({ ... })`). Non-object schemas return an empty array. |

**Returns:** `OpenAPIParameter[]` — parameters with `in: 'query'`.

```typescript
import { z } from 'zod';
import { convertZodToQueryParameters } from 'blendsdk/codegen';

const schema = z.object({
  page: z.coerce.number().default(1),
  search: z.string().optional(),
});

const params = convertZodToQueryParameters(schema);
console.log(params);
// [
//   { name: 'page', in: 'query', schema: { type: 'number', default: 1 } },
//   { name: 'search', in: 'query', schema: { type: 'string' } },
// ]
```

### Zod → OpenAPI Conversion Mapping

| Zod construct | OpenAPI result |
|---------------|----------------|
| `z.string()` | `{ type: 'string' }` with `minLength`, `maxLength`, and `format` from checks |
| `z.number()` | `{ type: 'number' }`; `{ type: 'integer' }` when `.int()` is applied |
| `z.boolean()` | `{ type: 'boolean' }` |
| `z.enum([...])` | `{ type: 'string', enum: [...] }` |
| `z.literal(value)` | Inferred `type` with a single-value `enum` |
| `z.array(...)` | `{ type: 'array', items: ... }` with `minItems` / `maxItems` from checks |
| `z.object({...})` | `{ type: 'object', properties: ..., required: [...] }` |
| `z.string().optional()` | Inner schema; not listed in `required` |
| `z.string().nullable()` | Inner schema in a JSON Schema type array (`type: ['string', 'null']`) |
| `z.string().default(value)` | Inner schema with `default: value`; not listed in `required` |
| `z.union([...])` | `{ anyOf: [...] }` |
| `.transform()` / `.pipe()` | With `direction: 'input'`, the **input** schema — what the API consumer sends |
| Unrecognized input | `{ type: 'object' }` fallback |

---

## Client Generator API

The client generator reads an OpenAPI 3.1 document — typically the one `OpenAPIGenerator` produced —
and writes a typed TypeScript client whose methods match the server's operations. Generated files
import the `blendsdk/api-client` runtime and carry a marker so stale files are pruned.

### defineApiContract

Declares the `blendsdk.api.ts` contract: the controllers to collect, where to write the OpenAPI
document and the generated client, and the generator flags.

```typescript fragment
function defineApiContract(contract: ApiContract): ApiContract;
```

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `outputDir` | `string` | Yes | Output directory for the generated client, resolved relative to the config file. |
| `contractFile` | `string` | No | OpenAPI JSON to write and compare. Defaults to `api.json`. |
| `controllers` | `ApiContractController[]` | Yes | Controllers to collect, each with the base path it is mounted at. |
| `openapi` | `OpenAPIGeneratorConfig` | Yes | Document metadata and security schemes. |
| `generator` | `Omit<ClientGeneratorOptions, 'outputDir'>` | No | Generator flags. |

```typescript
import { defineApiContract } from 'blendsdk/codegen';
import { ProductsController } from './controllers/products.controller.js';

export default defineApiContract({
  outputDir: 'src/api-client',
  contractFile: 'api.json',
  controllers: [{ basePath: '/api/products', controller: ProductsController }],
  openapi: { title: 'My API', version: '1.0.0' },
});
```

### generateClient

```typescript fragment
function generateClient(
  document: OpenAPIDocument,
  options: ClientGeneratorOptions
): Promise<GenerationResult>;
```

Writes `types.ts`, `client.ts`, and `index.ts` into `options.outputDir`, prunes stale generated
files, and returns the file names plus any contract issues. It throws `ClientGenerationError` when
two operations share an `operationId`, or when `strict` is set and the contract has a warning-level
problem.

### checkClient

```typescript fragment
function checkClient(
  document: OpenAPIDocument,
  options: ClientGeneratorOptions
): Promise<GenerationResult>;
```

Regenerates in memory and compares against the committed files — the CI drift gate. The result sets
`drifted: true` and lists `driftedFiles` when a file differs or the contract has an error.

### ClientGeneratorOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `outputDir` | `string` | Yes | Output directory, resolved relative to the config file. |
| `splitByGroup` | `boolean` | No | Emit one file per group instead of grouping every method in `client.ts`. |
| `strict` | `boolean` | No | Treat contract problems as errors instead of warnings. |
| `clientName` | `string` | No | Base name of the generated client type. Defaults to `AppClient`. |
| `runtimeImport` | `string` | No | Runtime import specifier. Defaults to `blendsdk/api-client`. |

### GenerationResult

| Property | Type | Description |
|----------|------|-------------|
| `files` | `string[]` | File names written (`generate`) or compared (`check`). |
| `issues` | `ContractIssue[]` | Problems found while reading the contract. |
| `drifted` | `boolean \| undefined` | True when `check` found a difference or a contract error. |
| `driftedFiles` | `string[] \| undefined` | The files that differ from the committed ones. |

---

## Database Schema API

The relational authoring model: `DatabaseSchema` owns tables and views, tables own typed columns,
and constraints/indexes attach to tables. A desired-state model is the input for both the initializer
DDL generator and the migration diff engine.

### DatabaseSchema

```typescript fragment
class DatabaseSchema {
  constructor(name: string, defaultScope?: string);
  extension(...extension: string[]): this;
  table(name: string, builder?: MakeTable): TableSchema;
  view(name: string): ViewSchema;
  getExtensions(): string[];
  getTables(): TableSchema[];
  getViews(): ViewSchema[];
  getDefaultSchema(): string;
  comment(comment: string): this;
  getComment(): string | undefined;
  getName(): string;
}

type MakeTable = (t: TableSchema) => void;
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `new DatabaseSchema(name: string, defaultScope?: string)` | `DatabaseSchema` | Creates a database model. `name` is the model's identity; `defaultScope` defaults to `'public'` and is applied to every table and view. |
| `extension` | `extension(...extension: string[]): this` | `this` | Registers required PostgreSQL extensions (e.g. `'pgcrypto'`, `'uuid-ossp'`). Duplicates are de-duplicated at render time. |
| `table` | `table(name: string, builder?: MakeTable): TableSchema` | `TableSchema` | Creates a table in the default scope and optionally runs a builder callback against it. |
| `view` | `view(name: string): ViewSchema` | `ViewSchema` | Creates a view in the default scope. |
| `getExtensions` | `getExtensions(): string[]` | `string[]` | Returns the registered extensions, filtered for empty entries. |
| `getTables` | `getTables(): TableSchema[]` | `TableSchema[]` | Returns all tables in declaration order. |
| `getViews` | `getViews(): ViewSchema[]` | `ViewSchema[]` | Returns all views in declaration order. |
| `getDefaultSchema` | `getDefaultSchema(): string` | `string` | Returns the default scope (`'public'` unless overridden). |
| `comment` | `comment(comment: string): this` | `this` | Sets a comment for the object. |
| `getComment` | `getComment(): string \| undefined` | `string \| undefined` | Returns the comment, if set. |
| `getName` | `getName(): string` | `string` | Returns the model name. |

### View Objects (`DatabaseSchema.view()`)

The returned object's class is not re-exported from the package root; obtain instances from
`DatabaseSchema.view()`.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `as` | `as(source: string): this` | `this` | Sets the view's `SELECT` source SQL. |
| `materialized` | `materialized(state: boolean): this` | `this` | Marks the view as materialized (`true` unless explicitly `false`). |
| `isMaterialized` | `isMaterialized(): boolean` | `boolean` | Reports whether the view is materialized. |
| `getSource` | `getSource(): string \| undefined` | `string \| undefined` | Returns the source SQL. |
| `scope` | `scope(name: string): this` | `this` | Overrides the scope for this view. |
| `getName` | `getName(scope?: boolean): string` | `string` | Returns `"<scope>.<name>"` (default) or the bare name when `scope` is `false`. |
| `getScope` | `getScope(): string \| undefined` | `string \| undefined` | Returns the view's scope. |
| `comment` | `comment(comment: string): this` | `this` | Sets the view comment. |
| `getComment` | `getComment(): string \| undefined` | `string \| undefined` | Returns the view comment. |

```typescript fragment
const db = new DatabaseSchema('app');
db.view('active_customer')
  .as('SELECT * FROM public.customer WHERE active')
  .comment('active customers only');
```

### TableSchema

```typescript fragment
class TableSchema {
  constructor(name: string, database: DatabaseSchema);
  foreignKeyConstraint(toTable: TableSchema): ForeignKeyConstraint;
  uniqueConstraint(): UniqueConstraint;
  checkConstraint(rule: string): this;
  index(): IndexConstraint;
  primaryKey(): PrimaryKeyConstraint;
  getPrimaryKey(): PrimaryKeyConstraint | undefined;
  getForeignKeyConstrains(): ForeignKeyConstraint[];
  getCheckConstraints(): CheckConstraint[];
  getUniqueConstraints(): UniqueConstraint[];
  getIndexes(): IndexConstraint[];
  scope(name: string): this;
  getName(scope?: boolean): string;
  getScope(): string | undefined;
  findColumn(name: string): TableColumnSchema | undefined;
  getColumns(): TableColumnSchema[];
  getDatabase(): DatabaseSchema;
  comment(comment: string): this;
  getComment(): string | undefined;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `new TableSchema(name: string, database: DatabaseSchema)` | `TableSchema` | Usually created through `DatabaseSchema.table()`. |
| `foreignKeyConstraint` | `foreignKeyConstraint(toTable: TableSchema): ForeignKeyConstraint` | `ForeignKeyConstraint` | Creates (and registers) a foreign key from this table to `toTable`. |
| `uniqueConstraint` | `uniqueConstraint(): UniqueConstraint` | `UniqueConstraint` | Creates (and registers) a unique constraint; add columns with `.column(...)`. |
| `checkConstraint` | `checkConstraint(rule: string): this` | `this` | Registers a table-level `CHECK` constraint with the given rule expression. |
| `index` | `index(): IndexConstraint` | `IndexConstraint` | Creates (and registers) an index builder. |
| `primaryKey` | `primaryKey(): PrimaryKeyConstraint` | `PrimaryKeyConstraint` | Returns the primary-key constraint, creating it on first call; add columns with `.column(...)`. |
| `getPrimaryKey` | `getPrimaryKey(): PrimaryKeyConstraint \| undefined` | `PrimaryKeyConstraint \| undefined` | Read-only accessor — returns the configured primary key without creating one. |
| `getForeignKeyConstrains` | `getForeignKeyConstrains(): ForeignKeyConstraint[]` | `ForeignKeyConstraint[]` | Returns registered foreign keys (note the method name's spelling in the API). |
| `getCheckConstraints` | `getCheckConstraints(): CheckConstraint[]` | `CheckConstraint[]` | Returns registered check constraints. |
| `getUniqueConstraints` | `getUniqueConstraints(): UniqueConstraint[]` | `UniqueConstraint[]` | Returns registered unique constraints. |
| `getIndexes` | `getIndexes(): IndexConstraint[]` | `IndexConstraint[]` | Returns registered indexes. |
| `scope` | `scope(name: string): this` | `this` | Overrides the table's scope. |
| `getName` | `getName(scope?: boolean): string` | `string` | Returns `"<scope>.<name>"` (default) or the bare name when `scope` is `false`. |
| `getScope` | `getScope(): string \| undefined` | `string \| undefined` | Returns the table's scope. |
| `findColumn` | `findColumn(name: string): TableColumnSchema \| undefined` | `TableColumnSchema \| undefined` | Finds a column by name. |
| `getColumns` | `getColumns(): TableColumnSchema[]` | `TableColumnSchema[]` | Returns all columns in declaration order. |
| `getDatabase` | `getDatabase(): DatabaseSchema` | `DatabaseSchema` | Returns the owning database model. |
| `comment` | `comment(comment: string): this` | `this` | Sets the table comment; rendered as `COMMENT ON TABLE`. |
| `getComment` | `getComment(): string \| undefined` | `string \| undefined` | Returns the table comment. |

#### Column helpers

Every helper creates a `TableColumnSchema`, appends it to the table, and returns it for chaining.

| Helper | Signature | Column type |
|--------|-----------|-------------|
| `serial` | `serial(name: string): TableColumnSchema` | `serial` |
| `bigserial` | `bigserial(name: string): TableColumnSchema` | `bigserial` |
| `smallint` | `smallint(name: string): TableColumnSchema` | `smallint` |
| `integer` | `integer(name: string): TableColumnSchema` | `integer` |
| `bigint` | `bigint(name: string): TableColumnSchema` | `bigint` |
| `decimal` | `decimal(name: string, size?: number, scale?: number): TableColumnSchema` | `decimal` |
| `numeric` | `numeric(name: string, size?: number, scale?: number): TableColumnSchema` | `numeric` |
| `real` | `real(name: string): TableColumnSchema` | `real` |
| `doublePrecision` | `doublePrecision(name: string): TableColumnSchema` | `double precision` |
| `varchar` | `varchar(name: string, size?: number): TableColumnSchema` | `varchar` |
| `char` | `char(name: string, size?: number): TableColumnSchema` | `char` |
| `text` | `text(name: string): TableColumnSchema` | `text` |
| `boolean` | `boolean(name: string): TableColumnSchema` | `boolean` |
| `date` | `date(name: string): TableColumnSchema` | `date` |
| `time` | `time(name: string, size?: number): TableColumnSchema` | `time` |
| `timestamp` | `timestamp(name: string, size?: number): TableColumnSchema` | `timestamp` |
| `timestamptz` | `timestamptz(name: string, size?: number): TableColumnSchema` | `timestamptz` |
| `json` | `json(name: string): TableColumnSchema` | `json` |
| `jsonb` | `jsonb(name: string): TableColumnSchema` | `jsonb` |
| `uuid` | `uuid(name: string): TableColumnSchema` | `uuid` |
| `vector` | `vector(name: string): TableColumnSchema` | `vector` |
| `tsvector` | `tsvector(name: string): TableColumnSchema` | `tsvector` |

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const db = new DatabaseSchema('app');

const parent = db.table('parent');
parent.bigint('id').primaryKey();

const child = db.table('child');
child.bigint('id').identity('BY DEFAULT');
child.varchar('code', 32).unique();
child.bigint('parent_id').references(parent, 'id', 'CASCADE', 'RESTRICT');
child.integer('quantity').check('quantity > 0');
child.index().indexName('child_parent_id_idx').column('parent_id');
```

### TableColumnSchema

```typescript fragment
class TableColumnSchema {
  type(type: ColumnType): this;
  nullable(): this;
  default(value: string | boolean | number | undefined, quote?: boolean): this;
  primaryKey(): this;
  unique(): this;
  check(rule: string): this;
  references(
    toTable: TableSchema,
    column: string,
    onUpdate?: ReferentialAction,
    onDelete?: ReferentialAction
  ): this;
  size(value: number): void;
  scale(value: number): void;
  generated(expression: string, stored?: 'STORED' | 'VIRTUAL'): this;
  identity(
    generationOrFunction?: 'ALWAYS' | 'BY DEFAULT' | 'v4' | 'v7' | string,
    options?: IdentityOptions
  ): this;
  getType(): ColumnType | undefined;
  getSize(): number | undefined;
  getScale(): number | undefined;
  getNullable(): boolean;
  getDefault(): string | boolean | number | undefined;
  isGenerated(): boolean;
  isGeneratedStored(): boolean;
  getGeneratedExpression(): string | undefined;
  isIdentity(): boolean;
  getIdentityGeneration(): 'ALWAYS' | 'BY DEFAULT' | undefined;
  getIdentityOptions(): IdentityOptions | undefined;
  getName(): string;
  comment(comment: string): this;
  getComment(): string | undefined;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `type` | `type(type: ColumnType): this` | `this` | Sets the SQL column type. |
| `nullable` | `nullable(): this` | `this` | Marks the column nullable (columns are `NOT NULL` by default). |
| `default` | `default(value: string \| boolean \| number \| undefined, quote?: boolean): this` | `this` | Sets the column default; pass `quote: true` for string literals that must be single-quoted. |
| `primaryKey` | `primaryKey(): this` | `this` | Adds this column to the table's primary key, adds a unique constraint, and sets the column `NOT NULL`. |
| `unique` | `unique(): this` | `this` | Creates a unique constraint containing this column. |
| `check` | `check(rule: string): this` | `this` | Creates a table-level `CHECK` constraint with the given rule. |
| `references` | `references(toTable, column, onUpdate?, onDelete?): this` | `this` | Creates a foreign key from this column to `toTable.column`, with the given referential actions. |
| `size` | `size(value: number): void` | `void` | Sets the type size/length (e.g. `varchar(255)`). Not chainable. |
| `scale` | `scale(value: number): void` | `void` | Sets the numeric scale (e.g. `numeric(10,2)`). Not chainable. |
| `generated` | `generated(expression: string, stored: 'STORED' \| 'VIRTUAL' = 'STORED'): this` | `this` | Defines a generated column. PostgreSQL only supports `STORED`; `'VIRTUAL'` throws. Clears any default. |
| `identity` | `identity(generationOrFunction?, options?): this` | `this` | Defines an identity column for integer types, or a default UUID generator for `uuid` columns. Throws when the column type is neither, or when the column is already `GENERATED`. |
| `getType` | `getType(): ColumnType \| undefined` | `ColumnType \| undefined` | Returns the configured type. |
| `getSize` | `getSize(): number \| undefined` | `number \| undefined` | Returns the configured size. |
| `getScale` | `getScale(): number \| undefined` | `number \| undefined` | Returns the configured scale. |
| `getNullable` | `getNullable(): boolean` | `boolean` | Returns `true` only when `nullable()` was called. |
| `getDefault` | `getDefault(): string \| boolean \| number \| undefined` | `string \| boolean \| number \| undefined` | Returns the configured default. |
| `isGenerated` | `isGenerated(): boolean` | `boolean` | Reports whether the column is a generated column. |
| `isGeneratedStored` | `isGeneratedStored(): boolean` | `boolean` | Reports whether the generated column is stored. |
| `getGeneratedExpression` | `getGeneratedExpression(): string \| undefined` | `string \| undefined` | Returns the generation expression. |
| `isIdentity` | `isIdentity(): boolean` | `boolean` | Reports whether the column is an identity column. |
| `getIdentityGeneration` | `getIdentityGeneration(): 'ALWAYS' \| 'BY DEFAULT' \| undefined` | `'ALWAYS' \| 'BY DEFAULT' \| undefined` | Returns the identity generation strategy. |
| `getIdentityOptions` | `getIdentityOptions(): IdentityOptions \| undefined` | `IdentityOptions \| undefined` | Returns the identity sequence options. |
| `getName` | `getName(): string` | `string` | Returns the column name. |
| `comment` | `comment(comment: string): this` | `this` | Sets the column comment; rendered as `COMMENT ON COLUMN`. |
| `getComment` | `getComment(): string \| undefined` | `string \| undefined` | Returns the column comment. |

**`identity()` behavior.** For `smallint`, `integer`, and `bigint` columns it emits
`GENERATED <ALWAYS | BY DEFAULT> AS IDENTITY` with the supplied sequence options. For `uuid`
columns it sets a default function instead:

| Argument | Default function | Extension required |
|----------|------------------|--------------------|
| `'v4'` | `uuid_generate_v4()` | `uuid-ossp` |
| `'v7'` | `uuid_generate_v7()` | `pg_uuidv7` |
| `undefined`, `'ALWAYS'`, `'BY DEFAULT'` | `gen_random_uuid()` | built-in (PostgreSQL 13+) |
| any other string | used verbatim as the generator expression | — |

**Identity options:**

| Option | Type | Description |
|--------|------|-------------|
| `start` | `number` | Starting value (`START WITH`). |
| `increment` | `number` | Sequence increment (`INCREMENT BY`). |
| `minValue` | `number` | Minimum value (`MINVALUE`). |
| `maxValue` | `number` | Maximum value (`MAXVALUE`). |
| `cache` | `number` | Cached sequence values (`CACHE`). |
| `cycle` | `boolean` | Whether the sequence cycles (`CYCLE`). |

**Value sets accepted by the signatures.** `ColumnType` accepts the column types listed in the
helper table above. `ReferentialAction` accepts
`'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION'`.

### IndexConstraint

Returned by `TableSchema.index()` and the only constraint class re-exported from the package root.
All builder methods are chainable and the object is registered on the table when it is created.

```typescript fragment
class IndexConstraint {
  column(...column: string[]): this;
  unique(): this;
  using(method: IndexMethod): this;
  where(condition: string): this;
  indexName(name: string): this;
  concurrent(): this;
  include(...columns: string[]): this;
  expression(expr: string): this;
  with(params: Record<string, string | number>): this;
  tablespace(name: string): this;
  isUnique(): boolean;
  getMethod(): IndexMethod | undefined;
  getWhere(): string | undefined;
  getIndexName(): string | undefined;
  getConcurrent(): boolean;
  getInclude(): string[] | undefined;
  getExpression(): string | undefined;
  getStorageParams(): Record<string, string | number> | undefined;
  getTablespace(): string | undefined;
  getColumns(): ColumnSchema<TableSchema>[];
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `column` | `column(...column: string[]): this` | `this` | Adds one or more table columns to the index. Throws when a column does not exist on the table. |
| `unique` | `unique(): this` | `this` | Marks the index `UNIQUE`. |
| `using` | `using(method: IndexMethod): this` | `this` | Sets the index method. |
| `where` | `where(condition: string): this` | `this` | Adds a partial-index predicate. |
| `indexName` | `indexName(name: string): this` | `this` | Sets an explicit index name; otherwise a deterministic name is derived from the table, columns, and position. |
| `concurrent` | `concurrent(): this` | `this` | Emits `CREATE INDEX CONCURRENTLY`. |
| `include` | `include(...columns: string[]): this` | `this` | Adds non-key `INCLUDE` columns. |
| `expression` | `expression(expr: string): this` | `this` | Renders an expression index instead of a column list. |
| `with` | `with(params: Record<string, string \| number>): this` | `this` | Sets storage parameters (`WITH (...)`). |
| `tablespace` | `tablespace(name: string): this` | `this` | Places the index in a tablespace. |
| `isUnique` | `isUnique(): boolean` | `boolean` | Reports whether the index is unique. |
| `getMethod` | `getMethod(): IndexMethod \| undefined` | `IndexMethod \| undefined` | Returns the configured method. |
| `getWhere` | `getWhere(): string \| undefined` | `string \| undefined` | Returns the partial-index predicate. |
| `getIndexName` | `getIndexName(): string \| undefined` | `string \| undefined` | Returns the explicit index name. |
| `getConcurrent` | `getConcurrent(): boolean` | `boolean` | Reports whether concurrent creation is enabled. |
| `getInclude` | `getInclude(): string[] \| undefined` | `string[] \| undefined` | Returns the `INCLUDE` columns. |
| `getExpression` | `getExpression(): string \| undefined` | `string \| undefined` | Returns the expression index body. |
| `getStorageParams` | `getStorageParams(): Record<string, string \| number> \| undefined` | `Record<string, string \| number> \| undefined` | Returns the storage parameters. |
| `getTablespace` | `getTablespace(): string \| undefined` | `string \| undefined` | Returns the tablespace. |
| `getColumns` | `getColumns(): ColumnSchema<TableSchema>[]` | `ColumnSchema<TableSchema>[]` | Returns the columns attached to the index. |

**`IndexMethod`:**

```typescript fragment
type IndexMethod =
  | 'btree'
  | 'hash'
  | 'gist'
  | 'gin'
  | 'brin'
  | 'spgist'
  | 'bloom';
```

```typescript
import { DatabaseSchema } from 'blendsdk/codegen';

const db = new DatabaseSchema('app');
const event = db.table('event');
event.bigint('id').primaryKey();
event.text('payload').nullable();

event
  .index()
  .indexName('event_payload_gin')
  .using('gin')
  .expression(`to_tsvector('english', payload)`)
  .with({ fastupdate: 'off' });
```

### Constraint Builder Objects

These objects are returned by `TableSchema` methods. `PrimaryKeyConstraint`, `UniqueConstraint`, and
`CheckConstraint` are not re-exported from the package root; obtain instances from the table.

#### PrimaryKeyConstraint

Returned by `TableSchema.primaryKey()`.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `column` | `column(...column: string[]): this` | `this` | Adds table columns to the primary key. Throws when a column does not exist. |
| `hasColumns` | `hasColumns(): boolean` | `boolean` | Reports whether any columns were added. |
| `getTable` | `getTable(): TableSchema` | `TableSchema` | Returns the owning table. |
| `getColumns` | `getColumns(): ColumnSchema<TableSchema>[]` | `ColumnSchema<TableSchema>[]` | Returns the primary-key columns. |

#### UniqueConstraint

Returned by `TableSchema.uniqueConstraint()` or created by `TableColumnSchema.unique()`.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `column` | `column(...column: string[]): this` | `this` | Adds table columns to the unique constraint. Throws when a column does not exist. |
| `hasColumns` | `hasColumns(): boolean` | `boolean` | Reports whether any columns were added. |
| `getTable` | `getTable(): TableSchema` | `TableSchema` | Returns the owning table. |
| `getColumns` | `getColumns(): ColumnSchema<TableSchema>[]` | `ColumnSchema<TableSchema>[]` | Returns the constrained columns. |

#### CheckConstraint

Returned by `TableSchema.getCheckConstraints()`; created through `checkConstraint()` or
`TableColumnSchema.check()`.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `getRule` | `getRule(): string` | `string` | Returns the constraint's check expression. |
| `column` | `column(...column: string[]): this` | `this` | Restricts the constraint to specific table columns. |
| `hasColumns` | `hasColumns(): boolean` | `boolean` | Reports whether any columns were attached. |
| `getTable` | `getTable(): TableSchema` | `TableSchema` | Returns the owning table. |
| `getColumns` | `getColumns(): ColumnSchema<TableSchema>[]` | `ColumnSchema<TableSchema>[]` | Returns the attached columns. |

#### ForeignKeyConstraint

Returned by `TableSchema.foreignKeyConstraint()` or `TableColumnSchema.references()`. Foreign keys
use `from()` / `to()` instead of `column()`; calling `column()` throws.

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `from` | `from(...column: string[]): this` | `this` | Sets the local (referencing) columns. |
| `to` | `to(...column: string[]): this` | `this` | Sets the referenced columns on `refTable`; throws when a column does not exist there. |
| `onUpdate` | `onUpdate(action: ReferentialAction \| undefined): this` | `this` | Sets `ON UPDATE`; defaults to `'CASCADE'`. |
| `onDelete` | `onDelete(action: ReferentialAction \| undefined): this` | `this` | Sets `ON DELETE`; defaults to `'RESTRICT'`. |
| `column` | `column(...column: string[]): this` | `never` | Always throws — use `from()` and `to()`. |
| `getRefTable` | `getRefTable(): TableSchema` | `TableSchema` | Returns the referenced table. |
| `getRefColumns` | `getRefColumns(): TableColumnSchema[]` | `TableColumnSchema[]` | Returns the referenced columns. |
| `getOnDelete` | `getOnDelete(): ReferentialAction` | `ReferentialAction` | Returns the delete action. |
| `getOnUpdate` | `getOnUpdate(): ReferentialAction` | `ReferentialAction` | Returns the update action. |
| `hasColumns` | `hasColumns(): boolean` | `boolean` | Reports whether local columns were added. |
| `getTable` | `getTable(): TableSchema` | `TableSchema` | Returns the owning table. |
| `getColumns` | `getColumns(): ColumnSchema<TableSchema>[]` | `ColumnSchema<TableSchema>[]` | Returns the local columns. |

---

## PostgreSQL Introspection API

Introspection reads an existing PostgreSQL catalog into a `SchemaContainer` so the generators can
emit types for databases that are not managed through the migration workflow.

### PostgreSQLIntrospector

```typescript fragment
class PostgreSQLIntrospector {
  constructor(db: PostgreSQLDatabase);
  introspect(schema: SchemaContainer, mapper?: ColumnMapper): Promise<void>;
  introstectConstantTypes(): Promise<ConstantType>;
  protected createTypes(
    schema: SchemaContainer,
    records: ColumnIntrospection[],
    mapper: ColumnMapper | undefined,
    index: Record<string, ObjectSchema>
  ): void;
  protected createEnumTypes(schema: SchemaContainer, records: ColumnIntrospection[]): void;
  protected mapPgTypeToTypescript(
    data: ColumnIntrospection,
    s: SchemaScope
  ): SchemaObject | null;
}
```

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `new PostgreSQLIntrospector(db: PostgreSQLDatabase)` | `PostgreSQLIntrospector` | Creates an introspector bound to a database client. |
| `introspect` | `introspect(schema: SchemaContainer, mapper?: ColumnMapper): Promise<void>` | `Promise<void>` | Reads the catalog (tables, partitioned tables, views, materialized views, composite types, enum types, domains) and registers one object schema per relation plus one enum schema per enum type in the container. The default `public` schema name is normalized away. |
| `introstectConstantTypes` | `introstectConstantTypes(): Promise<ConstantType>` | `Promise<ConstantType>` | Returns a `ConstantType` map of relation name → column names for tables, views, materialized views, and partitioned tables (note the method name's spelling in the API). |

**Mapping behavior.** Columns are mapped with `ColumnMapper` first, then through enum references
when the column type is an enum, then through the built-in PostgreSQL → TypeScript mapping. Columns
that cannot be mapped fall back to a `any` schema whose description is a `@deprecated` warning and
are logged to the console. Array columns are marked `.arrayed()`; nullable columns become
`.nullable().optional()`. Column defaults, primary keys, unique constraints, and check constraints
are appended to the schema descriptions as `@default`, `@primaryKey`, `@unique`, and `@checkContraint`
annotations. Every column also stores its raw catalog row under `metadata({ introspect: r })`.

**Built-in type mapping (excerpt):**

| PostgreSQL type | Schema object |
|-----------------|---------------|
| `bool` | `boolean` |
| `text`, `varchar`, `char`, `bpchar`, `name`, `uuid`, `inet`, `cidr`, `macaddr`, `macaddr8`, `money`, `bit`, `varbit`, `date`, `time`, `timetz`, `tsvector`, `tsquery`, `xid8`, `tid`, `pg_lsn`, `txid_snapshot`, `reg*` identifiers | `string` |
| `int2`, `int4`, `serial`, `float4`, `float8`, `oid`, `xid`, `cid` | `number` |
| `numeric`, `decimal`, `int8`, `bigserial` | `string` (precision preserved) |
| `timestamp`, `timestamptz` | `date` |

### ColumnMapper

```typescript fragment
type ColumnMapper = (r: ColumnIntrospection, s: SchemaScope) => SchemaObject | unknown;
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `r` | `ColumnIntrospection` | Yes | The raw catalog row for the column being mapped. |
| `s` | `SchemaScope` | Yes | The scope that will own the generated schema; use it to build replacement schemas. |

**Returns:** a `SchemaObject` to use for the column, or a falsy value to fall through to the built-in
mapping.

### ConstantType

```typescript fragment
interface ConstantType {
  [name: string]: string[];
}
```

Maps each relation name (for example `'public.customer'`) to its ordered column names. Consumed by
`CTypeGenerator`.

### ColumnIntrospection

One row per catalog column, as returned by the introspection query.

| Property | Type | Description |
|----------|------|-------------|
| `database_name` | `string` | Name of the introspected database. |
| `schema_name` | `string` | Schema of the relation. |
| `relation_name` | `string` | Relation (or type) name. |
| `relation_kind` | `'table' \| 'view' \| 'materialized view' \| 'partitioned table' \| 'foreign table' \| 'enum type' \| 'composite type'` | Kind of the catalog object. |
| `table_comment` | `string \| null` | Comment on the relation or type. |
| `column_name` | `string` | Column name (or enum label for enum rows). |
| `column_comment` | `string \| null` | Comment on the column. |
| `is_nullable` | `boolean` | Whether the column accepts `NULL`. |
| `has_default` | `boolean` | Whether the column has a default expression. |
| `column_default` | `string \| null` | The default expression text. |
| `pg_type` | `string` | Internal PostgreSQL type name. |
| `formatted_type` | `string` | SQL-formatted type name (e.g. `character varying(255)`). |
| `is_array` | `boolean` | Whether the column is an array. |
| `array_element_pg_type` | `string \| null` | Element type name for array columns. |
| `array_element_formatted_type` | `string \| null` | SQL-formatted element type for array columns. |
| `length` | `number \| null` | Length for `varchar`/`bpchar` columns. |
| `precision` | `number \| null` | Precision for `numeric` columns. |
| `scale` | `number \| null` | Scale for `numeric` columns. |
| `is_primary_key` | `boolean` | Whether the column participates in the primary key. |
| `is_unique` | `boolean` | Whether the column participates in a unique index. |
| `is_foreign_key` | `boolean` | Whether the column participates in a foreign key. |
| `fk_info` | `ForeignKeyInfo[] \| null` | Foreign-key metadata for the column. |
| `is_check_constrained` | `boolean` | Whether the column participates in a check constraint. |
| `check_constraints` | `CheckConstraintInfo[] \| null` | Check-constraint metadata for the column. |
| `is_enum` | `boolean` | Whether the column type is an enum. |
| `enum_type_name` | `string \| null` | Qualified enum type name (`schema.type`). |
| `enum_labels` | `string[] \| string \| null` | Enum labels in sort order. |
| `type_oid` | `number` | OID of the column's type. |

### ForeignKeyInfo

| Property | Type | Description |
|----------|------|-------------|
| `constraint_name` | `string` | Name of the foreign-key constraint. |
| `ref_schema` | `string` | Schema of the referenced table. |
| `ref_table` | `string` | Referenced table name. |
| `ref_columns` | `string[]` | Referenced column names. |
| `column_positions` | `number[]` | Positions of the local columns in the constraint. |
| `update_action` | `'NO ACTION' \| 'RESTRICT' \| 'CASCADE' \| 'SET NULL' \| 'SET DEFAULT'` | `ON UPDATE` action. |
| `delete_action` | `'NO ACTION' \| 'RESTRICT' \| 'CASCADE' \| 'SET NULL' \| 'SET DEFAULT'` | `ON DELETE` action. |
| `match_type` | `'SIMPLE' \| 'FULL' \| 'PARTIAL'` | Foreign-key match type. |

### CheckConstraintInfo

| Property | Type | Description |
|----------|------|-------------|
| `constraint_name` | `string` | Name of the check constraint. |
| `definition` | `string` | Constraint definition text. |

```typescript
import { PostgreSQLIntrospector, SchemaContainer, TypeGenerator } from 'blendsdk/codegen';
import type { PostgreSQLDatabase } from 'blendsdk/postgresql';

export async function generateTypes(db: PostgreSQLDatabase): Promise<string> {
  const schema = new SchemaContainer();
  await new PostgreSQLIntrospector(db).introspect(schema);
  return new TypeGenerator().generate(schema);
}
```

---

## Migration API

Generation compares the desired `DatabaseSchema` against the committed canonical snapshot and
publishes immutable, versioned SQL migrations with lineage headers plus the next snapshot.
Execution verifies local files against the applied ledger by exact checksum before running anything.
All failures surface as typed `MigrationError` values with credentials and SQL bodies redacted.

### defineMigrationConfig

```typescript fragment
function defineMigrationConfig(config: MigrationConfig): MigrationConfig;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `MigrationConfig` | Yes | — | The migration configuration literal. |

**Returns:** the same configuration object, ready to be the default export of
`blendsdk.migrations.ts`.

```typescript
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
  migrationsDir: './migrations',
  databaseUrlEnv: 'DATABASE_URL',
});
```

### generateBaseline

```typescript fragment
function generateBaseline(options: GenerateBaselineOptions): Promise<GenerateBaselineResult>;
```

Creates the first offline migration lineage: one complete baseline migration plus the canonical
snapshot. The operation refuses any existing snapshot or up-migration history and never opens a
database connection.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options.name` | `string` | Yes | — | Lowercase baseline slug, used in the migration file name. |
| `options.configPath` | `string` | No | discovered | Explicit configuration file or discovery directory. |
| `options.now` | `Date` | No | current time | Deterministic clock used by tests and embedding callers. |

**Returns:** `Promise<GenerateBaselineResult>`

| Property | Type | Description |
|----------|------|-------------|
| `status` | `'GENERATED'` | Successful baseline generation state. |
| `migration` | `MigrationDescriptor` | The one published initial migration. |
| `snapshotHash` | `string` | SHA-256 of the published canonical snapshot bytes. |
| `changes` | `readonly SchemaChange[]` | Complete desired-state additions rendered into the baseline. |

```typescript
import { generateBaseline } from 'blendsdk/codegen';

const result = await generateBaseline({ name: 'initial' });
console.log(result.status, result.snapshotHash, result.migration.id);
```

### generateMigration

```typescript fragment
function generateMigration(options: {
  name: string;
  configPath?: string;
  now?: Date;
}): Promise<{ status: 'GENERATED' | 'UP_TO_DATE' }>;
```

Compares the desired schema against the committed snapshot and, when they differ, publishes one
immutable migration and the next snapshot. When nothing changed, it reports `UP_TO_DATE` and writes
no files.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options.name` | `string` | Yes | — | Lowercase migration slug, used in the migration file name. |
| `options.configPath` | `string` | No | discovered | Explicit configuration file or discovery directory. |
| `options.now` | `Date` | No | current time | Deterministic clock used by tests and embedding callers. |

**Returns:** a generation result whose `status` is `'GENERATED'` when artifacts were published or
`'UP_TO_DATE'` when the snapshot already matched. Blocked changes (ambiguous renames, unsafe
columns, unsupported transitions) throw a typed error and leave all files byte-identical.

```typescript
import { generateMigration } from 'blendsdk/codegen';

const result = await generateMigration({ name: 'add-nickname' });
if (result.status === 'UP_TO_DATE') {
  console.log('Snapshot already matches the desired schema.');
}
```

### runMigrations

```typescript fragment
function runMigrations(options: RunMigrationsOptions): Promise<MigrationCommandResult>;
```

Executes the migration lifecycle against a target database: acquires a database-scoped advisory
lock, validates local files against the applied ledger prefix, runs pending work, and records exact
metadata. Transactions and execution timing are owned by the runner, never by migration bodies.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options.command` | `MigrationCommand` | Yes | — | One of `'up'`, `'down'`, `'status'`, `'validate'`. |
| `options.configPath` | `string` | No | discovered | Explicit configuration file or discovery directory. |
| `options.dryRun` | `boolean` | No | `false` | Reports the pending order without creating the ledger or executing SQL. |
| `options.allowDown` | `boolean` | No | `false` | Required confirmation for `'down'`; the command refuses to run without it. |
| `options.signal` | `AbortSignal` | No | — | Cancels active SQL and rolls back the open transaction; the runner reports `ABORTED`. |

**Returns:** `Promise<MigrationCommandResult>`

```typescript fragment
interface MigrationCommandResult {
  status: MigrationStatus;
  migrations: MigrationDescriptor[];
}
```

**Safety semantics:** local files and ledger rows must match as an exact ordered prefix; a lock wait
re-validates both pending and applied bytes before executing; `down` reverts exactly the latest
migration and its ledger row transactionally; nontransactional migrations are tracked through a
durable dirty marker (`NONTRANSACTIONAL_DIRTY`) until the outcome is known.

```typescript
import { runMigrations } from 'blendsdk/codegen';

const result = await runMigrations({
  command: 'up',
  configPath: './blendsdk.migrations.ts',
});

console.log(result.status, result.migrations.map(migration => migration.id));
```

### getMigrationStatus

```typescript fragment
function getMigrationStatus(options: RunMigrationsOptions): Promise<MigrationCommandResult>;
```

Reads the current migration status from local history and the applied ledger without executing any
migration SQL. Accepts the same options object as `runMigrations`.

**Returns:** `Promise<MigrationCommandResult>` — the reported `status` is one of the
`MigrationStatus` values below, and `migrations` lists the descriptors that are pending or in
question.

### validateMigrations

```typescript fragment
function validateMigrations(options: RunMigrationsOptions): Promise<MigrationCommandResult>;
```

Validates local migration history — file identity, checksums, ordering, and lineage — against the
applied ledger prefix. Designed to run as a CI gate, including without a reachable database.

**Returns:** `Promise<MigrationCommandResult>` — `UP_TO_DATE` when history is valid, `PENDING` when
migrations are awaiting execution, or `INVALID_HISTORY` when files or rows do not match.

```typescript
import { validateMigrations } from 'blendsdk/codegen';

const result = await validateMigrations({ command: 'validate' });
if (result.status === 'INVALID_HISTORY') {
  process.exitCode = 1;
}
```

### adoptBaseline

```typescript fragment
function adoptBaseline(
  options: AdoptBaselineOptions,
  hooks?: { afterPreview?: (preview: AdoptionPreview) => void | string | Promise<void | string> }
): Promise<{ status: 'ADOPTED'; comparison: AdoptionComparisonItem[] }>;
```

Records the initial lineage of an existing database — without running the baseline DDL — only after
a structural catalog comparison proves the live schema matches the generated baseline. Adoption
takes the same advisory lock as `up`, re-verifies the preview inside the authoritative transaction,
and refuses drift, unsupported shapes, and nonempty history without mutating anything.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `options.configPath` | `string` | No | discovered | Explicit configuration file or discovery directory. |
| `options.confirmation` | `string` | No | — | Exact `<database>/<baseline-id>` DDL-quiescence confirmation token. When omitted, the token is collected through the `afterPreview` hook. |
| `hooks.afterPreview` | `(preview: AdoptionPreview) => void \| string \| Promise<void \| string>` | No | — | Called with the sanitized target preview before the transaction begins. Return the confirmation token (or a promise for it) to continue; throwing aborts adoption. |

**Returns:** a result with `status: 'ADOPTED'` and a `comparison` report. A wrong or missing
confirmation token for the target database is a `CONFIGURATION` error (exit code 2) and mutates
nothing.

```typescript
import { adoptBaseline } from 'blendsdk/codegen';

const result = await adoptBaseline(
  { configPath: './blendsdk.migrations.ts' },
  {
    afterPreview: preview => `${preview.database}/${preview.baselineId}`,
  }
);

console.log(result.status, result.comparison.length);
```

### MigrationError

```typescript fragment
class MigrationError extends Error {
  constructor(options: {
    kind: MigrationErrorKind;
    exitCode: MigrationExitCode;
    message: string;
    sensitiveDetail?: string;
  });
  readonly kind: MigrationErrorKind;
  readonly exitCode: MigrationExitCode;
  message: string;
}
```

| Constructor option | Type | Required | Description |
|--------------------|------|----------|-------------|
| `kind` | `MigrationErrorKind` | Yes | Stable failure classification. |
| `exitCode` | `MigrationExitCode` | Yes | Process exit class (`0`, `1`, or `2`). |
| `message` | `string` | Yes | Operator-facing message. Database URLs and credential assignments are redacted at the error boundary. |
| `sensitiveDetail` | `string` | No | SQL body or other sensitive detail that must never appear in rendered output. |

### formatMigrationError

```typescript fragment
function formatMigrationError(error: MigrationError): string;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `error` | `MigrationError` | Yes | — | The typed migration failure to render. |

**Returns:** `string` — a stable `"<KIND>: <message>"` line with credentials and SQL redacted, for
example `DATABASE: Connection [REDACTED_DATABASE_URL] failed with password=[REDACTED]`.

```typescript
import { formatMigrationError, MigrationError, runMigrations } from 'blendsdk/codegen';

try {
  await runMigrations({ command: 'up' });
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(formatMigrationError(error));
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
```

### Migration Types and Values

#### MigrationCommand

```typescript fragment
type MigrationCommand = 'up' | 'down' | 'status' | 'validate';
```

#### MigrationStatus

| Value | Meaning |
|-------|---------|
| `UP_TO_DATE` | Local history matches the applied ledger prefix exactly. |
| `PENDING` | One or more local migrations have not been applied. |
| `INVALID_HISTORY` | Files, checksums, ordering, or lineage do not match the ledger. |
| `LOCKED` | Another migration session holds the database-scoped advisory lock. |
| `UNKNOWN_OUTCOME` | A nontransactional migration is marked dirty; its outcome must be inspected manually. |

#### MigrationSafety

| Value | Meaning |
|-------|---------|
| `safe` | Change is rendered without extra requirements. |
| `caution` | Change needs manual attention (for example adding a required column); rendering blocks until guidance is followed. |
| `destructive` | Change removes data or objects; requires explicit destructive approval. |
| `unsupported` | Change cannot be expressed safely; generation fails with manual guidance. |
| `ambiguous` | An apparent rename or replacement that requires explicit rename hints. |

#### MigrationExitCode

| Value | Meaning |
|-------|---------|
| `0` | Success. |
| `1` | Operational failure (invalid history, database, lock, filesystem, unsupported state). |
| `2` | Usage or configuration failure. |

#### MigrationErrorKind

| Value | Meaning |
|-------|---------|
| `CONFIGURATION` | Invalid configuration, unsafe artifact paths, or a missing confirmation token. |
| `INVALID_HISTORY` | Migration files, snapshots, or ledger rows fail validation. |
| `DATABASE` | A database operation failed or the connection was lost. |
| `LOCKED` | The migration lock could not be acquired before the deadline. |
| `UNKNOWN_OUTCOME` | A nontransactional migration completed without a verifiable result. |
| `ABORTED` | Execution was cancelled through an `AbortSignal`. |
| `UNSUPPORTED` | The catalog or desired state cannot be handled safely. |
| `FILESYSTEM` | Artifact publication or file inspection failed. |

#### MigrationConfig

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `schema` | `string` | No | Path to the schema module that default-exports a `DatabaseSchema`. Loaded only by generation commands. |
| `migrationsDir` | `string` | No | Directory that stores migration files. Must be relative, inside the configuration directory, and not a symlink. |
| `snapshotFile` | `string` | No | Path to the canonical snapshot; defaults to `schema.snapshot.json` inside `migrationsDir`. |
| `databaseUrlEnv` | `string` | No | Name of the environment variable that holds the database URL; defaults to `'DATABASE_URL'` and must be a valid environment-variable name. |
| `lockTimeoutMs` | `number` | No | Deadline for acquiring the advisory lock; must be greater than zero. |
| `statementTimeoutMs` | `number` | No | PostgreSQL statement timeout applied to the migration session. |

Validation rules applied when the configuration is loaded:

- Unknown keys are rejected.
- `lockTimeoutMs: 0` (and other invalid values) is rejected.
- `databaseUrlEnv` must be a valid environment-variable name.
- `migrationsDir` may not traverse outside the configuration directory, may not be a filesystem root, and may not resolve through a symlink.
- Execution-only commands do not execute the configured schema module.

#### ResolvedMigrationConfig

| Property | Type | Description |
|----------|------|-------------|
| `configPath` | `string` | Absolute path of the loaded configuration file. |
| `configDirectory` | `string` | Directory that anchors all relative artifact paths. |
| `schema` | `string \| undefined` | Absolute path of the schema module, when configured. |
| `migrationsDir` | `string` | Absolute migrations directory. |
| `snapshotFile` | `string` | Absolute snapshot path. |
| `databaseUrlEnv` | `string` | Environment-variable name holding the database URL. Never the URL itself. |
| `lockTimeoutMs` | `number` | Effective lock deadline in milliseconds. |
| `statementTimeoutMs` | `number` | Effective statement timeout in milliseconds. |

#### MigrationDescriptor

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Sortable identifier (`<timestamp>_<slug>`). |
| `upPath` | `string` | Absolute path of the up migration file. |
| `downPath` | `string \| undefined` | Absolute path of the down migration file, when present. |
| `checksum` | `string` | SHA-256 of the exact up-file bytes. |
| `transactional` | `boolean` | Whether the migration body runs inside a transaction. |
| `fromSnapshot` | `string \| undefined` | Snapshot hash this migration starts from; `undefined` for manual migrations. |
| `toSnapshot` | `string \| undefined` | Snapshot hash this migration produces; `undefined` for manual migrations. |

#### RunMigrationsOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `command` | `MigrationCommand` | Yes | Lifecycle command to execute. |
| `configPath` | `string` | No | Explicit configuration file or discovery directory. |
| `dryRun` | `boolean` | No | Preview pending order without side effects. |
| `allowDown` | `boolean` | No | Explicit confirmation required by the `'down'` command. |
| `signal` | `AbortSignal` | No | Cancellation signal for active work. |

#### GenerateBaselineOptions / AdoptBaselineOptions / AdoptionPreview

| Type | Property | Type | Description |
|------|----------|------|-------------|
| `GenerateBaselineOptions` | `name` | `string` | Lowercase baseline slug. |
| `GenerateBaselineOptions` | `configPath` | `string \| undefined` | Explicit configuration file or discovery directory. |
| `GenerateBaselineOptions` | `now` | `Date \| undefined` | Deterministic clock. |
| `AdoptBaselineOptions` | `configPath` | `string \| undefined` | Explicit configuration file or discovery directory. |
| `AdoptBaselineOptions` | `confirmation` | `string \| undefined` | Exact `<database>/<baseline-id>` DDL-quiescence confirmation token. |
| `AdoptionPreview` | `host` | `string` | Target host without password or URL query values. |
| `AdoptionPreview` | `port` | `string` | Target PostgreSQL port. |
| `AdoptionPreview` | `user` | `string` | Target role name without its password. |
| `AdoptionPreview` | `database` | `string` | Target database name. |
| `AdoptionPreview` | `baselineId` | `string` | Initial migration identifier that will be recorded. |

#### Adoption Comparison Items

The `comparison` array returned by `adoptBaseline` contains one item per checked object. Identities
are qualified and deterministically ordered; raw desired SQL is never included in the report.

| Property | Type | Description |
|----------|------|-------------|
| `classification` | `'MATCH' \| 'DIFFERENT' \| 'MISSING' \| 'EXTRA_MODELED' \| 'UNMANAGED' \| 'UNSUPPORTED_FOR_ADOPTION'` | Comparison outcome for the item. |
| `identity` | `string` | Qualified identity, for example `table.public.customer` or `column.public.customer.name`. |

### Migration CLI

The package ships the `blendsdk migrate` executable (`src/cli.ts`). Commands map outcomes to exit
codes `0`, `1`, and `2`; diagnostics are redacted and never include credentials, SQL bodies, or a
stack trace. The CLI exposes exactly eight lifecycle commands and no repair/force bypass.

| Command | Purpose |
|---------|---------|
| `baseline <name>` | Create the first offline migration lineage and canonical snapshot. |
| `generate <name>` | Diff the desired schema against the snapshot and publish one migration plus the next snapshot. |
| `create <name>` | Create a manual up/down migration pair with null lineage. |
| `up` | Apply pending migrations. |
| `down` | Revert exactly the latest applied migration (requires confirmation). |
| `status` | Report the current `MigrationStatus`. |
| `validate` | Validate local history; supports offline operation. |
| `adopt-baseline` | Record the initial lineage of an existing database after structural proof. |

Common flags: `--help` for every command, `--config <path>` to select the configuration file, and
`--offline` for validation without a database connection.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
