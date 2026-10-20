> **Package**: `blendsdk/blendscript`

# blendscript Core Concepts

This document is a deep dive into every major concept of `blendsdk/blendscript`, the small, safe expression language for business rules. Read it after the Overview; Basic Usage then applies the concepts step by step.

The concepts and how they connect:

1. **The Expression Pipeline** — the one deterministic path from source text to a result, shared by validation and compilation.
2. **Schemas and Field Types** — how a host declares exactly which fields a rule may read, including the mixed `scalar` type.
3. **The Expression Language** — literals, operators, and precedence, and what is deliberately excluded.
4. **Static Analysis and Type Inference** — how fields are bound, the result type is inferred, and `expectedResult` is enforced.
5. **Compiled Expressions** — the opaque, reusable handle produced by compilation.
6. **Evaluation and Record Validation** — how one handle runs against a complete, validated record snapshot.
7. **Built-in Functions** — the closed set of twelve pure functions and their null semantics.
8. **Diagnostics** — the two structured, immutable failure shapes: source and record.
9. **Deterministic Limits and the Work Budget** — the fixed bounds that make every accepted evaluation terminate predictably.
10. **The Input Boundary and Programmer Errors** — what throws `BlendScriptApiError` versus what returns diagnostics.

---

## 1. The Expression Pipeline

### What It Is

The pipeline is the single deterministic processing path that every expression travels: options snapshot, lexing, parsing, static analysis, and — depending on the entry point — compilation into a handle and evaluation against a record. `validateExpression` and `compileExpression` are two exits from the same pipeline, which is why identical input always yields identical `resultType`, `referencedFields`, and diagnostics from both.

### How It Works

1. `analyzeSource` snapshots the options: the schema is validated and copied into frozen `SchemaEntry` records with a declaration-order index. Malformed options throw `BlendScriptApiError` (see [concept 10](#10-the-input-boundary-and-programmer-errors)).
2. The lexer checks the source-length cap, then produces bounded tokens with exact zero-based, half-open UTF-16 spans.
3. The parser builds a frozen AST using explicit v1 precedence and a bounded nesting counter. Lexical and syntax failures short-circuit the pipeline with exactly one source diagnostic.
4. The analyzer binds fields to the schema, infers the result type, and collects ordered, capped semantic diagnostics.
5. `validateExpression` exits after analysis with `{ ok: true, resultType, referencedFields }` and retains nothing. `compileExpression` continues along the same path into the handle factory.
6. `evaluateExpression` retrieves the private payload from a compiled handle, snapshots the record, and interprets the frozen AST — no code generation, no dynamic loading.

### Complete Example

```typescript
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type EvaluationResult,
  type ExpressionOptions,
  type ExpressionValue,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
};
const source = 'Country IN ("NL", "BE") AND OrderTotal >= 1000';

// Exit 1: validation returns metadata and retains nothing.
const validation = validateExpression(source, options);
if (!validation.ok) throw new Error(validation.diagnostics[0]?.message);
console.log(validation.resultType.type); // "boolean"
console.log(validation.referencedFields); // ["Country", "OrderTotal"]

// Exit 2: compilation continues down the same pipeline into an opaque handle.
const compilation = compileExpression(source, options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

// Exit 3: evaluation runs that handle against one record at a time.
const records: ReadonlyArray<Readonly<Record<string, ExpressionValue>>> = [
  { Country: 'NL', OrderTotal: 1250 },
  { Country: 'NL', OrderTotal: 20 },
  { Country: 'BE', OrderTotal: 5000 },
];

for (const record of records) {
  const result: EvaluationResult = evaluateExpression(compilation.expression, record);
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(result.value);
}
// true
// false
// true
```

### Key Entry Points

| Name | Signature | Description |
| --- | --- | --- |
| `validateExpression` | `(source: string, options: ExpressionOptions) => ValidationResult` | Checks syntax and types. On success returns `resultType` and `referencedFields`; on failure returns up to 20 ordered source diagnostics. Retains no state. |
| `compileExpression` | `(source: string, options: ExpressionOptions) => CompilationResult` | Runs the same check, then creates a fresh opaque handle: `{ ok: true, expression, resultType, referencedFields }`. |
| `evaluateExpression` | `(expression: CompiledExpression, data: Readonly<Record<string, ExpressionValue>>) => EvaluationResult` | Validates one complete record against the captured schema, interprets the AST, and returns `{ ok: true, value }` or one diagnostic. |

---

## 2. Schemas and Field Types

### What It Is

The schema is the complete, explicit set of fields an expression may reference. `ExpressionOptions` requires a `schema` and optionally accepts `expectedResult`. Every schema entry declares a `type` and an optional `nullable` flag (default `false`) — nothing is discovered dynamically, so a rule can only ever touch fields the host deliberately exposed.

### How It Works

- `snapshotOptions` validates the caller-materialized options object *before* lexing. Options and schemas must be ordinary objects (prototype `Object.prototype` or `null`); arrays, class instances, accessor properties, symbol keys, and unknown members are rejected with `BlendScriptApiError`.
- Field names must be 1–256 UTF-16 code units and cannot be `__proto__`, `prototype`, or `constructor`. At most 1,024 fields are allowed.
- Each field descriptor accepts exactly two own data members: `type` (required) and `nullable` (optional boolean). Anything else throws `BS_INVALID_SCHEMA`.
- Entries are copied into frozen records with a capture index, so later mutation of the caller's objects cannot change compilation or evaluation behavior.
- The `scalar` field type preserves either a string or a finite number exactly. It is deliberately opaque to operators: `text(...)` or `tryNumber(...)` must convert it before concrete-type use — see [Built-in Functions](#7-built-in-functions).

### Complete Example

```typescript
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type ExpressionOptions,
  type ExpressionSchema,
} from 'blendsdk/blendscript';

const schema: ExpressionSchema = {
  Country: { type: 'string' },
  'Order Total': { type: 'number' },
  OptionalCode: { type: 'string', nullable: true },
  Item: { type: 'scalar' }, // mixed spreadsheet-like column: string or finite number
};

const options: ExpressionOptions = { schema, expectedResult: 'boolean' };
const source = 'Country IN ("NL", "BE") AND [Order Total] >= 1000 AND OptionalCode == NULL';

const validation = validateExpression(source, options);
if (!validation.ok) throw new Error(validation.diagnostics[0]?.message);
console.log(validation.referencedFields); // ["Country", "Order Total", "OptionalCode"]

const compilation = compileExpression(source, options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, {
  Country: 'NL',
  'Order Total': 1250,
  OptionalCode: null,
  Item: 1,
});
if (!result.ok) throw new Error(result.diagnostic.message);
console.log(result.value); // true
```

### Key Field Types and Rules

| Field type | Accepted runtime values | Typical source column |
| --- | --- | --- |
| `'string'` | Any JavaScript string up to 4,096 UTF-16 code units | names, codes, free text |
| `'number'` | Any finite JavaScript number | amounts, counts, quantities |
| `'boolean'` | `true` or `false` | flags, toggles |
| `'scalar'` | A string or a finite number, preserved exactly | mixed spreadsheet columns |

| Member | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `ExpressionFieldType` | Yes | `'string'`, `'number'`, `'boolean'`, or `'scalar'`. |
| `nullable` | `boolean` | No (default `false`) | Whether the record may explicitly contain `null` for this field. |

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `schema` | `ExpressionSchema` | Yes | The complete field map; keys must match references exactly. |
| `expectedResult` | `ExpressionValueType` | No | Exact required result type: `'string'`, `'number'`, `'boolean'`, or `'null'`. |

---

## 3. The Expression Language

### What It Is

BlendScript v1 is a small, spreadsheet-readable expression language: literals, field references, comparisons, `IN` membership, `NOT`/`AND`/`OR`, parentheses, and calls to the fixed built-ins. Everything else is deliberately excluded — no arithmetic (`+`, `-`, `*`, `/`), no property access, arrays, objects, ternaries, comments, regular expressions, statements, variables, or user-defined functions.

### How It Works

- Keywords are case-insensitive (`TRUE`, `false`, `AND`, `Or`, ...), while field names are matched byte-for-byte against the schema with no normalization and no suggestions.
- A bare identifier is a field reference. Brackets reach any name: `[Order Total]` and `[A]]B]` (where `]]` decodes one `]`) — useful for keyword-like names such as `[AND]`.
- Identifiers followed by `(` must be one of the twelve built-ins; any other call target is a parse error.
- Numbers are locale-independent finite decimals only. Strings use double quotes with a fixed escape set (`\" \\ \n \r \t \b \f \uXXXX`), reject raw line breaks and unpaired surrogates, and cap at 4,096 code units.
- Comparisons do not chain: `1 < 2 < 3` is rejected at the second operator rather than being parsed left-to-right.
- `IN` requires a non-empty parenthesized list of primitive literals (no trailing comma, duplicates allowed) and performs strict membership: no coercion, so `Country IN (NULL)` fails static analysis unless `Country` is nullable.
- `AND`/`OR` short-circuit, so an unselected branch performs no evaluation work (see [concept 9](#9-deterministic-limits-and-the-work-budget)).

### Complete Example

```typescript
import {
  compileExpression,
  evaluateExpression,
  type CompiledExpression,
  type ExpressionOptions,
  type ExpressionValue,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    Enabled: { type: 'boolean' },
    'Order Total': { type: 'number' },
  },
  expectedResult: 'boolean',
};

function compile(source: string): CompiledExpression {
  const result = compileExpression(source, options);
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result.expression;
}

const keyword = compile('NOT Enabled OR Country IN ("GB", "NL") AND [Order Total] > 100');
const symbolic = compile('!Enabled || Country IN ("GB", "NL") && [Order Total] > 100');

const record: Readonly<Record<string, ExpressionValue>> = {
  Country: 'NL',
  Enabled: true,
  'Order Total': 250,
};

const left = evaluateExpression(keyword, record);
const right = evaluateExpression(symbolic, record);
if (!left.ok || !right.ok) throw new Error('Expected both evaluations to succeed.');
console.log(left.value === right.value); // true — AND binds tighter than OR in both spellings
```

### Key Operators and Literals

| Precedence | Operators | Operand requirements | Short-circuits |
| --- | --- | --- | --- |
| 1 (highest) | `NOT x`, `!x` | `x` must be Boolean | No |
| 2 | `==`, `!=` | Operand types must be compatible; `null` only against a nullable operand | No |
| 2 | `<`, `<=`, `>`, `>=` | Both operands numeric | No |
| 2 | `x IN (a, b, ...)` | Every literal must be compatible with `x`; non-empty list | No |
| 3 | `AND`, `&&` | Both operands Boolean | Yes |
| 4 (lowest) | `OR`, `\|\|` | Both operands Boolean | Yes |

| Literal form | Examples | Notes |
| --- | --- | --- |
| Number | `0`, `007`, `-12.5`, `+2`, `.5`, `5.`, `1e3` | Finite decimals only; `0x10`, `1_000`, `NaN`, `1e309` are rejected. |
| String | `"NL"`, `"\u0041"` | Fixed escape set; no raw line breaks; surrogates must be paired. |
| Boolean / null | `TRUE`, `FALSE`, `NULL` | Case-insensitive keywords. |
| Field reference | `Country`, `[Order Total]`, `[A]]B]` | Exact schema match, case-sensitive. |
| Grouping | `( ... )` | Counts against the 64-level nesting limit. |

---

## 4. Static Analysis and Type Inference

### What It Is

The analyzer is the static phase that binds every field reference to the schema, checks every operator and built-in against strict type rules, infers the expression's `InferredExpressionType`, and collects the referenced fields. It is the component that guarantees a compilation failure is reported at authoring time, never as a runtime crash.

### How It Works

- The analyzer walks the AST with a type/nullability pair per node. A field must be declared in the schema, or the result is `BS_UNKNOWN_FIELD`.
- A built-in name used without parentheses stops analysis with a single `BS_UNEXPECTED_TOKEN` ("must be called with parentheses") — unless a schema field of that exact name exists, in which case it is a normal field reference.
- Equality requires compatible types: the same type on both sides, or `null` compared against a nullable operand. Ordering requires two numeric operands. `AND`/`OR`/`NOT` require Boolean operands. `scalar` operands trigger an actionable conversion hint (`Use text(...) or tryNumber(...) ...`) in the diagnostic message.
- When a subexpression fails to resolve, its parents are suppressed — analysis reports the root causes without cascading noise.
- Diagnostics are deduplicated, sorted by span (start, end, then code), and capped at 20 (`MAX_SEMANTIC_DIAGNOSTICS`).
- On success, `expectedResult` is enforced exactly and must not be nullable: `"yes"` with `expectedResult: 'boolean'` fails with `BS_EXPECTED_RESULT_TYPE_MISMATCH`.
- The frozen result carries `resultType` (type plus nullability) and `referencedFields` in first-source-occurrence order. `validateExpression` and `compileExpression` produce identical metadata for the same input.

### Complete Example

```typescript
import {
  validateExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Text: { type: 'string' },
    Count: { type: 'number' },
    Item: { type: 'scalar' },
  },
};

const sources = ['Text == Count', 'Count >= 10 AND TRUE', 'tryNumber(Item) != NULL'];

for (const source of sources) {
  const result = validateExpression(source, options);
  if (!result.ok) {
    const first = result.diagnostics[0];
    console.log(`${source} -> ${first?.code} at ${first?.location.line}:${first?.location.column}`);
    continue;
  }
  const inferred = result.resultType;
  const suffix = inferred.nullable ? ' | null' : '';
  console.log(`${source} -> ${inferred.type}${suffix} [${result.referencedFields.join(', ')}]`);
}
// Text == Count -> BS_TYPE_MISMATCH at 1:1
// Count >= 10 AND TRUE -> boolean [Count]
// tryNumber(Item) != NULL -> boolean [Item]

const wrongResult = validateExpression('"yes"', {
  schema: { Text: { type: 'string' } },
  expectedResult: 'boolean',
});
if (!wrongResult.ok) console.log(wrongResult.diagnostics[0]?.code); // "BS_EXPECTED_RESULT_TYPE_MISMATCH"
```

### Key Rules and Inferred Types

| Construct | Requirement | Violation code |
| --- | --- | --- |
| Field reference | Declared in the schema | `BS_UNKNOWN_FIELD` |
| Built-in call | Exact argument count | `BS_INVALID_ARGUMENT_COUNT` |
| Built-in argument | Declared parameter type (`scalar` parameters accept string, number, or scalar) | `BS_TYPE_MISMATCH` |
| `NOT`, `AND`, `OR` | Boolean operands | `BS_TYPE_MISMATCH` |
| `==`, `!=` | Compatible types; `null` only against a nullable operand | `BS_TYPE_MISMATCH` |
| `<`, `<=`, `>`, `>=` | Numeric operands | `BS_TYPE_MISMATCH` |
| `IN` members | Each member compatible with the left operand | `BS_TYPE_MISMATCH` |
| `expectedResult` | Exact non-null type match | `BS_EXPECTED_RESULT_TYPE_MISMATCH` |

| Expression node | Inferred `resultType` |
| --- | --- |
| String / number / boolean literal | That exact type, `nullable: false` |
| `NULL` | `{ type: 'null', nullable: true }` |
| Field reference | The declared schema type and `nullable` flag (including `scalar`) |
| `NOT`, comparisons, `IN`, `AND`, `OR` | `boolean`, never nullable |
| `text(x)` | `string`, never nullable |
| `tryNumber(x)` | `number`, nullable (invalid text yields `null`) |
| `isEmpty` / `isBlank` / other string checks | `boolean`, never nullable |

---

## 5. Compiled Expressions

### What It Is

A `CompiledExpression` is the opaque handle returned by `compileExpression` and the only value `evaluateExpression` accepts. It is a branded in-memory object backed by a module-private `WeakMap` — not a string, not JSON, not a plain data structure that can be reconstructed.

### How It Works

- `compileExpression` creates a fresh, frozen object carrying a module-private unique-symbol brand, then registers its immutable payload — original source, frozen AST, inferred type, referenced fields, and the captured schema entries — in a private `WeakMap`.
- `evaluateExpression` looks the handle up in that registry. Anything not created by this exact package instance throws `BlendScriptApiError` with code `BS_INVALID_COMPILED_EXPRESSION` — including structural lookalikes, `JSON.parse` results, and handles produced by a different copy of the package (for example, mixing the direct `blendsdk/blendscript` build with the `blendsdk/blendscript` umbrella build).
- Each compilation returns a distinct handle; handles are never interned or compared by content. The payload is immutable and never retains record data, so one handle can be reused for any number of sequential evaluations.
- Because handles are in-memory only, persist the source plus schema and recompile after a process restart or package upgrade — see Advanced Patterns.

### Complete Example

```typescript
import {
  compileExpression,
  evaluateExpression,
  type CompiledExpression,
  type ExpressionValue,
} from 'blendsdk/blendscript';

const options = {
  schema: { Country: { type: 'string' }, 'Order Total': { type: 'number' } },
  expectedResult: 'boolean',
} as const;

const source = 'Country == "NL" AND [Order Total] >= 1000';

const compilation = compileExpression(source, options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const rule: CompiledExpression = compilation.expression;

// Handles are opaque: no enumerable state, no serializable content.
console.log(Object.keys(rule).length); // 0
console.log(JSON.stringify(rule)); // "{}"

// Every compilation is a fresh handle, even for identical input.
const recompiled = compileExpression(source, options);
if (!recompiled.ok) throw new Error(recompiled.diagnostics[0]?.message);
console.log(recompiled.expression === rule); // false

// One handle serves any number of records, independently and without retained state.
const records: readonly Readonly<Record<string, ExpressionValue>>[] = [
  { Country: 'NL', 'Order Total': 1250 },
  { Country: 'BE', 'Order Total': 1250 },
  { Country: 'NL', 'Order Total': 20 },
];

for (const record of records) {
  const evaluation = evaluateExpression(rule, record);
  if (!evaluation.ok) throw new Error(evaluation.diagnostic.message);
  console.log(`${String(record.Country)}: ${String(evaluation.value)}`);
}
// NL: true
// BE: false
// NL: false
```

### Key Guarantees

| Guarantee | Behavior |
| --- | --- |
| Identity | A fresh handle is created per compilation; identical sources produce distinct handles. |
| Opacity | The brand is a module-private unique symbol; only `Object.keys` returns nothing and JSON serialization yields `{}`. |
| Ownership | A handle is valid only in the loaded package instance that created it; foreign or forged values throw `BS_INVALID_COMPILED_EXPRESSION`. |
| Reusability | Immutable and safe to evaluate repeatedly against different records; record state is never retained. |
| Persistence | None. Store the source and schema, then recompile after loading. |

---

## 6. Evaluation and Record Validation

### What It Is

Evaluation is the step that runs a compiled handle against one record: `evaluateExpression` validates the complete record against the schema captured at compilation time, copies the declared values into a frozen snapshot, and interprets the AST to produce an `EvaluationResult`.

### How It Works

- The record container must be a caller-materialized ordinary object (prototype `Object.prototype` or `null`); anything else throws `BS_INVALID_ARGUMENT`. Arrays, class instances, and inherited-only objects count as programmer misuse.
- Every declared field is checked — including fields the expression never references — in the captured schema declaration order, not the record's insertion order. The first failure returns a frozen record diagnostic.
- Fields must be own data properties. Accessor properties are classified as `accessor` and never invoked; a missing field is `missing` while an own `undefined` value is `undefined`; `null` is accepted only for `nullable` fields; numbers must be finite; strings are capped at 4,096 UTF-16 code units.
- Undeclared extra properties — including getters — are ignored without ever being read.
- During interpretation, equality uses strict `===` semantics (no coercion; `-0` equals `0`), ordering runs on validated numbers, and `null` reaching a non-null-aware site fails with `BS_NULL_NOT_ALLOWED` at the exact operator or call span. `tryNumber`, `isEmpty`, and `isBlank` absorb null by design.
- `AND`/`OR` short-circuit, the record is never mutated, and the returned result and diagnostics are frozen.

### Complete Example

```typescript
import {
  compileExpression,
  evaluateExpression,
  type ExpressionOptions,
  type ExpressionValue,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    OptionalCode: { type: 'string', nullable: true },
    Item: { type: 'scalar' },
  },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Country == "NL" AND OptionalCode == NULL', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
const rule = compilation.expression;

// A frozen, complete record evaluates without mutation.
const complete: Readonly<Record<string, ExpressionValue>> = Object.freeze({
  Country: 'NL',
  OptionalCode: null,
  Item: '001',
});
const success = evaluateExpression(rule, complete);
if (!success.ok) throw new Error(success.diagnostic.message);
console.log(success.value); // true

// `Item` is declared but never referenced; it is still required.
const incomplete = evaluateExpression(rule, { Country: 'NL', OptionalCode: null });
if (!incomplete.ok) {
  console.log(incomplete.diagnostic.kind, incomplete.diagnostic.code);
  // "record" "BS_MISSING_FIELD"
}

// Rejected values are classified precisely without reading their content.
const mismatch = evaluateExpression(rule, { Country: 42, OptionalCode: null, Item: 1 });
if (!mismatch.ok && mismatch.diagnostic.kind === 'record') {
  console.log(
    mismatch.diagnostic.field,
    mismatch.diagnostic.reason,
    mismatch.diagnostic.actualType
  );
  // "Country" "type-mismatch" "number"
}

// Null flows where the schema allows it: equality says null == NULL,
// but ordering cannot use a null value.
const nullOrdering = compileExpression('Count < 2', {
  schema: { Count: { type: 'number', nullable: true } },
});
if (!nullOrdering.ok) throw new Error(nullOrdering.diagnostics[0]?.message);

const nullFailure = evaluateExpression(nullOrdering.expression, { Count: null });
if (!nullFailure.ok) console.log(nullFailure.diagnostic.code); // "BS_NULL_NOT_ALLOWED"
```

### Key Failure Matrix

| Situation | Code | `reason` | `actualType` example |
| --- | --- | --- | --- |
| Declared field is missing | `BS_MISSING_FIELD` | `missing-field` | `missing` |
| Declared field is an accessor property | `BS_RUNTIME_TYPE_MISMATCH` | `accessor-property` | `accessor` |
| `null` on a non-nullable field | `BS_RUNTIME_TYPE_MISMATCH` | `null-not-allowed` | `null` |
| Value does not match the declared type | `BS_RUNTIME_TYPE_MISMATCH` | `type-mismatch` | `number`, `undefined`, `array`, `object`, ... |
| `NaN` or `±Infinity` on a numeric or scalar field | `BS_RUNTIME_TYPE_MISMATCH` | `non-finite-number` | `non-finite-number` |
| String longer than 4,096 code units | `BS_STRING_VALUE_LIMIT_EXCEEDED` | `string-too-long` | `string` |
| `null` reaching ordering, logic, or a non-null-aware built-in | `BS_NULL_NOT_ALLOWED` (source diagnostic) | — | — |
| Work budget exhausted | `BS_EVALUATION_STEP_LIMIT_EXCEEDED` (source diagnostic) | — | — |

---

## 7. Built-in Functions

### What It Is

Built-ins are the only callable targets in BlendScript: a closed, frozen table of twelve pure, synchronous functions. Call names are case-insensitive (`TRIM`, `trim`, `Trim` all resolve), there is no registration API, and any other call target is rejected at parse time.

### How It Works

- The analyzer checks arity first (`BS_INVALID_ARGUMENT_COUNT`), then each argument type left-to-right (`BS_TYPE_MISMATCH`). `scalar` parameters accept a string, a number, or a `scalar` field.
- Arguments are fully evaluated left-to-right before the function runs.
- `isEmpty`, `isBlank`, and `tryNumber` are the null-aware functions: `isEmpty(null)` and `isBlank(null)` return `true`, and `tryNumber(null)` returns `null`. Every other built-in rejects `null` at runtime with `BS_NULL_NOT_ALLOWED` (and `trim(NULL)` / `text(NULL)` are rejected statically).
- `tryNumber` parses only complete values that use the locale-independent decimal grammar (`0`, `007`, `-12.5`, `+2`, `.5`, `5.`, `1e3`) and produce a finite number — anything else, including blank or partially numeric text, yields `null`.
- `text` returns strings unchanged and formats finite numbers with `String(value)`; it never reads `toString`, `valueOf`, or `toJSON` on record values.
- `length` counts Unicode code points, so `length("😀a")` is `2`. Casing and trimming use non-locale semantics (`toLowerCase`/`toUpperCase`/`trim`), which is why `equalsIgnoreCase("İ", "i")` is `false`.
- Every string built-in charges its native work before running it, and derived strings above 4,096 code units fail with `BS_STRING_VALUE_LIMIT_EXCEEDED` — see [concept 9](#9-deterministic-limits-and-the-work-budget).

### Complete Example

```typescript
import {
  compileExpression,
  evaluateExpression,
  type ExpressionOptions,
  type ExpressionValue,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Name: { type: 'string' },
    OptionalCode: { type: 'string', nullable: true },
    Item: { type: 'scalar' },
  },
  expectedResult: 'boolean',
};

const compilation = compileExpression(
  'contains(trim(Name), "Blend") AND isEmpty(OptionalCode) AND tryNumber(Item) != NULL',
  options
);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const record: Readonly<Record<string, ExpressionValue>> = {
  Name: '  BlendScript 😀  ',
  OptionalCode: null,
  Item: '001',
};

const result = evaluateExpression(compilation.expression, record);
if (!result.ok) throw new Error(result.diagnostic.message);
console.log(result.value); // true
```

### Key Built-ins

| Built-in | Parameters | Result type | Null handling |
| --- | --- | --- | --- |
| `isEmpty(value)` | `string` | `boolean` | `null` and `''` → `true`; `' '` → `false` |
| `isBlank(value)` | `string` | `boolean` | `null` → `true`; trims before checking |
| `contains(value, search)` | `string`, `string` | `boolean` | `null` rejected |
| `startsWith(value, search)` | `string`, `string` | `boolean` | `null` rejected |
| `endsWith(value, search)` | `string`, `string` | `boolean` | `null` rejected |
| `equalsIgnoreCase(left, right)` | `string`, `string` | `boolean` | `null` rejected; non-locale lowercase |
| `trim(value)` | `string` | `string` | `null` rejected |
| `lower(value)` | `string` | `string` | `null` rejected |
| `upper(value)` | `string` | `string` | `null` rejected |
| `length(value)` | `string` | `number` | `null` rejected; counts code points |
| `tryNumber(value)` | `scalar` | `number \| null` | `null` → `null`; invalid text → `null` |
| `text(value)` | `scalar` | `string` | `null` rejected; exact string preserved |

---

## 8. Diagnostics

### What It Is

BlendScript reports every authoring or data problem as one of two immutable, structured shapes: `SourceExpressionDiagnostic` (`kind: 'source'`) for anything found in the expression text, and `RecordExpressionDiagnostic` (`kind: 'record'`) for a declared record field that failed validation. Both are united as `ExpressionDiagnostic`, and both are all-errors in v1 (`severity: 'error'`).

### How It Works

- Source diagnostics carry a zero-based, half-open UTF-16 `span`, a one-based `location` (`line`, `column`, `endLine`, `endColumn`), a human-readable `message`, and an optional `excerpt` of at most 120 code units. Line counting treats CRLF as a single break and counts `U+2028`/`U+2029` as line separators; columns count UTF-16 code units, so an emoji spans two columns.
- Lexical and syntax failures produce exactly one source diagnostic. Semantic analysis produces up to 20, sorted by span then code. Evaluation produces exactly one diagnostic per call: either a source diagnostic (`BS_NULL_NOT_ALLOWED`, `BS_EVALUATION_STEP_LIMIT_EXCEEDED`, `BS_STRING_VALUE_LIMIT_EXCEEDED` from a built-in) or a record diagnostic.
- Record diagnostics carry machine-readable metadata instead of the value: `field`, `reason`, `expectedType`, `nullable`, and `actualType`. Classification uses only the property descriptor and `typeof`, so getters, `toJSON`, `toString`, and hostile values such as revoked proxies are never invoked — a revoked proxy classifies as `object`.
- All diagnostics and their arrays are frozen; the rejected record value never appears anywhere in the diagnostic.

### Complete Example

```typescript
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type ExpressionDiagnostic,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

function describe(diagnostic: ExpressionDiagnostic): string {
  if (diagnostic.kind === 'source') {
    const { code, message, location } = diagnostic;
    return `${code} at ${location.line}:${location.column} — ${message}`;
  }
  const { code, field, reason, expectedType, nullable, actualType } = diagnostic;
  return `${code} on ${field} (${reason}): expected ${expectedType}${
    nullable ? ' | null' : ''
  }, got ${actualType}`;
}

const options: ExpressionOptions = {
  schema: { Count: { type: 'number' }, Name: { type: 'string' } },
  expectedResult: 'boolean',
};

const invalidSource = validateExpression('Name == Count', options);
if (!invalidSource.ok) {
  for (const diagnostic of invalidSource.diagnostics) console.log(describe(diagnostic));
  // BS_TYPE_MISMATCH at 1:1 — Equality operands must have compatible types.
}

const compilation = compileExpression('Count >= 10', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const invalidRecord = evaluateExpression(compilation.expression, { Count: 'high', Name: 'x' });
if (!invalidRecord.ok) console.log(describe(invalidRecord.diagnostic));
// BS_RUNTIME_TYPE_MISMATCH on Count (type-mismatch): expected number, got string
```

### Key Diagnostic Members

| Source member | Type | Description |
| --- | --- | --- |
| `kind` | `'source'` | Discriminant for the source variant. |
| `code` | Source diagnostic code | Stable machine-readable failure code. |
| `severity` | `'error'` | All v1 diagnostics are errors. |
| `message` | `string` | Concise guidance for the expression author. |
| `span` | `SourceSpan` | Zero-based, half-open UTF-16 range. |
| `location` | `SourceLocation` | One-based line and UTF-16 column coordinates for both ends. |
| `excerpt` | `string` (optional) | Bounded source context; omitted when empty. |

| Record member | Type | Description |
| --- | --- | --- |
| `kind` | `'record'` | Discriminant for the record variant. |
| `code` | `BS_MISSING_FIELD`, `BS_RUNTIME_TYPE_MISMATCH`, `BS_STRING_VALUE_LIMIT_EXCEEDED` | Stable record failure code. |
| `field` | `string` | The exact declared field that failed. |
| `reason` | `RecordDiagnosticReason` | One of `missing-field`, `accessor-property`, `null-not-allowed`, `type-mismatch`, `non-finite-number`, `string-too-long`. |
| `expectedType` | `ExpressionFieldType` | Declared type, including `scalar`. |
| `nullable` | `boolean` | Declared nullability of the failing field. |
| `actualType` | `RuntimeValueType` | Precise runtime classification of the rejected value, never its content. |

---

## 9. Deterministic Limits and the Work Budget

### What It Is

Every stage of BlendScript is bounded by fixed, exported limits, and evaluation is additionally governed by a deterministic work counter. Together they guarantee that any accepted expression terminates with a predictable, bounded amount of work — there is no input that can make the evaluator loop, allocate unboundedly, or hang.

### How It Works

- Compile-time limits are checked as early as possible: the source-length cap is measured before tokenization, the token cap during lexing, literal/field-name caps while decoding, the nesting cap in the parser, and the schema cap during options validation (which throws rather than returning a diagnostic).
- Evaluation charges one step per AST node visit. String built-ins precharge their native work — the length of their operands — *before* invoking the underlying JavaScript operation, so a costly comparison can never run unaccounted. Exceeding the 10,000-step budget fails with `BS_EVALUATION_STEP_LIMIT_EXCEEDED` at the span of the active node or call.
- `AND`/`OR` short-circuit at the AST level, and skipped branches are never visited — their calls, conversions, and charges do not happen at all.
- Derived strings (for example `upper(Text)` or the lowercased operands of `equalsIgnoreCase`) must also stay within 4,096 code units, or evaluation fails with `BS_STRING_VALUE_LIMIT_EXCEEDED`.

### Complete Example

```typescript
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { A: { type: 'string' }, B: { type: 'string' } },
};

// Short-circuiting: the unselected branch performs no work at all.
const shortCircuit = compileExpression('TRUE OR equalsIgnoreCase(A, B)', options);
if (!shortCircuit.ok) throw new Error(shortCircuit.diagnostics[0]?.message);

const largeA = 'a'.repeat(4_096);
const largeB = 'b'.repeat(4_096);

const skipped = evaluateExpression(shortCircuit.expression, { A: largeA, B: largeB });
if (!skipped.ok) throw new Error(skipped.diagnostic.message);
console.log(skipped.value); // true — equalsIgnoreCase was never charged

// The same comparison, actually selected, exhausts the 10,000-step budget.
const selected = compileExpression('equalsIgnoreCase(A, B)', options);
if (!selected.ok) throw new Error(selected.diagnostics[0]?.message);

const exhausted = evaluateExpression(selected.expression, { A: largeA, B: largeB });
if (!exhausted.ok) console.log(exhausted.diagnostic.code); // "BS_EVALUATION_STEP_LIMIT_EXCEEDED"

// Source-level limits are reported as diagnostics, not exceptions.
const oversized = validateExpression(' '.repeat(16_385), { schema: {} });
if (!oversized.ok) console.log(oversized.diagnostics[0]?.code); // "BS_SOURCE_TOO_LONG"
```

### Key Limits

| Limit | Value | Where it applies | Failure |
| --- | --- | --- | --- |
| Source length | 16,384 UTF-16 code units | Before lexing | `BS_SOURCE_TOO_LONG` |
| Token count | 4,096 tokens (excluding EOF) | Lexing | `BS_TOKEN_LIMIT_EXCEEDED` |
| String length | 4,096 UTF-16 code units | Literals, record strings, derived strings | `BS_STRING_LITERAL_TOO_LONG` / `BS_STRING_VALUE_LIMIT_EXCEEDED` |
| Field name length | 256 UTF-16 code units | Bracket names and schema keys | `BS_FIELD_NAME_TOO_LONG` / thrown `BS_INVALID_SCHEMA` |
| Schema size | 1,024 fields | Options snapshot | Thrown `BS_SCHEMA_FIELD_LIMIT_EXCEEDED` |
| Nesting depth | 64 levels | Grouping, `NOT`, calls | `BS_NESTING_LIMIT_EXCEEDED` |
| Semantic diagnostics | 20 per call | Analysis | Extra diagnostics are dropped |
| Evaluation steps | 10,000 per evaluation | Evaluation | `BS_EVALUATION_STEP_LIMIT_EXCEEDED` |
| Diagnostic excerpt | 120 UTF-16 code units | Source diagnostics | Excerpt is bounded |

### Key Work Charges

| Operation | Charged steps |
| --- | --- |
| Every AST node visit | 1 |
| `isEmpty(x)` | No extra charge |
| `isBlank(x)`, `trim(x)`, `lower(x)`, `upper(x)`, `length(x)` | `len(x)` |
| `tryNumber(x)` when `x` is a string | `len(x)` |
| `text(x)` | `len(result)` |
| `contains(value, search)`, `startsWith`, `endsWith` | `len(value) + len(search)` |
| `equalsIgnoreCase(left, right)` | `len(left) + len(right) + max(len(left), len(right))` |

---

## 10. The Input Boundary and Programmer Errors

### What It Is

BlendScript maintains a strict split between programmer-owned inputs — the source string, the options, the schema, the record container, and compiled handles — and authored or record data — the formula's meaning and the values inside record fields. Programmer misuse throws `BlendScriptApiError` with a stable machine-readable code; everything authored or stored returns diagnostics instead.

### How It Works

- Inputs are captured through own data descriptors only. Accessor properties on options, schema maps, or field descriptors are rejected without being invoked, and unknown members are rejected rather than ignored.
- The record container must be a caller-materialized ordinary object. Proxy-backed inputs cannot be detected without running their traps, so hosts that receive attacker-controlled objects must materialize them into ordinary objects before calling `evaluateExpression` — see Best Practices.
- Compiled handles are validated by `WeakMap` identity. Forged objects, serialized copies, and handles from a different package instance (direct build versus umbrella build) throw `BS_INVALID_COMPILED_EXPRESSION`.
- Rule authors' mistakes and data rows' mistakes never throw: they come back as `{ ok: false, diagnostics }` or `{ ok: false, diagnostic }`, so a host can show them in an editor or an import report. Catch `BlendScriptApiError` only to surface your own integration bugs — see Troubleshooting.

### Complete Example

```typescript
import {
  BlendScriptApiError,
  compileExpression,
  evaluateExpression,
  validateExpression,
  type ExpressionFieldSchema,
  type ExpressionOptions,
  type ExpressionSchema,
  type ExpressionValue,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' } },
  expectedResult: 'boolean',
};

// 1. Authoring problems are returned, never thrown.
const invalid = validateExpression('Missing', options);
if (!invalid.ok) {
  console.log(invalid.diagnostics[0]?.code); // "BS_UNKNOWN_FIELD"
}

// 2. Reserved schema keys are programmer errors: they throw.
try {
  validateExpression('TRUE', { schema: { constructor: { type: 'string' } } });
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.log(error.code); // "BS_INVALID_SCHEMA"
  }
}

// 3. Schema descriptors are validated member-by-member.
const descriptor = { type: 'string', extra: true } as const;
try {
  compileExpression('TRUE', { schema: { A: descriptor } });
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.log(error.code); // "BS_INVALID_SCHEMA"
  }
}

// 4. The schema field count is capped by a dedicated code.
const fields: Array<[string, ExpressionFieldSchema]> = Array.from(
  { length: 1_025 },
  (_, index): [string, ExpressionFieldSchema] => [`F${index}`, { type: 'boolean' }]
);
const overLimit: ExpressionSchema = Object.fromEntries(fields);
try {
  compileExpression('TRUE', { schema: overLimit });
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.log(error.code); // "BS_SCHEMA_FIELD_LIMIT_EXCEEDED"
  }
}

// 5. Records are read through own data descriptors only.
const compilation = compileExpression('Country == "NL"', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const record: Record<string, ExpressionValue> = { Country: 'NL' };
let undeclaredReads = 0;
Object.defineProperty(record, 'Extra', {
  get(): ExpressionValue {
    undeclaredReads += 1;
    return 'ignored';
  },
  enumerable: true,
});

const result = evaluateExpression(compilation.expression, record);
if (!result.ok) throw new Error(result.diagnostic.message);
console.log(result.value, undeclaredReads); // true 0 — the undeclared getter was never invoked
```

### Key Error Codes

| `BlendScriptApiErrorCode` | Thrown when |
| --- | --- |
| `BS_INVALID_ARGUMENT` | The expression source is not a string, or evaluation data is not a caller-materialized ordinary object. |
| `BS_INVALID_OPTIONS` | Options are not an ordinary object, carry unknown/accessor/symbol members, omit `schema`, or carry an invalid `expectedResult`. |
| `BS_INVALID_SCHEMA` | Schema rules are violated: reserved or symbol keys, accessor properties, unsupported descriptor members, field-name length outside 1–256, or invalid `type`/`nullable` values. |
| `BS_SCHEMA_FIELD_LIMIT_EXCEEDED` | The schema declares more than 1,024 fields. |
| `BS_INVALID_COMPILED_EXPRESSION` | `evaluateExpression` receives anything the current package instance did not create — forged objects, serialized copies, or handles from another package copy. |

---

## Where To Go Next

- Basic Usage — the complete three-function workflow, step by step.
- Advanced Patterns — compile-once pipelines, rule storage, mixed scalar data.
- Best Practices — hosting BlendScript safely at an application boundary.
- Common Scenarios — business rules translated into BlendScript formulas.
- Testing Patterns — exercising validation, compilation, and evaluation in test suites.
- Troubleshooting — mapping diagnostic codes to causes and fixes.
- API Reference — every exported symbol, diagnostic code, and limit in one place.

---

# blendscript Basic Usage

A step-by-step guide from installation to a first working rule. You declare the fields an expression may reference in an explicit schema, check and compile the expression once, and evaluate the resulting handle against records — with typed results and structured diagnostics at every step.

---

## Installation

```bash
# npm
npm install blendsdk

# yarn
yarn add blendsdk

# pnpm
pnpm add blendsdk
```

Published npm builds ship this package byte-for-byte inside the `blendsdk` umbrella at its `blendsdk/blendscript` entry point. Inside the BlendSDK monorepo, the identical build is available as the private workspace package `blendsdk/blendscript`; every example in this guide uses that direct specifier — if you installed the umbrella, replace it with `blendsdk/blendscript`. Both entry points expose the same four runtime symbols (`validateExpression`, `compileExpression`, `evaluateExpression`, `BlendScriptApiError`) and the same type declarations.

| Requirement | Value |
| ----------- | ----- |
| Runtime | Node.js >= 22.0.0 |
| Module system | ESM only (`"type": "module"`); no `require()` |
| Runtime dependencies | None — the implementation uses only ECMAScript built-ins |
| Types | `.d.ts` declarations ship next to every module; strict mode |

---

## Quick Start

Two function calls: compile a rule against a schema, then evaluate the reusable handle against a record.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, { Country: 'NL', OrderTotal: 1250 });
if (!result.ok) throw new Error(result.diagnostic.message);

console.log(result.value); // true
```

`compileExpression` checks the source against the schema and returns an opaque, reusable handle. `evaluateExpression` runs that handle against one record and returns `{ ok: true, value }` or `{ ok: false, diagnostic }` — authored-source and record problems are returned as values, never thrown.

---

## Fundamentals

### 1. Declare the fields an expression may reference

The schema is the complete contract: an expression can only reference fields you declare, matched exactly (case-sensitive, no normalization).

```typescript
import { compileExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
    IsPriority: { type: 'boolean', nullable: true },
  },
});

if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

console.log(compilation.resultType); // { type: 'boolean', nullable: false }
console.log(compilation.referencedFields); // [ 'Country', 'OrderTotal' ]
```

Referencing anything else is an authoring error, reported with an exact location:

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const result = validateExpression('Country == "NL"', {
  schema: { CountryName: { type: 'string' } },
});

if (!result.ok) {
  console.log(result.diagnostics[0]?.code); // 'BS_UNKNOWN_FIELD'
  console.log(result.diagnostics[0]?.message);
  // 'Field "Country" is not declared in the schema.'
}
```

Each field declares its value shape and whether the record may contain `null`:

| `type` | The record must provide | Notes |
| ------ | ----------------------- | ----- |
| `'string'` | A string | At most 4,096 UTF-16 code units per value |
| `'number'` | A finite number | `NaN`, `Infinity`, and `-Infinity` are rejected at evaluation |
| `'boolean'` | `true` or `false` | |
| `'scalar'` | A string or a finite number | Preserved exactly; convert with `text(...)` or `tryNumber(...)` |

`nullable` defaults to `false`, so a field rejects explicit `null` unless you opt in. Names with spaces — or names that look like keywords — use bracket syntax, where a literal `]` inside a name is escaped as `]]`:

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const result = validateExpression('[Order Total] >= 1000 AND [A]]B] == TRUE', {
  schema: {
    'Order Total': { type: 'number' },
    'A]B': { type: 'boolean' },
  },
});

if (!result.ok) throw new Error(result.diagnostics[0]?.message);
console.log(result.referencedFields); // [ 'Order Total', 'A]B' ]
```

### 2. Write expressions with a small, closed grammar

Expressions are spreadsheet-style: literals, field references, comparisons, logic, and membership. Literals are `TRUE`, `FALSE`, `NULL`, double-quoted strings (with `\"`, `\\`, `\n`, `\t`, `\uXXXX` escapes), and finite decimal numbers.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const literals = ['TRUE', 'FALSE', 'NULL', '"NL"', '42', '-12.5', '1e3'];
for (const source of literals) {
  const result = validateExpression(source, { schema: {} });
  console.log(source, result.ok ? result.resultType : result.diagnostics[0]?.code);
}
// TRUE  { type: 'boolean', nullable: false }
// FALSE { type: 'boolean', nullable: false }
// NULL  { type: 'null', nullable: true }
// "NL"  { type: 'string', nullable: false }
// 42    { type: 'number', nullable: false }
// -12.5 { type: 'number', nullable: false }
// 1e3   { type: 'number', nullable: false }
```

| Expression | Also written | Meaning |
| ---------- | ------------ | ------- |
| `NOT A` | `!A` | Logical negation |
| `A AND B` | `A && B` | Logical conjunction; short-circuits |
| `A OR B` | `A \|\| B` | Logical disjunction; short-circuits |
| `A == B`, `A != B` | | Strict equality; never coerces |
| `A < B`, `A <= B`, `A > B`, `A >= B` | | Numeric ordering |
| `A IN ("x", "y")` | | Strict membership in a non-empty list of primitive literals |

Precedence, from tightest to loosest: `NOT` → comparisons and `IN` → `AND` → `OR`; parentheses override it. Keyword operators and built-in names are case-insensitive; field names are not. Comparisons do not chain (`1 < 2 < 3` is a syntax error — use `AND`), and there is deliberately no arithmetic, comments, or date/regex syntax.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression(
  '(Country IN ("NL", "BE") OR IsPriority == TRUE) AND OrderTotal >= 1000',
  {
    schema: {
      Country: { type: 'string' },
      IsPriority: { type: 'boolean' },
      OrderTotal: { type: 'number' },
    },
  }
);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, {
  Country: 'DE',
  IsPriority: true,
  OrderTotal: 2500,
});
if (!result.ok) throw new Error(result.diagnostic.message);

console.log(result.value); // true — (false OR true) AND true
```

### 3. Validate source while it is being authored

`validateExpression` runs the full lexical, syntax, and type check and retains no executable state — ideal for editors and rule forms.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const options = {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
  },
} as const;

const valid = validateExpression('Country == "NL" OR OrderTotal >= 1000', options);
if (valid.ok) {
  console.log(valid.resultType); // { type: 'boolean', nullable: false }
  console.log(valid.referencedFields); // [ 'Country', 'OrderTotal' ]
}

const invalid = validateExpression('Country == 1', options);
if (!invalid.ok) {
  for (const diagnostic of invalid.diagnostics) {
    console.log(diagnostic.kind); // 'source'
    console.log(diagnostic.code); // 'BS_TYPE_MISMATCH'
    console.log(diagnostic.severity); // 'error'
    console.log(diagnostic.message); // 'Equality operands must have compatible types.'
    console.log(diagnostic.span); // { start: 0, end: 12 }
    console.log(diagnostic.location); // { line: 1, column: 1, endLine: 1, endColumn: 13 }
    console.log(diagnostic.excerpt); // 'Country == 1'
  }
}
```

The pipeline fails fast: a lexical or syntax error returns exactly one diagnostic, while semantic analysis returns up to 20 diagnostics ordered by source position. Results and diagnostics are frozen. `compileExpression` shares the same pipeline, so for identical input it returns the same diagnostics, `resultType`, and `referencedFields` — plus the handle.

### 4. Compile once, evaluate many times

Compilation captures everything the evaluator needs; the handle is then reused for any number of records.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const records = [
  { Country: 'NL', OrderTotal: 1250 },
  { Country: 'NL', OrderTotal: 40 },
  { Country: 'DE', OrderTotal: 900 },
];

for (const record of records) {
  const result = evaluateExpression(compilation.expression, record);
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(result.value); // true, false, false
}
```

Each successful compilation returns a fresh handle. Evaluation is deterministic, retains no record state, and never mutates the handle or the record. Handles are in-memory, package-instance-owned values: they cannot be serialized or transferred between processes — persist the source and schema, then recompile after loading.

### 5. Call the fixed built-ins for string handling

Twelve built-ins cover everyday rule text; the set is closed and there is no registration API.

| Built-in | Signature | Result | Null handling |
| -------- | --------- | ------ | ------------- |
| `isEmpty(value)` | `string → boolean` | `true` when `value` is `null` or `""` | Accepts `null` → `true` |
| `isBlank(value)` | `string → boolean` | `true` when `value` is `null` or whitespace-only | Accepts `null` → `true` |
| `contains(value, search)` | `string, string → boolean` | Substring test | Rejects `null` |
| `startsWith(value, search)` | `string, string → boolean` | Prefix test | Rejects `null` |
| `endsWith(value, search)` | `string, string → boolean` | Suffix test | Rejects `null` |
| `equalsIgnoreCase(left, right)` | `string, string → boolean` | Case-insensitive equality (non-locale) | Rejects `null` |
| `trim(value)` | `string → string` | Removes leading/trailing whitespace | Rejects `null` |
| `lower(value)` | `string → string` | Lowercase form | Rejects `null` |
| `upper(value)` | `string → string` | Uppercase form | Rejects `null` |
| `length(value)` | `string → number` | Counts Unicode code points (`length("😀a")` → `2`) | Rejects `null` |
| `tryNumber(value)` | `scalar → number \| null` | Complete decimal text → finite number; otherwise `null` | Accepts `null` → `null` |
| `text(value)` | `scalar → string` | Exact text of a string or finite number | Rejects `null` |

Names are case-insensitive (`TRIM(x)` and `trim(x)` are the same built-in), and calls nest freely:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression(
  'startsWith(lower(trim(Name)), "blend") AND length(Code) >= 2',
  {
    schema: { Name: { type: 'string' }, Code: { type: 'string' } },
  }
);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, {
  Name: '  BlendScript  ',
  Code: 'NL01',
});
if (!result.ok) throw new Error(result.diagnostic.message);

console.log(result.value); // true
```

Argument count and types are checked statically: `trim()` fails with `BS_INVALID_ARGUMENT_COUNT`, `trim(TRUE)` and `trim(NULL)` with `BS_TYPE_MISMATCH`. Passing a *nullable field* where `null` cannot be used compiles, and the failure surfaces at evaluation with `BS_NULL_NOT_ALLOWED`.

### 6. Enforce the expected result type

`expectedResult` makes the result type part of the contract — the expression must infer exactly that non-null type, or validation fails.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const mismatched = validateExpression('"yes"', {
  schema: {},
  expectedResult: 'boolean',
});

if (!mismatched.ok) {
  console.log(mismatched.diagnostics[0]?.code); // 'BS_EXPECTED_RESULT_TYPE_MISMATCH'
  console.log(mismatched.diagnostics[0]?.message);
  // 'Expression result must be a non-null boolean.'
}

const accepted = validateExpression('Country == "NL"', {
  schema: { Country: { type: 'string' } },
  expectedResult: 'boolean',
});
console.log(accepted.ok); // true
```

A nullable result cannot satisfy a non-null `expectedResult` (use `expectedResult: 'null'` to accept a `NULL` result). For rule engines this is the key guard: enforce `'boolean'` at authoring time and every stored rule is guaranteed to return a boolean.

### 7. Convert mixed `scalar` values explicitly

`scalar` fields hold either a string or a finite number and preserve it exactly — there is no implicit coercion, so rules must convert deliberately.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { Item: { type: 'scalar' } } as const;

// Direct scalar use where a concrete type is required fails static analysis.
const direct = compileExpression('Item > 1', { schema });
if (!direct.ok) {
  console.log(direct.diagnostics[0]?.code); // 'BS_TYPE_MISMATCH'
  console.log(direct.diagnostics[0]?.message);
  // 'Ordering comparisons require numeric operands. Use text(...) or tryNumber(...) to convert scalar values explicitly.'
}

// Numeric rules convert explicitly and guard the nullable conversion.
const numericRule = compileExpression('tryNumber(Item) != NULL AND tryNumber(Item) > 1', {
  schema,
});
if (!numericRule.ok) throw new Error(numericRule.diagnostics[0]?.message);

const numeric = evaluateExpression(numericRule.expression, { Item: '2' });
if (numeric.ok) console.log(numeric.value); // true

const unconvertible = evaluateExpression(numericRule.expression, { Item: 'ABC-1' });
if (unconvertible.ok) console.log(unconvertible.value); // false — tryNumber returns null, the guard fails

// Textual rules convert explicitly and compare exactly.
const textualRule = compileExpression('text(Item) == "001"', { schema });
if (!textualRule.ok) throw new Error(textualRule.diagnostics[0]?.message);

const exact = evaluateExpression(textualRule.expression, { Item: '001' });
if (exact.ok) console.log(exact.value); // true

const notExact = evaluateExpression(textualRule.expression, { Item: 1 });
if (notExact.ok) console.log(notExact.value); // false — text(1) is "1", not "001"
```

- `tryNumber(value)`: finite numbers pass through unchanged; complete decimal text parses (`"001"` → `1`, `".5"` → `0.5`); anything else — including partial text like `"1abc"` or non-finite results like `"1e309"` — returns `null`. Because the result is nullable, guard with `!= NULL` before ordering comparisons. `tryNumber(NULL)` returns `null`.
- `text(value)`: strings pass through exactly; finite numbers use their JavaScript text form (`text(1)` → `'1'`).

### 8. Records are validated in full before the expression runs

Every evaluation snapshots the record and validates *all* declared fields — even fields the expression does not reference — in captured schema order.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('TRUE', {
  schema: {
    Code: { type: 'string', nullable: true },
    Count: { type: 'number' },
  },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

// The expression references nothing, yet every declared field is preflighted.
const missing = evaluateExpression(compilation.expression, { Code: null });
if (!missing.ok && missing.diagnostic.kind === 'record') {
  console.log(missing.diagnostic.code); // 'BS_MISSING_FIELD'
  console.log(missing.diagnostic.field); // 'Count'
  console.log(missing.diagnostic.reason); // 'missing-field'
  console.log(missing.diagnostic.actualType); // 'missing'
}

const invalid = evaluateExpression(compilation.expression, { Code: null, Count: '12' });
if (!invalid.ok && invalid.diagnostic.kind === 'record') {
  console.log(invalid.diagnostic.code); // 'BS_RUNTIME_TYPE_MISMATCH'
  console.log(invalid.diagnostic.field); // 'Count'
  console.log(invalid.diagnostic.reason); // 'type-mismatch'
  console.log(invalid.diagnostic.expectedType); // 'number'
  console.log(invalid.diagnostic.actualType); // 'string'
}

const valid = evaluateExpression(compilation.expression, { Code: null, Count: 12 });
if (valid.ok) console.log(valid.value); // true — null is accepted on the nullable field
```

- Fields must be own data properties on an ordinary object. Getter properties are rejected without ever being invoked, and undeclared extras are ignored and never read.
- `nullable: true` is the only way a field accepts `null`; everything else fails with `reason: 'null-not-allowed'`.
- The first failing field in schema order is reported, and record diagnostics are value-free — they carry only `reason`, `expectedType`, `nullable`, and `actualType`, never the rejected value.
- The record is never mutated; results and diagnostics are frozen.

---

## Configuration

Every configuration value is passed per call; BlendScript keeps no global state.

### ExpressionOptions

| Name | Type | Default | Description |
| ---- | ---- | ------- | ----------- |
| `schema` | `ExpressionSchema` | — (required) | The complete set of fields the expression may reference. Names match exactly; 1–256 UTF-16 code units each; `__proto__`, `prototype`, and `constructor` are reserved. |
| `expectedResult` | `ExpressionValueType` | `undefined` (no constraint) | Exact, non-null result type required from the expression: `'string'`, `'number'`, `'boolean'`, or `'null'`. |

### ExpressionFieldSchema

| Name | Type | Default | Description |
| ---- | ---- | ------- | ----------- |
| `type` | `ExpressionFieldType` | — (required) | `'string'`, `'number'`, `'boolean'`, or `'scalar'`. |
| `nullable` | `boolean` | `false` | When `true`, the record may provide explicit `null` for this field. |

```typescript
import {
  compileExpression,
  evaluateExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
    Code: { type: 'string', nullable: true },
  },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Country == "NL" AND Code != NULL', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, {
  Country: 'NL',
  OrderTotal: 1200,
  Code: 'X1',
});
if (result.ok) console.log(result.value); // true
```

Options, schemas, and records are snapshotted at the call through own data descriptors — later caller mutations cannot change behavior:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema: Record<string, { type: 'boolean' | 'string' }> = {
  Enabled: { type: 'boolean' },
};
const compilation = compileExpression('Enabled', { schema });
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

// The schema is captured when compileExpression is called.
schema.Enabled = { type: 'string' };

const result = evaluateExpression(compilation.expression, { Enabled: true });
if (result.ok) console.log(result.value); // true — checked against the captured boolean schema
```

Options, schemas, and records must be caller-materialized ordinary objects (object literals or `Object.create(null)`); accessor properties, class instances, arrays, and symbol keys are rejected without their getters running. Proxy-backed inputs must be materialized into ordinary objects by the host, because proxy traps cannot be detected without running them.

### Fixed limits

These bounds are constants of the language, not configuration options:

| Limit | Value | Reported as |
| ----- | ----- | ----------- |
| Source length | 16,384 UTF-16 code units | `BS_SOURCE_TOO_LONG` |
| Token count | 4,096 tokens | `BS_TOKEN_LIMIT_EXCEEDED` |
| String literal length | 4,096 UTF-16 code units | `BS_STRING_LITERAL_TOO_LONG` |
| Field name / schema key length | 256 UTF-16 code units | `BS_FIELD_NAME_TOO_LONG` (source), `BS_INVALID_SCHEMA` (options) |
| Schema field count | 1,024 fields | `BS_SCHEMA_FIELD_LIMIT_EXCEEDED` (thrown) |
| Nesting depth | 64 levels | `BS_NESTING_LIMIT_EXCEEDED` |
| Semantic diagnostics per call | 20 | Extra diagnostics are dropped |
| Evaluation work | 10,000 deterministic steps | `BS_EVALUATION_STEP_LIMIT_EXCEEDED` |

Short-circuiting means unselected branches perform no work, so a rule only pays for what it actually evaluates.

---

## Error Handling

### Returned failures vs. thrown errors

| Channel | Used for | How it surfaces |
| ------- | -------- | --------------- |
| Result value | Authored source (validation and compilation) and record/evaluation data problems | `{ ok: false, diagnostics }` or `{ ok: false, diagnostic }` — never thrown |
| Thrown error | Programmer misuse: invalid arguments, options, schemas, or handles | `BlendScriptApiError` with a stable `code` |

### Handling returned diagnostics

Source diagnostics are returned by `validateExpression` and `compileExpression`; runtime diagnostics (null usage, derived string limits, work limits) and record diagnostics are returned by `evaluateExpression`.

```typescript
import { compileExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('tirm(Code)', {
  schema: { Code: { type: 'string' } },
});

if (!compilation.ok) {
  const first = compilation.diagnostics[0];
  if (first) {
    console.error(`${first.code} at ${first.location.line}:${first.location.column}`);
    // 'BS_UNEXPECTED_TOKEN at 1:5'
    console.error(first.message); // 'Only documented BlendScript built-ins can be called.'
  }
}
```

Evaluation returns either a source diagnostic (an operation reached by an otherwise valid expression) or a record diagnostic (a declared field that failed validation):

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('trim(Code) == "X1"', {
  schema: { Code: { type: 'string', nullable: true } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const nullResult = evaluateExpression(compilation.expression, { Code: null });
if (!nullResult.ok) {
  const { diagnostic } = nullResult;
  if (diagnostic.kind === 'source') {
    console.error(diagnostic.code); // 'BS_NULL_NOT_ALLOWED'
    console.error(diagnostic.message); // 'Built-in trim cannot use a null argument.'
  }
}

const wrongType = evaluateExpression(compilation.expression, { Code: 42 });
if (!wrongType.ok) {
  const { diagnostic } = wrongType;
  if (diagnostic.kind === 'record') {
    console.error(diagnostic.code); // 'BS_RUNTIME_TYPE_MISMATCH'
    console.error(diagnostic.reason); // 'type-mismatch'
    console.error(diagnostic.field); // 'Code'
    console.error(diagnostic.expectedType); // 'string'
    console.error(diagnostic.actualType); // 'number'
    console.error(diagnostic.nullable); // true
  }
}
```

### Handling thrown BlendScriptApiError

A forged or revived handle is programmer misuse, not a rule problem:

```typescript
import {
  BlendScriptApiError,
  evaluateExpression,
  type CompiledExpression,
} from 'blendsdk/blendscript';

// Compiled handles are instance-owned memory values and cannot be serialized
// or revived; a lookalike restored from storage is rejected. Persist the
// source and schema instead, and compile again after loading.
const restored: unknown = JSON.parse('{}');

try {
  evaluateExpression(restored as CompiledExpression, {});
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.error(error.name); // 'BlendScriptApiError'
    console.error(error.code); // 'BS_INVALID_COMPILED_EXPRESSION'
    console.error(error.message);
    // 'Expected a compiled expression created by this package instance.'
  } else {
    throw error;
  }
}
```

### Diagnostic and error code reference

`BlendScriptApiError` codes (thrown — fix the calling code, not the expression):

| Code | Thrown when |
| ---- | ----------- |
| `BS_INVALID_ARGUMENT` | `source` is not a string, or evaluation data is not an ordinary object |
| `BS_INVALID_OPTIONS` | Options are not a caller-materialized ordinary object, `schema` is missing, a member is unknown or an accessor, or `expectedResult` is not `'string' \| 'number' \| 'boolean' \| 'null'` |
| `BS_INVALID_SCHEMA` | A schema or field descriptor is not an ordinary object, uses accessors or symbol keys, uses unknown members, has a reserved name, a name outside 1–256 code units, or an invalid `type`/`nullable` |
| `BS_SCHEMA_FIELD_LIMIT_EXCEEDED` | The schema declares more than 1,024 fields |
| `BS_INVALID_COMPILED_EXPRESSION` | `evaluateExpression` received a handle that was not created by this package instance |

Source diagnostic codes (returned — fix the expression or its input data):

| Code | Meaning |
| ---- | ------- |
| `BS_SOURCE_TOO_LONG` | Source exceeds 16,384 UTF-16 code units |
| `BS_TOKEN_LIMIT_EXCEEDED` | Source produces more than 4,096 tokens |
| `BS_STRING_LITERAL_TOO_LONG` | A string literal exceeds 4,096 UTF-16 code units |
| `BS_FIELD_NAME_TOO_LONG` | A bracketed field name exceeds 256 UTF-16 code units |
| `BS_NESTING_LIMIT_EXCEEDED` | Parentheses nest deeper than 64 levels |
| `BS_INVALID_CHARACTER` | A character is outside BlendScript syntax |
| `BS_INVALID_STRING` | Malformed string literal (missing quote, unsupported escape, raw line break, unpaired surrogate) |
| `BS_INVALID_NUMBER` | Malformed or non-finite number literal |
| `BS_UNEXPECTED_TOKEN` | Syntax error: unexpected token, chained comparison, invalid `IN` list, or an unknown call target |
| `BS_UNKNOWN_FIELD` | A referenced name is not declared in the schema |
| `BS_TYPE_MISMATCH` | Statically incompatible operands or built-in arguments |
| `BS_INVALID_ARGUMENT_COUNT` | A built-in received the wrong number of arguments |
| `BS_EXPECTED_RESULT_TYPE_MISMATCH` | The inferred result does not match `expectedResult` |
| `BS_NULL_NOT_ALLOWED` (evaluation) | Runtime `null` reached an operation that cannot use it |
| `BS_STRING_VALUE_LIMIT_EXCEEDED` (evaluation) | A value or derived string exceeds 4,096 UTF-16 code units |
| `BS_EVALUATION_STEP_LIMIT_EXCEEDED` (evaluation) | Evaluation exceeded the 10,000-step work budget |

Record diagnostic codes (returned by `evaluateExpression`, always with `kind: 'record'`):

| Code | Reasons | Meaning |
| ---- | ------- | ------- |
| `BS_MISSING_FIELD` | `missing-field` | A declared field is absent from the record |
| `BS_RUNTIME_TYPE_MISMATCH` | `type-mismatch`, `null-not-allowed`, `accessor-property`, `non-finite-number` | A declared field is present but unusable |
| `BS_STRING_VALUE_LIMIT_EXCEEDED` | `string-too-long` | A declared field value exceeds 4,096 UTF-16 code units |

`actualType` classifies the rejected value without reading it, and is one of: `missing`, `accessor`, `null`, `undefined`, `string`, `number`, `non-finite-number`, `boolean`, `bigint`, `symbol`, `function`, `array`, or `object`.

---

Continue with Advanced Patterns for composing larger rules, API Reference for the complete exported surface, and Troubleshooting for symptom-to-diagnostic guidance.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
