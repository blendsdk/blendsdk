> **Package**: `blendsdk/blendscript`

# blendscript API Reference

This document is the complete reference for the public surface of `blendsdk/blendscript`. The runtime namespace contains exactly four values — three functions and one error class — and every other export is a type that describes options, contracts, results, or diagnostics. Expression-authoring problems and record-data problems are returned as frozen, structured diagnostics; only programmer misuse throws `BlendScriptApiError`.

| Runtime Export | Kind | Summary |
|----------------|------|---------|
| `validateExpression` | Function | Checks source syntax and types against an explicit schema. |
| `compileExpression` | Function | Checks source and compiles it into a fresh, reusable opaque handle. |
| `evaluateExpression` | Function | Evaluates a compiled handle against one complete schema-shaped record. |
| `BlendScriptApiError` | Class | Thrown for programmer misuse; carries a stable machine-readable code. |

| Type Export | Kind | Summary |
|-------------|------|---------|
| `ExpressionValue` | Type alias | A scalar value understood and returned by BlendScript. |
| `ExpressionValueType` | Type alias | Public name of a concrete runtime value type. |
| `ExpressionFieldType` | Type alias | A non-null field type accepted in a schema declaration. |
| `ExpressionFieldSchema` | Interface | Describes one field that an expression may reference. |
| `ExpressionSchema` | Type alias | Maps exact field names to declared value shapes. |
| `ExpressionOptions` | Interface | Options shared by validation and compilation. |
| `InferredExpressionType` | Type alias | The scalar type and nullability inferred from an expression. |
| `CompiledExpression` | Interface | An opaque, reusable expression returned by `compileExpression`. |
| `SourceSpan` | Interface | Zero-based, half-open range in UTF-16 source code units. |
| `SourceLocation` | Interface | One-based source coordinates derived from a span. |
| `SourceExpressionDiagnostic` | Interface | A source-authored failure with an exact location. |
| `RecordExpressionDiagnostic` | Interface | A runtime record failure associated with one declared field. |
| `ExpressionDiagnostic` | Type alias | Union of the two diagnostic interfaces. |
| `ExpressionDiagnosticCode` | Type alias | Every stable diagnostic code. |
| `RecordExpressionDiagnosticCode` | Type alias | Codes that identify a record-field problem. |
| `RecordDiagnosticReason` | Type alias | Machine-readable reasons a record field failed validation. |
| `RuntimeValueType` | Type alias | Precise runtime classification of a rejected value. |
| `BlendScriptApiErrorCode` | Type alias | Codes thrown for programmer misuse. |
| `ValidationResult` | Type alias | Result of `validateExpression`. |
| `CompilationResult` | Type alias | Result of `compileExpression`. |
| `EvaluationResult` | Type alias | Result of `evaluateExpression`. |

---

## Functions

| Function | Signature | Returns | Description |
|----------|-----------|---------|-------------|
| `validateExpression` | `(source: string, options: ExpressionOptions) => ValidationResult` | `ValidationResult` | Lexes, parses, and statically analyzes source without retaining state. |
| `compileExpression` | `(source: string, options: ExpressionOptions) => CompilationResult` | `CompilationResult` | Runs the same pipeline and creates a fresh opaque handle on success. |
| `evaluateExpression` | `(expression: CompiledExpression, data: Readonly<Record<string, ExpressionValue>>) => EvaluationResult` | `EvaluationResult` | Interprets a compiled handle against one validated record snapshot. |

### validateExpression

```typescript fragment
function validateExpression(source: string, options: ExpressionOptions): ValidationResult
```

Runs the full lexing, parsing, and static schema-analysis pipeline and returns a frozen result. It retains no executable state: use it while a rule is authored, and call `compileExpression` with the same options to obtain an evaluable handle. `validateExpression` and `compileExpression` share one normalized pipeline, so the same input produces identical `resultType`, `referencedFields`, and diagnostics from both.

Authored-formula problems are never thrown — they are returned in `diagnostics`.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source` | `string` | Yes | — | Expression text to check. A non-string value throws `BlendScriptApiError` with `BS_INVALID_ARGUMENT`. |
| `options` | `ExpressionOptions` | Yes | — | Caller-materialized options object providing the explicit `schema` and an optional `expectedResult`. |

**Returns**: `ValidationResult`

- Success — `{ ok: true, resultType, referencedFields }`.
- Failure — `{ ok: false, diagnostics }` containing 1 to 20 source diagnostics in deterministic order.

**Throws**: `BlendScriptApiError` — `BS_INVALID_ARGUMENT`, `BS_INVALID_OPTIONS`, `BS_INVALID_SCHEMA`, or `BS_SCHEMA_FIELD_LIMIT_EXCEEDED`.

**Example**

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const result = validateExpression('Country == "NL" AND [Order Total] >= 1000', {
  schema: {
    Country: { type: 'string' },
    'Order Total': { type: 'number' },
  },
  expectedResult: 'boolean',
});

if (!result.ok) {
  const [first] = result.diagnostics;
  throw new Error(first ? `${first.code}: ${first.message}` : 'Validation failed.');
}

console.log(result.resultType); // { type: 'boolean', nullable: false }
console.log(result.referencedFields); // [ 'Country', 'Order Total' ]
```

### compileExpression

```typescript fragment
function compileExpression(source: string, options: ExpressionOptions): CompilationResult
```

Runs the same normalized pipeline as `validateExpression` and, on success, creates a fresh opaque `CompiledExpression` handle backed by a private payload. Every call returns a new handle — handles are never interned or reused across calls. The handle is valid only in the loaded package instance that created it; to persist a rule, store the source text and compile it again after loading.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `source` | `string` | Yes | — | Expression text to check and compile. A non-string value throws `BlendScriptApiError` with `BS_INVALID_ARGUMENT`. |
| `options` | `ExpressionOptions` | Yes | — | Caller-materialized options object providing the explicit `schema` and an optional `expectedResult`. |

**Returns**: `CompilationResult`

- Success — `{ ok: true, expression, resultType, referencedFields }`.
- Failure — `{ ok: false, diagnostics }` containing 1 to 20 source diagnostics in deterministic order.

**Throws**: `BlendScriptApiError` — `BS_INVALID_ARGUMENT`, `BS_INVALID_OPTIONS`, `BS_INVALID_SCHEMA`, or `BS_SCHEMA_FIELD_LIMIT_EXCEEDED`.

**Example**

```typescript
import { compileExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Enabled AND NOT Locked', {
  schema: { Enabled: { type: 'boolean' }, Locked: { type: 'boolean' } },
  expectedResult: 'boolean',
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

console.log(compilation.resultType); // { type: 'boolean', nullable: false }
console.log(compilation.referencedFields); // [ 'Enabled', 'Locked' ]
```

### evaluateExpression

```typescript fragment
function evaluateExpression(
  expression: CompiledExpression,
  data: Readonly<Record<string, ExpressionValue>>
): EvaluationResult
```

Interprets the handle's private immutable AST against a validated snapshot of one record. Before evaluation, every declared schema field is validated strictly in captured schema order — including fields the expression never references. Undeclared extras are ignored and never read, record accessors (getters) are never invoked, and the input record is never mutated. A failed evaluation leaves both the handle and the record unchanged, so the same handle can be reused for any number of records.

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `expression` | `CompiledExpression` | Yes | — | A handle created by `compileExpression` in the same loaded package instance. |
| `data` | `Readonly<Record<string, ExpressionValue>>` | Yes | — | Caller-materialized ordinary object containing one own data property per declared field. |

**Returns**: `EvaluationResult` — `{ ok: true, value }` or `{ ok: false, diagnostic }`. The diagnostic is a `RecordExpressionDiagnostic` when the record fails validation, or a `SourceExpressionDiagnostic` for evaluation-time failures (`BS_NULL_NOT_ALLOWED`, `BS_STRING_VALUE_LIMIT_EXCEEDED`, `BS_EVALUATION_STEP_LIMIT_EXCEEDED`).

**Throws**: `BlendScriptApiError` with `BS_INVALID_COMPILED_EXPRESSION` for a forged or foreign handle, and `BS_INVALID_ARGUMENT` when `data` is not a caller-materialized ordinary object (`null`, an array, a class instance, or an object with a custom prototype chain).

**Example**

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const accepted = evaluateExpression(compilation.expression, { Country: 'NL', OrderTotal: 1250 });
if (accepted.ok) console.log(accepted.value); // true

const incomplete = evaluateExpression(compilation.expression, { Country: 'NL' });
if (!incomplete.ok && incomplete.diagnostic.kind === 'record') {
  console.log(incomplete.diagnostic.code); // 'BS_MISSING_FIELD'
  console.log(incomplete.diagnostic.field); // 'OrderTotal'
}
```

---

## Classes

### BlendScriptApiError

```typescript fragment
class BlendScriptApiError extends Error {
  public readonly code: BlendScriptApiErrorCode;

  public constructor(code: BlendScriptApiErrorCode, message: string);
}
```

The package's only runtime error type. It is thrown exclusively for programmer misuse: invalid API arguments, invalid schemas or options, a forged or foreign compiled handle, or a schema that exceeds the field-count limit. Expression-authoring problems and record-data problems are always returned as diagnostics, never thrown.

**Constructor parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `code` | `BlendScriptApiErrorCode` | Yes | — | Stable machine-readable programmer-error code. |
| `message` | `string` | Yes | — | Human-readable description of the misuse. |

**Properties**

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Always `'BlendScriptApiError'`. |
| `message` | `string` | Inherited from `Error`; the human-readable description. |
| `code` | `BlendScriptApiErrorCode` | Stable machine-readable programmer-error code. |

**Example**

```typescript
import { BlendScriptApiError, validateExpression } from 'blendsdk/blendscript';

try {
  validateExpression('TRUE', {
    schema: { constructor: { type: 'boolean' } },
  });
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.error(error.code); // 'BS_INVALID_SCHEMA'
    console.error(error.message); // 'Schema field "constructor" is reserved for safety.'
  }
}
```

---

## Value and Option Types

### ExpressionValue

```typescript fragment
type ExpressionValue = string | number | boolean | null;
```

| Member | Notes |
|--------|-------|
| `string` | Any UTF-16 string up to the 4,096 unit runtime cap. |
| `number` | Must be finite at runtime; `NaN` and ±Infinity are rejected by record validation. |
| `boolean` | `true` or `false`. |
| `null` | Explicit absence; accepted only for a declared nullable field. |

### ExpressionValueType

```typescript fragment
type ExpressionValueType = 'string' | 'number' | 'boolean' | 'null';
```

The public name of a concrete BlendScript runtime value type. Used by `expectedResult` on `ExpressionOptions`.

| Value | Meaning |
|-------|---------|
| `'string'` | String result. |
| `'number'` | Finite numeric result. |
| `'boolean'` | Boolean result. |
| `'null'` | The type of the `NULL` literal itself. |

### ExpressionFieldType

```typescript fragment
type ExpressionFieldType = Exclude<ExpressionValueType, 'null'> | 'scalar';
// Equivalent to: 'string' | 'number' | 'boolean' | 'scalar'
```

| Value | Runtime values accepted for the field |
|-------|--------------------------------------|
| `'string'` | Strings up to 4,096 UTF-16 code units. |
| `'number'` | Finite numbers. |
| `'boolean'` | Booleans. |
| `'scalar'` | Strings or finite numbers, preserved exactly without normalization. Direct scalar use in operators and built-ins is a static `BS_TYPE_MISMATCH`; convert explicitly with `text(...)` or `tryNumber(...)` first. |

### ExpressionFieldSchema

```typescript fragment
interface ExpressionFieldSchema {
  readonly type: ExpressionFieldType;
  readonly nullable?: boolean;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ExpressionFieldType` | Required. The primitive value, or string-or-finite-number scalar, required for this field. |
| `nullable` | `boolean` | Optional; defaults to `false`. When `true`, the record may explicitly contain `null` for this field. |

Field descriptors are validated at the API boundary; violations throw `BlendScriptApiError` with `BS_INVALID_SCHEMA`:

- Must be a caller-materialized ordinary object (object literal or `Object.create(null)`).
- Only the members `type` and `nullable` are allowed.
- Only own data properties are allowed; accessor properties are rejected without being invoked.
- `nullable`, when present, must be a boolean.

### ExpressionSchema

```typescript fragment
type ExpressionSchema = Readonly<Record<string, Readonly<ExpressionFieldSchema>>>;
```

Maps exact field names to their declared value shapes. Key rules:

| Rule | Detail |
|------|--------|
| Materialization | Must be a caller-materialized ordinary object. Class instances, arrays, and objects with a custom prototype are rejected with `BS_INVALID_SCHEMA`. |
| Keys | Own string keys only; symbol keys are rejected. |
| Length | Each key must be 1 to 256 UTF-16 code units. |
| Reserved keys | `__proto__`, `prototype`, and `constructor` are rejected for safety. |
| Count | At most 1,024 fields; more throws `BS_SCHEMA_FIELD_LIMIT_EXCEEDED`. |
| Accessors | Accessor properties are rejected without being invoked. |
| Snapshot | The schema is copied at the API boundary; later caller mutations have no effect. |

### ExpressionOptions

```typescript fragment
interface ExpressionOptions {
  readonly schema: ExpressionSchema;
  readonly expectedResult?: ExpressionValueType;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `schema` | `ExpressionSchema` | Required. The complete set of fields available to the expression. Referencing an undeclared field fails with `BS_UNKNOWN_FIELD`. |
| `expectedResult` | `ExpressionValueType` | Optional. When provided, the inferred `resultType` must match exactly, and the result must not be able to produce `null` — the only exception is the literal-null type accepted for `expectedResult: 'null'`. Mismatches fail with `BS_EXPECTED_RESULT_TYPE_MISMATCH`. |

The options container is validated like the schema: only the members `schema` and `expectedResult` are allowed, they must be own data properties, and `schema` is mandatory. Violations throw `BlendScriptApiError` with `BS_INVALID_OPTIONS`.

**Example**

```typescript
import { compileExpression, type ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Status: { type: 'string' },
    Note: { type: 'string', nullable: true },
    ItemCode: { type: 'scalar' },
  },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Note == NULL OR contains(Status, "active")', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

console.log(compilation.referencedFields); // [ 'Note', 'Status' ]
```

### InferredExpressionType

```typescript fragment
type InferredExpressionType =
  | Readonly<{ type: ExpressionFieldType; nullable: boolean }>
  | Readonly<{ type: 'null'; nullable: true }>;
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ExpressionFieldType \| 'null'` | The inferred result type. `'scalar'` appears when the expression returns a scalar field directly; `'null'` appears only for the `NULL` literal. |
| `nullable` | `boolean` | Whether the result may be `null` at runtime. Always `true` when `type` is `'null'`. |

Representative inference results:

| Source | Inferred `resultType` |
|--------|----------------------|
| `TRUE` | `{ type: 'boolean', nullable: false }` |
| `42` | `{ type: 'number', nullable: false }` |
| `NULL` | `{ type: 'null', nullable: true }` |
| Field `Text: { type: 'string', nullable: true }` referenced directly | `{ type: 'string', nullable: true }` |
| `Item` where `Item` is declared `scalar` | `{ type: 'scalar', nullable: false }` |
| `tryNumber(Item)` where `Item` is declared `scalar` | `{ type: 'number', nullable: true }` |
| `text(Item)` where `Item` is declared `scalar` | `{ type: 'string', nullable: false }` |

### CompiledExpression

```typescript fragment
interface CompiledExpression {
  readonly [compiledExpressionBrand]: true;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `[compiledExpressionBrand]` | `true` | Declaration-only brand carried by a unique symbol that is intentionally not exported. The brand prevents structural construction in TypeScript. |

Notes:

- Created only by `compileExpression`; every successful call produces a distinct frozen handle backed by a private payload (source, AST, inferred type, referenced fields, and the schema snapshot).
- The handle is valid only in the loaded package instance that created it. A handle from another package copy — for example, the direct build versus the umbrella build — is rejected.
- Handles cannot be serialized, transferred, or forged. Passing any value that was not produced by this package instance to `evaluateExpression` throws `BlendScriptApiError` with `BS_INVALID_COMPILED_EXPRESSION`.
- To persist a rule, keep the original source text and compile it again after loading.

---

## Result Types

All result objects, their arrays, and every nested diagnostic are frozen. Results are discriminated unions: a single `ok` check narrows the type.

### ValidationResult

```typescript fragment
type ValidationResult =
  | Readonly<{
      ok: true;
      resultType: InferredExpressionType;
      referencedFields: readonly string[];
    }>
  | Readonly<{ ok: false; diagnostics: readonly SourceExpressionDiagnostic[] }>;
```

| Property | Type | Present when | Description |
|----------|------|--------------|-------------|
| `ok` | `true \| false` | Always | Discriminant. |
| `resultType` | `InferredExpressionType` | `ok: true` | Inferred result type of the expression. |
| `referencedFields` | `readonly string[]` | `ok: true` | Distinct referenced field names in first-source-occurrence order; empty when no field is referenced. |
| `diagnostics` | `readonly SourceExpressionDiagnostic[]` | `ok: false` | One to twenty source diagnostics in deterministic order. |

### CompilationResult

```typescript fragment
type CompilationResult =
  | Readonly<{
      ok: true;
      expression: CompiledExpression;
      resultType: InferredExpressionType;
      referencedFields: readonly string[];
    }>
  | Readonly<{ ok: false; diagnostics: readonly SourceExpressionDiagnostic[] }>;
```

| Property | Type | Present when | Description |
|----------|------|--------------|-------------|
| `ok` | `true \| false` | Always | Discriminant. |
| `expression` | `CompiledExpression` | `ok: true` | A fresh opaque handle for `evaluateExpression`. |
| `resultType` | `InferredExpressionType` | `ok: true` | Inferred result type of the expression. |
| `referencedFields` | `readonly string[]` | `ok: true` | Distinct referenced field names in first-source-occurrence order. |
| `diagnostics` | `readonly SourceExpressionDiagnostic[]` | `ok: false` | One to twenty source diagnostics in deterministic order. |

### EvaluationResult

```typescript fragment
type EvaluationResult =
  | Readonly<{ ok: true; value: ExpressionValue }>
  | Readonly<{ ok: false; diagnostic: ExpressionDiagnostic }>;
```

| Property | Type | Present when | Description |
|----------|------|--------------|-------------|
| `ok` | `true \| false` | Always | Discriminant. |
| `value` | `ExpressionValue` | `ok: true` | The expression result: string, finite number, boolean, or `null`. |
| `diagnostic` | `ExpressionDiagnostic` | `ok: false` | A record diagnostic when the record failed validation, or a source diagnostic for an evaluation-time failure. |

---

## Diagnostics

### ExpressionDiagnostic

```typescript fragment
type ExpressionDiagnostic = SourceExpressionDiagnostic | RecordExpressionDiagnostic;
```

Discriminate with the `kind` member:

| `kind` | Interface | Emitted when |
|--------|-----------|--------------|
| `'source'` | `SourceExpressionDiagnostic` | Validation/compilation diagnostics, and evaluation-time failures such as null misuse, derived string caps, or the step limit. |
| `'record'` | `RecordExpressionDiagnostic` | A declared record field fails pre-evaluation validation. |

### SourceSpan

```typescript fragment
interface SourceSpan {
  readonly start: number;
  readonly end: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `start` | `number` | Inclusive zero-based start offset in UTF-16 code units. |
| `end` | `number` | Exclusive end offset in UTF-16 code units. |

### SourceLocation

```typescript fragment
interface SourceLocation {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `line` | `number` | One-based line containing the start offset. |
| `column` | `number` | One-based UTF-16 column containing the start offset. |
| `endLine` | `number` | One-based line containing the exclusive end offset. |
| `endColumn` | `number` | One-based UTF-16 column containing the exclusive end offset. |

Line counting treats CRLF as one break, and also counts LF, U+2028, and U+2029 as line breaks.

### SourceExpressionDiagnostic

```typescript fragment
interface SourceExpressionDiagnostic {
  readonly kind: 'source';
  readonly code: Exclude<
    ExpressionDiagnosticCode,
    'BS_MISSING_FIELD' | 'BS_RUNTIME_TYPE_MISMATCH'
  >;
  readonly severity: 'error';
  readonly message: string;
  readonly span: SourceSpan;
  readonly location: SourceLocation;
  readonly excerpt?: string;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'source'` | Discriminant identifying a source diagnostic. |
| `code` | `Exclude<ExpressionDiagnosticCode, 'BS_MISSING_FIELD' \| 'BS_RUNTIME_TYPE_MISMATCH'>` | Stable machine-readable failure code; every code except the two record-only codes. |
| `severity` | `'error'` | All v1 diagnostics are errors. |
| `message` | `string` | Concise guidance intended for the expression author. |
| `span` | `SourceSpan` | Exact zero-based, half-open source range the message refers to. |
| `location` | `SourceLocation` | One-based line and UTF-16 column coordinates derived from `span`. |
| `excerpt` | `string` | Optional bounded source excerpt of up to 120 UTF-16 code units, present only when non-empty. |

### RecordExpressionDiagnostic

```typescript fragment
interface RecordExpressionDiagnostic {
  readonly kind: 'record';
  readonly code: RecordExpressionDiagnosticCode;
  readonly severity: 'error';
  readonly message: string;
  readonly field: string;
  readonly reason: RecordDiagnosticReason;
  readonly expectedType: ExpressionFieldType;
  readonly nullable: boolean;
  readonly actualType: RuntimeValueType;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'record'` | Discriminant identifying a record diagnostic. |
| `code` | `RecordExpressionDiagnosticCode` | Stable machine-readable record failure code. |
| `severity` | `'error'` | All v1 diagnostics are errors. |
| `message` | `string` | Concise guidance that never includes the record value. |
| `field` | `string` | Exact schema field whose record value failed validation. |
| `reason` | `RecordDiagnosticReason` | Machine-readable category of the failure. |
| `expectedType` | `ExpressionFieldType` | Declared schema type the record value was checked against. |
| `nullable` | `boolean` | Declared nullability of the failing field. |
| `actualType` | `RuntimeValueType` | Precise runtime classification of the rejected value, never its content. |

A record diagnostic has exactly these nine own members and never carries the rejected value, its string content, or any property such as `actualValue`.

**Example**

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Item == "AB"', {
  schema: { Item: { type: 'string', nullable: true } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, { Item: 42 });
if (!result.ok && result.diagnostic.kind === 'record') {
  const { code, field, reason, expectedType, nullable, actualType } = result.diagnostic;
  console.log({ code, field, reason, expectedType, nullable, actualType });
  // {
  //   code: 'BS_RUNTIME_TYPE_MISMATCH',
  //   field: 'Item',
  //   reason: 'type-mismatch',
  //   expectedType: 'string',
  //   nullable: true,
  //   actualType: 'number'
  // }
}
```

### RecordDiagnosticReason

```typescript fragment
type RecordDiagnosticReason =
  | 'missing-field'
  | 'accessor-property'
  | 'null-not-allowed'
  | 'type-mismatch'
  | 'non-finite-number'
  | 'string-too-long';
```

| Value | Meaning | Reported code |
|-------|---------|---------------|
| `'missing-field'` | The declared field has no own property. | `BS_MISSING_FIELD` |
| `'accessor-property'` | The declared field is an accessor rather than an own data property; the getter is never invoked. | `BS_RUNTIME_TYPE_MISMATCH` |
| `'null-not-allowed'` | A non-nullable field contains `null`. | `BS_RUNTIME_TYPE_MISMATCH` |
| `'type-mismatch'` | The value does not match the declared type (own `undefined`, wrong primitive, array, object, `bigint`, `symbol`, `function`, or a non-finite number on a non-numeric field). | `BS_RUNTIME_TYPE_MISMATCH` |
| `'non-finite-number'` | `NaN`, `Infinity`, or `-Infinity` on a `number` or `scalar` field. | `BS_RUNTIME_TYPE_MISMATCH` |
| `'string-too-long'` | A string or scalar string above 4,096 UTF-16 code units. | `BS_STRING_VALUE_LIMIT_EXCEEDED` |

### RuntimeValueType

```typescript fragment
type RuntimeValueType =
  | 'missing'
  | 'accessor'
  | 'null'
  | 'undefined'
  | 'string'
  | 'number'
  | 'non-finite-number'
  | 'boolean'
  | 'bigint'
  | 'symbol'
  | 'function'
  | 'array'
  | 'object';
```

| Value | Classification source |
|-------|-----------------------|
| `'missing'` | No own property descriptor exists for the declared field name. |
| `'accessor'` | The descriptor is an accessor (getter/setter); it is never invoked. |
| `'null'` | The data value is `null`. |
| `'undefined'` | The data value is `undefined`. |
| `'string'` | `typeof value === 'string'`. |
| `'number'` | `typeof value === 'number'` and the value is finite. |
| `'non-finite-number'` | `NaN`, `Infinity`, or `-Infinity`. |
| `'boolean'` | `typeof value === 'boolean'`. |
| `'bigint'` | `typeof value === 'bigint'`. |
| `'symbol'` | `typeof value === 'symbol'`. |
| `'function'` | `typeof value === 'function'`. |
| `'array'` | `Array.isArray(value)` is `true`. |
| `'object'` | Any other object, including revoked proxies. |

### ExpressionDiagnosticCode

```typescript fragment
type ExpressionDiagnosticCode =
  | 'BS_SOURCE_TOO_LONG'
  | 'BS_TOKEN_LIMIT_EXCEEDED'
  | 'BS_STRING_LITERAL_TOO_LONG'
  | 'BS_FIELD_NAME_TOO_LONG'
  | 'BS_NESTING_LIMIT_EXCEEDED'
  | 'BS_INVALID_CHARACTER'
  | 'BS_INVALID_STRING'
  | 'BS_INVALID_NUMBER'
  | 'BS_UNEXPECTED_TOKEN'
  | 'BS_UNKNOWN_FIELD'
  | 'BS_TYPE_MISMATCH'
  | 'BS_INVALID_ARGUMENT_COUNT'
  | 'BS_EXPECTED_RESULT_TYPE_MISMATCH'
  | 'BS_MISSING_FIELD'
  | 'BS_RUNTIME_TYPE_MISMATCH'
  | 'BS_STRING_VALUE_LIMIT_EXCEEDED'
  | 'BS_NULL_NOT_ALLOWED'
  | 'BS_EVALUATION_STEP_LIMIT_EXCEEDED';
```

| Code | Reported as | Meaning |
|------|-------------|---------|
| `BS_SOURCE_TOO_LONG` | Source diagnostic | Source exceeds 16,384 UTF-16 code units; reported before tokenization. |
| `BS_TOKEN_LIMIT_EXCEEDED` | Source diagnostic | Source produces more than 4,096 non-EOF tokens. |
| `BS_STRING_LITERAL_TOO_LONG` | Source diagnostic | A decoded string literal exceeds 4,096 UTF-16 code units. |
| `BS_FIELD_NAME_TOO_LONG` | Source diagnostic | A bracketed field name exceeds 256 UTF-16 code units. |
| `BS_NESTING_LIMIT_EXCEEDED` | Source diagnostic | Parenthesis or negation nesting exceeds 64 levels. |
| `BS_INVALID_CHARACTER` | Source diagnostic | A character is not valid BlendScript syntax. |
| `BS_INVALID_STRING` | Source diagnostic | A string literal is malformed: raw line break, unsupported escape, malformed `\u` escape, unpaired surrogate, or missing closing quote. |
| `BS_INVALID_NUMBER` | Source diagnostic | A number literal is malformed or not finite. |
| `BS_UNEXPECTED_TOKEN` | Source diagnostic | An unexpected or misplaced token, a built-in name used without a call, or an `IN` list grammar violation. |
| `BS_UNKNOWN_FIELD` | Source diagnostic | A referenced field is not declared in the schema. |
| `BS_TYPE_MISMATCH` | Source diagnostic | An operand, built-in argument, or `IN` member has an incompatible type. |
| `BS_INVALID_ARGUMENT_COUNT` | Source diagnostic | A built-in call has the wrong number of arguments. |
| `BS_EXPECTED_RESULT_TYPE_MISMATCH` | Source diagnostic | The inferred result does not exactly match `expectedResult`, or is nullable where a non-null result is required. |
| `BS_MISSING_FIELD` | Record diagnostic | The record lacks an own property for a declared field. |
| `BS_RUNTIME_TYPE_MISMATCH` | Record diagnostic | A declared field is an accessor, contains `null` on a non-nullable field, or does not match its declared type. |
| `BS_STRING_VALUE_LIMIT_EXCEEDED` | Source (evaluation) or record diagnostic | A record string field exceeds 4,096 code units, or a built-in produced a derived string above the limit. |
| `BS_NULL_NOT_ALLOWED` | Source (evaluation) diagnostic | `null` reached an operation that cannot accept it. |
| `BS_EVALUATION_STEP_LIMIT_EXCEEDED` | Source (evaluation) diagnostic | Evaluation exceeded the 10,000-step deterministic work budget. |

Diagnostic ordering and count:

- Lexical and parse failures return exactly one diagnostic.
- Semantic analysis returns up to 20 diagnostics, sorted by `span.start` ascending, then `span.end` ascending, then code; duplicates with the same code and span are collapsed.
- Record validation returns the first failure in captured schema order; evaluation-time failures return one diagnostic.
- When a subexpression cannot be typed (for example, an unknown field), cascading type findings from parent operators are suppressed.

### RecordExpressionDiagnosticCode

```typescript fragment
type RecordExpressionDiagnosticCode =
  | 'BS_MISSING_FIELD'
  | 'BS_RUNTIME_TYPE_MISMATCH'
  | 'BS_STRING_VALUE_LIMIT_EXCEEDED';
```

| Code | Meaning |
|------|---------|
| `BS_MISSING_FIELD` | The record has no own property for a declared field. |
| `BS_RUNTIME_TYPE_MISMATCH` | The field is an accessor, holds `null` on a non-nullable field, or holds a value of the wrong runtime type. |
| `BS_STRING_VALUE_LIMIT_EXCEEDED` | The field holds a string above the 4,096 UTF-16 code unit cap. |

### BlendScriptApiErrorCode

```typescript fragment
type BlendScriptApiErrorCode =
  | 'BS_INVALID_ARGUMENT'
  | 'BS_INVALID_SCHEMA'
  | 'BS_INVALID_OPTIONS'
  | 'BS_INVALID_COMPILED_EXPRESSION'
  | 'BS_SCHEMA_FIELD_LIMIT_EXCEEDED';
```

| Code | Thrown when |
|------|-------------|
| `BS_INVALID_ARGUMENT` | `source` is not a string, or evaluation `data` is not a caller-materialized ordinary object. |
| `BS_INVALID_SCHEMA` | The schema or one of its field descriptors is invalid: wrong container, unsupported member, symbol key, accessor property, reserved key, out-of-range key length, missing `type`, invalid type value, or non-boolean `nullable`. |
| `BS_INVALID_OPTIONS` | The options object is invalid: wrong container, unsupported member, accessor property, missing `schema`, or invalid `expectedResult`. |
| `BS_INVALID_COMPILED_EXPRESSION` | A value passed to `evaluateExpression` was not created by `compileExpression` in the same loaded package instance. |
| `BS_SCHEMA_FIELD_LIMIT_EXCEEDED` | The schema declares more than 1,024 fields. |

---

## Expression Language Reference

### Literals

| Literal | Accepted forms | Notes |
|---------|----------------|-------|
| Number | `0`, `007`, `-12.5`, `+2`, `.5`, `5.`, `1e3`, `-2.5E-2` | Locale-independent decimal grammar; the value must be finite. Hex/binary/octal forms, `_` separators, `NaN`, `Infinity`, and non-finite results are rejected with `BS_INVALID_NUMBER`. |
| String | `"NL"`, `"\u0041"` | Double-quoted. Escapes: `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, and `\uXXXX`. Raw line breaks and unpaired surrogate escapes are rejected. Max 4,096 UTF-16 code units after decoding. |
| Boolean | `TRUE`, `FALSE` | Case-insensitive keywords. |
| Null | `NULL` | Case-insensitive keyword; type `{ type: 'null', nullable: true }`. |

### Field References

| Form | Example | Rules |
|------|---------|-------|
| Bare identifier | `Country`, `OrderTotal` | `[A-Za-z_][A-Za-z0-9_]*` that is not a keyword. Resolved case-sensitively against schema keys; no normalization or suggestions. |
| Bracketed name | `[Order Total]`, `[A]]B]` | Allows spaces and special characters; `]]` encodes a literal `]`. Bracket contents are always a field reference and never a keyword or built-in. Max 256 UTF-16 code units; empty names are rejected. |

Field and call resolution:

- An identifier not followed by `(` is a field reference.
- An identifier followed by `(` is a call and must name one of the twelve built-ins (case-insensitive); anything else fails with `BS_UNEXPECTED_TOKEN` at the `(`.
- An undeclared bare name that matches a built-in fails with `BS_UNEXPECTED_TOKEN` and guidance to add parentheses; the same name in brackets fails with `BS_UNKNOWN_FIELD`.
- A schema may declare fields named like built-ins (`trim`); they are reachable without parentheses (`trim == "x"`) and through brackets (`[trim]`).

### Operators

Binding order — lower levels bind looser:

| Binding | Operators | Form | Semantics |
|---------|-----------|------|-----------|
| 1 (loosest) | `OR`, `\|\|` | `a OR b` | Logical disjunction; both operands must be `boolean`; short-circuits on `true`. |
| 2 | `AND`, `&&` | `a AND b` | Logical conjunction; both operands must be `boolean`; short-circuits on `false`. |
| 3 | `==`, `!=` | `a == b`, `a != b` | Strict equality without coercion; operand types must be identical, or one side must be `null` with the other nullable. |
| 3 | `<`, `<=`, `>`, `>=` | `a < b`, `a >= b` | Numeric ordering; both operands must be `number`. |
| 3 | `IN` | `a IN (m, …)` | Strict membership against a non-empty list of primitive literals. |
| 4 | `NOT`, `!` | `NOT a` | Boolean negation; binds tighter than comparisons. |
| 5 (tightest) | Grouping, calls, literals, fields | `(a)`, `text(x)`, `"s"`, `A`, `[A B]` | Primary expressions. |

Rules:

- Keyword operators are case-insensitive (`and` ≡ `AND`); symbolic aliases are exactly `&&`, `||`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`.
- Comparison and membership are non-associative: at most one comparison-level operator may appear per level. `1 < 2 < 3` and `a == b IN (1)` are syntax errors with `BS_UNEXPECTED_TOKEN` at the second operator.
- `AND` and `OR` associate left with short-circuit evaluation; unselected branches and their work are skipped entirely.
- `NOT A == TRUE` parses as `(NOT A) == TRUE`; use parentheses to compare a negation.
- `IN` lists contain primitive literals only (`number`, `string`, `TRUE`/`FALSE`, `NULL`), require at least one member, disallow trailing commas, and allow duplicate members. Each member must be equality-compatible with the left operand at analysis; an incompatible member reports `BS_TYPE_MISMATCH` at that member's span.
- The grammar deliberately excludes property access, indexing, arithmetic, ternaries, assignment, statements, comments, template literals, regular expressions, and object/array literals; each is rejected as syntax. There is no `=` operator, no string concatenation, and no way to define or call host functions.

### Built-in Functions

Twelve fixed, pure, synchronous built-ins form a closed set — there is no registration API. Names are case-insensitive and stored canonically in lowercase. Argument counts are enforced exactly at analysis (`BS_INVALID_ARGUMENT_COUNT`), and argument types are checked left-to-right. In the "Null argument" column, *Accepted* means a literal `NULL` argument passes analysis and a runtime `null` is handled; *Rejected* means a literal `NULL` argument fails with `BS_TYPE_MISMATCH` and a runtime `null` fails evaluation with `BS_NULL_NOT_ALLOWED`.

| Built-in | Parameters | Result | Null argument | Description |
|----------|------------|--------|---------------|-------------|
| `isEmpty` | `string` | `boolean` | Accepted → `true` | `true` when the value is `null` or the empty string. |
| `isBlank` | `string` | `boolean` | Accepted → `true` | `true` when the value is `null` or contains only whitespace. |
| `contains` | `string, string` | `boolean` | Rejected | `true` when the first string contains the second. |
| `startsWith` | `string, string` | `boolean` | Rejected | `true` when the first string begins with the second. |
| `endsWith` | `string, string` | `boolean` | Rejected | `true` when the first string ends with the second. |
| `equalsIgnoreCase` | `string, string` | `boolean` | Rejected | Case-insensitive equality using non-locale `toLowerCase` on both operands. |
| `trim` | `string` | `string` | Rejected | Removes leading and trailing whitespace. |
| `lower` | `string` | `string` | Rejected | Converts to lowercase. |
| `upper` | `string` | `string` | Rejected | Converts to uppercase. |
| `length` | `string` | `number` | Rejected | Counts Unicode code points (`"😀a"` has length `2`). |
| `tryNumber` | `scalar` | `number` | Accepted → `null` | Parses complete, locale-independent decimal text (`1`, `001`, `-12.5`, `.5`, `5.`, `+2`, `1e3`); returns `null` for invalid, blank, partial, or non-finite text. The result is nullable. |
| `text` | `scalar` | `string` | Rejected | Returns strings unchanged and formats numbers with `String(value)`; never coerces implicitly elsewhere. |

Notes:

- `tryNumber` and `text` accept `scalar` fields; other built-ins require the declared concrete type. Passing a scalar field directly into a `string` parameter fails at analysis with `BS_TYPE_MISMATCH` and guidance to use `text(...)` or `tryNumber(...)`.
- Derived string results (`trim`, `lower`, `upper`, `text`, and the lowered operands of `equalsIgnoreCase`) that exceed 4,096 UTF-16 code units fail evaluation with `BS_STRING_VALUE_LIMIT_EXCEEDED` at the call span.
- `length` counts code points; `lower`/`upper`/`equalsIgnoreCase` use JavaScript's non-locale `toLowerCase`/`toUpperCase` semantics.

**Example**

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const options = {
  schema: { Name: { type: 'string' }, Item: { type: 'scalar' } },
} as const;

const greeting = compileExpression('startsWith(trim(Name), "Blend")', options);
if (!greeting.ok) throw new Error(greeting.diagnostics[0]?.message);
console.log(evaluateExpression(greeting.expression, { Name: '  BlendScript', Item: 'x' }));
// { ok: true, value: true }

const numeric = compileExpression('tryNumber(Item) != NULL AND tryNumber(Item) > 1', options);
if (!numeric.ok) throw new Error(numeric.diagnostics[0]?.message);
console.log(evaluateExpression(numeric.expression, { Name: 'x', Item: '2' }));
// { ok: true, value: true }
console.log(evaluateExpression(numeric.expression, { Name: 'x', Item: 'ABC-1' }));
// { ok: true, value: false }
```

### Static Analysis Rules

| Construct | Static rule |
|-----------|-------------|
| `NOT a` | `a` must be `boolean`. |
| `a AND b`, `a OR b` | Both operands must be `boolean`. |
| `a == b`, `a != b` | Operand types must be identical; a `null` side requires the other side to be nullable. |
| `a < b`, `a <= b`, `a > b`, `a >= b` | Both operands must be `number`. |
| `a IN (m, …)` | Each member must be equality-compatible with `a`; members are primitive literals only. |
| `builtin(args)` | Exact argument count; argument types checked left-to-right; literal `NULL` accepted only by null-aware built-ins (`isEmpty`, `isBlank`, `tryNumber`). |
| `expectedResult` | Inferred type must match exactly and be non-nullable, except the literal-null type for `'null'`. |

### Evaluation Semantics

- Evaluation is deterministic, single-threaded, and left-to-right over the frozen private AST.
- `AND`/`OR` short-circuit; skipped branches perform no work and cannot fail.
- Equality is strict JavaScript `===` semantics without coercion; ordering requires numbers at both analysis and runtime.
- Membership compares the left operand strictly to each literal member and returns `true` on the first match.
- Records are validated completely before interpretation: every declared field is checked in captured schema order, so a missing or invalid unreferenced field still fails the call.
- A `null` reaching an operation that cannot accept it fails with `BS_NULL_NOT_ALLOWED` at the span of the complete operator or call.
- Every node visit and string operation is charged against the evaluation budget; exceeding it fails with `BS_EVALUATION_STEP_LIMIT_EXCEEDED` at the current node span.
- Failed evaluations are repeatable and leave the handle and the record unchanged.

### Limits

All boundaries are inclusive: the cap value itself is accepted, the next unit is rejected.

| Limit | Value | Enforced on |
|-------|-------|-------------|
| Source length | 16,384 UTF-16 code units | `source`, before tokenization (`BS_SOURCE_TOO_LONG`). |
| Token count | 4,096 | Non-EOF tokens during lexing (`BS_TOKEN_LIMIT_EXCEEDED`). |
| String length | 4,096 UTF-16 code units | Decoded string literals (`BS_STRING_LITERAL_TOO_LONG`), record strings, and built-in derived strings (`BS_STRING_VALUE_LIMIT_EXCEEDED`). |
| Field name length | 256 UTF-16 code units | Bracketed field names (`BS_FIELD_NAME_TOO_LONG`) and schema keys (`BS_INVALID_SCHEMA`). |
| Schema fields | 1,024 | Schema size (`BS_SCHEMA_FIELD_LIMIT_EXCEEDED`). |
| Nesting depth | 64 | Parser nesting (`BS_NESTING_LIMIT_EXCEEDED`). |
| Semantic diagnostics | 20 | Diagnostics returned per validation or compilation call. |
| Evaluation work | 10,000 steps | Charged work per `evaluateExpression` call (`BS_EVALUATION_STEP_LIMIT_EXCEEDED`). |
| Diagnostic excerpt | 120 UTF-16 code units | `excerpt` length on source diagnostics. |

---

## End-to-End Example

```typescript
import {
  BlendScriptApiError,
  compileExpression,
  evaluateExpression,
  validateExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
    ItemCode: { type: 'scalar', nullable: true },
  },
  expectedResult: 'boolean',
};

const source =
  'Country IN ("NL", "BE") AND OrderTotal >= 1000 AND tryNumber(ItemCode) != NULL';

const records = [
  { Country: 'NL', OrderTotal: 1250, ItemCode: '0042' },
  { Country: 'NL', OrderTotal: 250, ItemCode: '0042' },
  { Country: 'DE', OrderTotal: 4000, ItemCode: '0042' },
  { Country: 'BE', OrderTotal: 4000, ItemCode: null },
] as const;

try {
  const validation = validateExpression(source, options);
  if (!validation.ok) throw new Error(validation.diagnostics[0]?.message);

  const compilation = compileExpression(source, options);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

  for (const record of records) {
    const result = evaluateExpression(compilation.expression, record);
    if (result.ok) {
      console.log(`${record.Country}: ${result.value}`);
    } else {
      console.error(result.diagnostic.code, result.diagnostic.message);
    }
  }
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.error(`API misuse: ${error.code} - ${error.message}`);
  } else {
    throw error;
  }
}

// Console output:
// NL: true
// NL: false
// DE: false
// BE: false
```

---

## Related Documentation

- Overview — what BlendScript is, when to use it, and the architecture.
- Core Concepts — the language model, schemas, and diagnostics.
- Basic Usage — the complete validate/compile/evaluate workflow.
- Troubleshooting — resolving common diagnostic codes.
- Examples Library — task-oriented recipes.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
