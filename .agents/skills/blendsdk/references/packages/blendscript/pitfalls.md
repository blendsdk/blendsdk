> **Package**: `blendsdk/blendscript`

# blendscript Best Practices

BlendScript's guarantees — safe interpretation, zero coercion, deterministic resource bounds — come from a small set of design choices. The practices below keep your integration aligned with those choices: authoring problems are data, compiled rules are immutable handles, boundaries accept only plain caller-materialized values, and evaluation never leaves the documented envelope. Each pair shows the counterexample first, with the failure it actually produces, followed by the recommended pattern. The anti-patterns, performance tips, and security notes are drawn from the package's own source and test suites.

---

## Do / Don't Pairs

### 1. Branch on `ok` — authoring problems are returned, not thrown

**❌ Don't** — wrap compilation in `try`/`catch` and assume the result is a success:

```typescript fragment
// A single '=' is invalid syntax. The call returns { ok: false } — it never
// throws — so the catch block never runs and the malformed rule is saved.
try {
  const compilation = compileExpression('Country = "NL"', options);
  await ruleStore.save({ id, compilation });
} catch (error) {
  await showFormulaError(error);
}
```

**✅ Do** — check `ok` and treat diagnostics as data:

```typescript
import { compileExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' } },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Country = "NL"', options);
if (!compilation.ok) {
  for (const diagnostic of compilation.diagnostics) {
    const { line, column } = diagnostic.location;
    console.error(`${diagnostic.code} ${line}:${column} ${diagnostic.message}`);
  }
} else {
  console.log('compiled', compilation.referencedFields);
}
```

**Why:** `validateExpression` and `compileExpression` report everything an author can get wrong — syntax, unknown fields, type mismatches, result-type mismatches — as `{ ok: false, diagnostics }`. Only programmer misuse throws `BlendScriptApiError`. A blanket `try`/`catch` therefore misses the exact case it was written for, while masking genuine integration bugs such as `BS_INVALID_SCHEMA` as if the user's formula were at fault. In strict TypeScript the union already prevents reading `compilation.expression` before the check; keep it that way.

---

### 2. Compile once, evaluate many

**❌ Don't** — run the pipeline inside the per-record loop:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' } },
  expectedResult: 'boolean',
};

const countries = ['NL', 'BE', 'NL', 'DE'];

for (const Country of countries) {
  // The full lex → parse → analyze → handle pipeline runs for every record.
  const compilation = compileExpression('Country == "NL"', options);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
  const result = evaluateExpression(compilation.expression, { Country });
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(Country, result.value);
}
```

**✅ Do** — compile the rule once and reuse the handle:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' } },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Country == "NL"', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
const rule = compilation.expression;

const countries = ['NL', 'BE', 'NL', 'DE'];

for (const Country of countries) {
  const result = evaluateExpression(rule, { Country });
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(Country, result.value);
}
```

**Why:** each compile runs lexing, parsing, static analysis, schema snapshotting, and payload allocation — work that does not depend on the record. A compiled handle is frozen, carries no record state, and can be evaluated any number of times, so compilation belongs at startup or at rule publication. Recompiling per record throws that work away and multiplies it by your data volume.

---

### 3. `validateExpression` for editors, `compileExpression` for execution — not both per request

**❌ Don't** — validate and compile together on the hot path:

```typescript fragment
// Both calls run the same lexer, parser, and analyzer. The draft has been
// fixed since publication, so the validation result can never change.
function decide(source: string, record: Readonly<Record<string, ExpressionValue>>) {
  const validation = validateExpression(source, options);
  if (!validation.ok) throw new Error(validation.diagnostics[0]?.message);
  const compilation = compileExpression(source, options);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
  return evaluateExpression(compilation.expression, record);
}
```

**✅ Do** — keep three boundaries: draft-check, publish, decide:

```typescript
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';
import type {
  CompilationResult,
  CompiledExpression,
  ExpressionOptions,
  ExpressionValue,
  ValidationResult,
} from 'blendsdk/blendscript';

// Authoring boundary: run per edit (debounced) and surface diagnostics to the author.
function checkDraft(draft: string, options: ExpressionOptions): ValidationResult {
  return validateExpression(draft, options);
}

// Deployment boundary: run once when the rule is published.
function publishRule(source: string, options: ExpressionOptions): CompiledExpression {
  const compilation: CompilationResult = compileExpression(source, options);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
  return compilation.expression;
}

// Request boundary: run per record with the published handle.
function decide(
  rule: CompiledExpression,
  record: Readonly<Record<string, ExpressionValue>>
) {
  return evaluateExpression(rule, record);
}

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' } },
  expectedResult: 'boolean',
};

console.log(checkDraft('Country == "NL"', options).ok); // true
const rule = publishRule('Country == "NL"', options);
console.log(decide(rule, { Country: 'NL' })); // { ok: true, value: true }
```

**Why:** `validateExpression` stops after analysis and retains no executable state; `compileExpression` continues along the same pipeline into the handle factory. Running both doubles authoring cost, and running either per request means the hot path pays for work that can only change at authoring time.

---

### 4. Persist the source and schema; recompile after loading

**❌ Don't** — store, serialize, or rehydrate compiled handles:

```typescript fragment
// A handle is an in-memory brand plus a private WeakMap entry: JSON.stringify
// yields "{}", and the payload stays behind in the compiling process.
await ruleStore.save({ id, compiled: compilation.expression });
```

```typescript fragment
// This can never evaluate: the handle was not created by this instance.
const row = await ruleStore.load(id);
evaluateExpression(JSON.parse(row.compiled), record); // throws BS_INVALID_COMPILED_EXPRESSION
```

**✅ Do** — persist the readable source and compile it after loading:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';
import type { CompiledExpression, ExpressionOptions } from 'blendsdk/blendscript';

interface StoredRule {
  readonly source: string;
  readonly schemaVersion: number;
}

const persisted: StoredRule = {
  source: 'Country == "NL" AND OrderTotal >= 1000',
  schemaVersion: 3,
};

const schemaForVersion: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
  },
  expectedResult: 'boolean',
};

function compileStoredRule(rule: StoredRule): CompiledExpression {
  const compilation = compileExpression(rule.source, schemaForVersion);
  if (!compilation.ok) {
    // Surface stored-rule problems at deployment, not at first evaluation.
    throw new Error(compilation.diagnostics[0]?.message);
  }
  return compilation.expression;
}

const rule = compileStoredRule(persisted);
const result = evaluateExpression(rule, { Country: 'NL', OrderTotal: 1250 });
if (!result.ok) throw new Error(result.diagnostic.message);
console.log(result.value); // true
```

**Why:** a compiled expression "is valid only in the loaded package instance that created it" — that is the package's own contract. The handle carries no source, so it is not even self-describing. Storing `source` plus the schema version lets you re-validate stored rules at deploy time (migrating old rules loudly instead of failing on first evaluation), and matches the package's advice: "Keep the original source when persistence is required and compile it after loading."

---

### 5. Treat the schema as a two-way contract and pin `expectedResult`

**❌ Don't** — declare fields the application does not (or cannot) provide, and leave the rule's result type unchecked:

```typescript fragment
// OrderTotal is declared but never produced. Every declared field is required
// at evaluation — even fields the formula never references.
const options = { schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } } };
const compilation = compileExpression('Country == "NL"', options);
evaluateExpression(compilation.expression, { Country: 'NL' });
// → { ok: false, diagnostic: { code: 'BS_MISSING_FIELD', field: 'OrderTotal' } }

// Without expectedResult this compiles and returns the string "yes".
validateExpression('"yes"', { schema: {} }); // { ok: true, resultType: { type: 'string' } }
```

**✅ Do** — declare exactly the record contract and require the rule's result type:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions, ExpressionValue } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
  },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

// Every declared field must be present as an own data property.
// Note that Readonly<Record<string, ExpressionValue>> cannot express this in the
// type system — the runtime enforces it, so build complete records.
const record: Readonly<Record<string, ExpressionValue>> = {
  Country: 'NL',
  OrderTotal: 1250,
};
const result = evaluateExpression(compilation.expression, record);
if (!result.ok) throw new Error(result.diagnostic.message);
console.log(result.value); // true
```

**Why:** the schema is the source-side contract (`BS_UNKNOWN_FIELD` for anything undeclared) and the record-side contract (every declared field must exist, including unreferenced ones, which are preflighted on every evaluation). `expectedResult` is a separate, stricter pin on the whole expression — use it for every decision rule so a formula that accidentally yields a string or a bare field fails at authoring time, not when a downstream consumer assumes truthiness. Note that `'scalar'` is valid as a *field type* but invalid as an `expectedResult`, and that `schema` is mandatory: use `{ schema: {} }` for literal-only expressions.

---

### 6. Materialize plain records at the boundary

**❌ Don't** — pass class instances, getter objects, or live host objects:

```typescript fragment
class OrderDto {
  public Country = 'NL';
}
evaluateExpression(rule, new OrderDto()); // throws BlendScriptApiError (BS_INVALID_ARGUMENT)

// Accessors are rejected without ever being invoked:
const record = { get Country() { return 'NL'; } };
evaluateExpression(rule, record);
// → { ok: false, diagnostic: { code: 'BS_RUNTIME_TYPE_MISMATCH', reason: 'accessor-property', actualType: 'accessor' } }
```

**✅ Do** — build records as plain objects from explicit fields:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions, ExpressionValue } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' } },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Country == "NL"', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

interface OrderRow {
  readonly country: string;
}

const row: OrderRow = { country: 'NL' };

const record: Readonly<Record<string, ExpressionValue>> = { Country: row.country };
const result = evaluateExpression(compilation.expression, record);
if (!result.ok) throw new Error(result.diagnostic.message);
console.log(result.value); // true
```

**Why:** the API inspects own property descriptors only, and that is precisely what makes it safe — getters, `toJSON`, `toString`, and `valueOf` are never invoked, and prototypes are never walked. Class instances and arrays are rejected as programmer errors (`BS_INVALID_ARGUMENT` for records, `BS_INVALID_SCHEMA` for schemas); accessors and inherited keys become precise diagnostics (`accessor-property`, `missing-field`). Proxies cannot be detected without running their traps, so the host must materialize them — for example from `JSON.parse` or explicit field picks — before evaluation. Extra undeclared keys are ignored and never read.

---

### 7. `scalar` fields require explicit conversion

**❌ Don't** — apply concrete-type operations directly to a scalar:

```typescript fragment
// ❌ Wrong: a scalar field preserves its string or number form;
// operators and built-ins never coerce it.
validateExpression('Item > 1', { schema: { Item: { type: 'scalar' } } });
// → BS_TYPE_MISMATCH ... Use text(...) or tryNumber(...) to convert scalar values explicitly.
```

**✅ Do** — convert with `tryNumber(...)` or `text(...)` and guard the nullable result:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Item: { type: 'scalar' }, Code: { type: 'scalar' } },
};

const numericRule = compileExpression('tryNumber(Item) != NULL AND tryNumber(Item) > 1', options);
if (!numericRule.ok) throw new Error(numericRule.diagnostics[0]?.message);

const textualRule = compileExpression('text(Code) == "001"', options);
if (!textualRule.ok) throw new Error(textualRule.diagnostics[0]?.message);

const numericResult = evaluateExpression(numericRule.expression, { Item: '2', Code: '001' });
if (!numericResult.ok) throw new Error(numericResult.diagnostic.message);
console.log(numericResult.value); // true

const textualResult = evaluateExpression(textualRule.expression, { Item: 2, Code: '001' });
if (!textualResult.ok) throw new Error(textualResult.diagnostic.message);
console.log(textualResult.value); // true
```

**Why:** `scalar` exists for genuinely mixed spreadsheet-like data, and its whole point is that `'1'` and `1` are different values until *you* decide otherwise. `tryNumber` parses only complete, locale-independent decimal text (`' 1'`, `'1abc'`, `'0x10'`, `'1e309'` all yield `null`) and returns `null` for null input, so its inferred type is nullable — an unguarded ordering comparison then fails at runtime with `BS_NULL_NOT_ALLOWED`. `text` formats numbers with plain `String(value)` and never accepts null. If the data is really always numeric or always textual, declare `number` or `string` instead of `scalar` and skip the conversion entirely.

---

### 8. Handle null deliberately

**❌ Don't** — assume a nullable field behaves like an empty string:

```typescript fragment
// ❌ Wrong: null is not "". `Address == ""` is FALSE for null, and the
// non-null-aware built-in fails at runtime with BS_NULL_NOT_ALLOWED.
'Address == ""'
'trim(Address)'
```

**✅ Do** — use null-aware built-ins, short-circuit guards, and literal comparisons:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Address: { type: 'string', nullable: true },
    Enabled: { type: 'boolean', nullable: true },
  },
  expectedResult: 'boolean',
};

// isBlank(null) is true, and the short-circuit guard keeps the
// non-null-aware operation unreachable when Address is null.
const guarded = compileExpression(
  'Address != NULL AND contains(trim(Address), "Street")',
  options
);
if (!guarded.ok) throw new Error(guarded.diagnostics[0]?.message);

for (const Address of [null, ' Main Street ', ' Other Lane ']) {
  const result = evaluateExpression(guarded.expression, { Address, Enabled: null });
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(Address, result.value); // null false, ' Main Street ' true, ' Other Lane ' false
}
```

```typescript fragment
// Null-safe boolean test: null == TRUE is FALSE, so this never throws.
'Enabled == TRUE'
```

**Why:** `nullable: true` is a declaration, not a behavior — null only reaches the evaluator when you allow it, and from then on you own the handling. `isEmpty(null)`, `isBlank(null)`, and `tryNumber(null)` are documented to absorb null; `trim`, `lower`, `upper`, `length`, `contains`, `startsWith`, `endsWith`, `equalsIgnoreCase`, and `text` are not, and fail with `BS_NULL_NOT_ALLOWED` at the operator's span. `AND`/`OR` short-circuit deterministically, so a `!= NULL` / `== NULL` guard makes the unsafe branch unreachable. Keeping a field required (`nullable` omitted) is the cheapest option when null is not a legitimate business value: record validation then reports `null-not-allowed` before the rule ever runs.

---

### 9. Keep comparisons type-correct and chain-free

**❌ Don't** — port JavaScript comparison habits:

```typescript fragment
// ❌ Wrong: comparisons never chain.
'0 < OrderTotal < 5000'    // BS_UNEXPECTED_TOKEN at the second '<'

// ❌ Wrong: ordering is numeric-only, with no string ordering.
'OrderTotal < "5000"'      // BS_TYPE_MISMATCH

// ❌ Wrong: NOT binds tighter than comparison, so this parses as (NOT Enabled) == TRUE.
// For a nullable Enabled, NOT throws BS_NULL_NOT_ALLOWED at runtime.
'NOT Enabled == TRUE'
```

**✅ Do** — write explicit range checks and parenthesized comparisons:

```typescript
import { validateExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    OrderTotal: { type: 'number' },
    Enabled: { type: 'boolean', nullable: true },
  },
  expectedResult: 'boolean',
};

const range = validateExpression('OrderTotal >= 0 AND OrderTotal < 5000', options);
const explicitNot = validateExpression('NOT (Enabled == TRUE)', options);

console.log(range.ok, explicitNot.ok); // true true
```

**Why:** the v1 grammar is deliberately closed — `AND`, `OR`, `NOT`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `IN`, grouping, and built-in calls; nothing else (`===`, assignment, arithmetic, ternary, comments, and template literals are all rejected). It also never coerces, so equality requires compatible types on both sides and ordering requires numbers on both sides. `NOT` binds tighter than comparisons, so parenthesize whenever you mean "the negation of a comparison". These constraints are what make the analyzer able to prove your rule before any record exists.

---

### 10. `IN` is for fixed literal lists

**❌ Don't** — try to compute or extend membership lists in source:

```typescript fragment
// ❌ Wrong: IN members must be primitive literals, and the list cannot be empty.
'Country IN (OtherCountry)'   // BS_UNEXPECTED_TOKEN at the member
'Country IN ()'               // BS_UNEXPECTED_TOKEN
'Country IN ("NL",)'          // BS_UNEXPECTED_TOKEN (trailing comma)

// ❌ Wrong: NULL is only compatible with a nullable left operand.
'Country IN ("NL", NULL)'     // BS_TYPE_MISMATCH when Country is required
```

**✅ Do** — use a literal list, and include `NULL` only when the field is nullable:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string', nullable: true } },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Country IN ("NL", "BE", "DE", NULL)', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

for (const Country of ['NL', 'XX', null]) {
  const result = evaluateExpression(compilation.expression, { Country });
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(Country, result.value); // NL true, XX false, null true
}
```

**Why:** `IN` is one node that compares the value against literals with exact (`===`) semantics — no coercion, duplicates allowed, `null` matched via an explicit `NULL` member. Because members are literals by design, dynamic lists (`IN (Allowed)`) are not expressible: an unbounded set belongs in the host as a boolean field on the record, and a fixed vocabulary of a few dozen values belongs in a literal list.

---

### 11. Strings: case, length, and escapes

**❌ Don't** — assume case-insensitive matching, or paste multi-line text:

```typescript fragment
// ❌ Wrong: contains is case-sensitive, so this misses "Netherlands".
'contains(Country, "netherlands")'

// ❌ Wrong: string literals cannot contain raw line breaks.
'"first line
second line"'
```

**✅ Do** — normalize explicitly and use escapes:

```typescript
import { validateExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Name: { type: 'string' },
    Search: { type: 'string' },
    'Order Note': { type: 'string' },
  },
  expectedResult: 'boolean',
};

// Whole-value, case-insensitive comparison.
console.log(validateExpression('equalsIgnoreCase(Name, Search)', options).ok); // true

// Case-insensitive substring search: normalize both sides explicitly.
console.log(validateExpression('contains(lower(Name), lower(Search))', options).ok); // true

// Multi-line text uses \n escapes; bracketed names carry spaces and keywords.
console.log(validateExpression('contains([Order Note], "\\n")', options).ok); // true
```

**Why:** `contains`, `startsWith`, `endsWith`, and `==` are exact; only `equalsIgnoreCase` folds case, and it is whole-value only. Folding uses non-locale `toLowerCase()`, so `'İ'` and `'i'` are different — normalize locale-sensitive text in the host instead of expecting the rule to do it. `length` counts Unicode code points (`length("😀a")` is 2, while JavaScript's `'😀a'.length` is 3) and is neither bytes nor grapheme clusters. Escapes are `\" \\ \n \r \t \b \f \uXXXX` with paired surrogate requirements; field names use brackets and escape `]` as `]]`.

---

### 12. Present diagnostics from stable fields

**❌ Don't** — match on message wording or look for the rejected value:

```typescript fragment
// ❌ Wrong: message text is human guidance and may be reworded between releases.
if (diagnostic.message === 'Field "Country" is not declared in the schema.') {
  highlightField('Country');
}

// ❌ Wrong: record diagnostics never carry the offending value — there is
// nothing to echo, by design.
console.log(diagnostic.actualValue);
```

**✅ Do** — switch on `code` / `reason` and use `location`:

```typescript
import { compileExpression } from 'blendsdk/blendscript';
import type { ExpressionOptions, SourceExpressionDiagnostic } from 'blendsdk/blendscript';

const options: ExpressionOptions = { schema: { Country: { type: 'string' } } };

function authorMessage(diagnostic: SourceExpressionDiagnostic): string {
  const { line, column } = diagnostic.location;
  switch (diagnostic.code) {
    case 'BS_UNKNOWN_FIELD':
      return `Line ${line}, column ${column}: this field is not part of the schema.`;
    case 'BS_TYPE_MISMATCH':
      return `Line ${line}, column ${column}: the types do not match. ${diagnostic.message}`;
    case 'BS_EXPECTED_RESULT_TYPE_MISMATCH':
      return `Line ${line}, column ${column}: the rule must return a strict result type.`;
    default:
      return `Line ${line}, column ${column}: ${diagnostic.message}`;
  }
}

const compilation = compileExpression('Country == 1', options);
if (!compilation.ok) {
  for (const diagnostic of compilation.diagnostics) {
    console.error(authorMessage(diagnostic));
  }
}
```

```typescript fragment
// Record failures: report the structured metadata, never the value.
if (!result.ok && result.diagnostic.kind === 'record') {
  const { field, reason, expectedType, nullable, actualType } = result.diagnostic;
  console.error(
    `record field ${field} failed: ${reason} (expected ${expectedType}, nullable=${nullable}, actual ${actualType})`
  );
}
```

**Why:** `code`, `reason`, `span`, `location`, and the metadata fields are the stable machine contract; `message` is concise guidance for the author and `excerpt` is bounded to 120 code units. Record diagnostics are value-free by design (`actualType` is a classification derived from the property descriptor, never the content), so any UI or log you build from them cannot leak record data. There is no `suggestion` member — field binding is exact and offers no fuzzy matching, so build your own hint from `span` when you need one.

---

### 13. Import from the package entry point and keep one instance

**❌ Don't** — deep-import internals or mix handles across entry points:

```typescript fragment
// ❌ Wrong: internal modules are private. The package exports only its root,
// and the umbrella re-exports the identical build.
import { compileExpression } from 'blendsdk/blendscript/dist/api.js';
```

```typescript fragment
// ❌ Wrong: a handle is owned by the instance that compiled it.
import { compileExpression } from 'blendsdk/blendscript';
import { evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('TRUE', { schema: {} });
// evaluateExpression(compilation.expression, {}) throws BS_INVALID_COMPILED_EXPRESSION
```

**✅ Do** — import the public API from a single entry point:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('TRUE', { schema: {} });
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, {});
if (!result.ok) throw new Error(result.diagnostic.message);
console.log(result.value); // true
```

**Why:** the four runtime exports — `validateExpression`, `compileExpression`, `evaluateExpression`, and `BlendScriptApiError` — are the entire public surface; internal paths are not exported and will not resolve. Each loaded copy of the package owns a private `WeakMap` registry, so a handle compiled by the direct package cannot be evaluated by the umbrella copy (or by a duplicated install created by bundler misconfiguration or hot reload). Pick one import path per application, deduplicate the dependency, and never treat `BS_INVALID_COMPILED_EXPRESSION` as a recoverable condition — it always means "this handle is not mine."

---

### 14. Design within the documented limits

**❌ Don't** — generate rules whose size grows with your data:

```typescript fragment
// ❌ Wrong: works for a short list, then fails with BS_TOKEN_LIMIT_EXCEEDED /
// BS_SOURCE_TOO_LONG. Every value must be embedded as a literal anyway,
// because IN members cannot be computed.
const source = countries.map(country => `Country == "${country}"`).join(' OR ');
```

**✅ Do** — bound the source and decide unbounded sets in the host:

```typescript fragment
// ✅ Small, fixed vocabulary: a literal IN list.
'Country IN ("NL", "BE", "DE")'

// ✅ Unbounded data: evaluate membership in the host and expose a boolean field.
'OnAllowList'
```

**Why:** the language's fixed caps are part of its safety story, not obstacles. A rule that concatenates thousands of alternatives is expensive to author, impossible to review, and eventually rejected; splitting one decision into several small named rules keeps each rule testable, gives precise diagnostics, and makes the combined result auditable in the host.

---

## Anti-Patterns

These are the mistakes the package's test suites deliberately pin down. Each one has a symptom you can search for in production logs.

**Treating `{ ok: false }` as a state that cannot happen.** The union types prevent it inside one file, but widening (`as never` at JS interop points), ignoring the branch, or storing only the `ok` result reintroduces it. A decision pipeline must be explicit about its failure path — silently skipping a failed rule is a business bug, not a technical one.

**Catching `BlendScriptApiError` as a user-input error.** Invalid formulas, unknown fields, and type mismatches never throw. A thrown `BlendScriptApiError` means the host mis-used the API: `BS_INVALID_ARGUMENT` (source not a string, record not an ordinary object), `BS_INVALID_SCHEMA`, `BS_INVALID_OPTIONS`, `BS_SCHEMA_FIELD_LIMIT_EXCEEDED`, or `BS_INVALID_COMPILED_EXPRESSION`. Reporting those as "your formula is wrong" sends authors chasing a bug they cannot fix.

**Spreading wider configuration into options or schema descriptors.** Options and field descriptors accept exactly their documented members, only as own data properties. Extra keys throw instead of being ignored:

```typescript fragment
validateExpression('TRUE', { schema, tenant, logger });   // BS_INVALID_OPTIONS
compileExpression('TRUE', { schema: { A: { ...shared, extra: true } } }); // BS_INVALID_SCHEMA
```

**Writing `nullable: undefined`.** The key being present with a non-boolean value throws `BS_INVALID_SCHEMA`. Omit the key or pass a boolean: `{ type: 'string' }` or `{ type: 'string', nullable: true }`.

**Reaching for fields, aliases, or suggestions that are not declared.** Binding is exact and case-sensitive: `{[Order Total]}` (a literal) and `[Order Total]` (the bracketed field) are the same only because the schema says so; `Missing` versus `missing` fails, there is no `suggestion` member, and `[trim]` is a field while `trim` alone is a call-position error.

**Assuming all diagnostics arrive at once.** At most 20 ordered semantic diagnostics are returned, and a lexical or syntax failure short-circuits analysis entirely. Fix the reported batch and re-run; do not parse the formula yourself to "collect everything."

**Porting JavaScript habits.** There is no arithmetic, no ternary, no comments, no regex, no template strings, no assignment, no `===`, and no `0x`/`1_000`/`NaN`/`Infinity` literals. If a rule needs any of them, the computation belongs in the host (or in a precomputed record field).

**Assuming `tryNumber` throws on bad text.** It returns `null` for blank, partial, non-decimal, or non-finite input, and `null` makes the inferred type nullable — so `tryNumber(Item) > 1` alone is a runtime landmine. Guard it.

**Assuming `text(...)` accepts null.** A nullable scalar or string compiles fine through `text(nullableField)` and fails at runtime with `BS_NULL_NOT_ALLOWED`. Use `isBlank`/`isEmpty`/`tryNumber` for null-tolerant checks, or guard first.

**Mutating a schema and expecting existing handles to change.** Options and schemas are snapshotted at the API boundary, and each handle holds its own frozen payload. Changing a schema requires recompiling the rules that use it — and mutation after the snapshot never leaks in, which is a feature, not a synchronization promise.

**Matching on `message` text or expecting `actualValue`.** Messages are guidance that may be reworded; the stable contract is `code`, `reason`, `expectedType`, `nullable`, and `actualType`. Record diagnostics are deliberately value-free, and tests assert no hidden `actualValue` member exists.

**Mixing entry points or duplicated installs.** A handle compiled by one loaded copy of the package cannot be evaluated by another, and hot reload or bundler duplication creates exactly that situation silently. Compile and evaluate with the same imported binding.

### Quick reference

| Anti-pattern | What you see | Do instead |
| --- | --- | --- |
| Ignoring `ok: false` | Silent skips; later `undefined` reads | Handle both variants of every result |
| `try`/`catch` around compile | Catch never fires; bad rules saved | Read `diagnostics` |
| Persisting a handle | `BS_INVALID_COMPILED_EXPRESSION` after load | Persist source + schema, recompile |
| `expectedResult: 'scalar'` | Thrown `BS_INVALID_OPTIONS` | `'boolean'`, `'string'`, `'number'`, or `'null'` |
| Getter / class-instance record | `accessor-property` diagnostic or thrown `BS_INVALID_ARGUMENT` | Materialize plain data properties |
| `nullable: undefined`, extra option keys | Thrown `BS_INVALID_SCHEMA` / `BS_INVALID_OPTIONS` | Omit the key or pass a boolean |
| `Country IN (OtherField)` | `BS_UNEXPECTED_TOKEN` | Literals only; compute in the host |
| `0 < Total < 5000` | `BS_UNEXPECTED_TOKEN` at the second operator | `Total >= 0 AND Total < 5000` |
| Unguarded `tryNumber(x) > 1` | `BS_NULL_NOT_ALLOWED` for non-numeric text | `tryNumber(x) != NULL AND tryNumber(x) > 1` |
| Substring matches with `equalsIgnoreCase` | Always false | `contains(lower(a), lower(b))` |
| Depending on `suggestion` | `undefined` | Build hints from `span` / `code` |
| Matching on `message` | Breaks on upgrade | Switch on `code` / `reason` |

---

## Performance Tips

### 1. Hoist compilation out of loops and requests

Every `compileExpression` call runs the full pipeline and allocates a fresh handle; a handle is immutable and stateless, so caching it is always safe. Cache on a stable key — a rule id plus version, or a canonical serialization of `source` + schema + `expectedResult`. Never key on `source` alone: each handle embeds a frozen schema snapshot, so a cache hit with a different schema silently validates records against the wrong field set.

### 2. Validate at the edges, evaluate in the middle

Validation is an authoring feature. Run it debounced in the editor, and again at publish time so the stored source is known-good. The request path should only call `evaluateExpression`; there is nothing left for the pipeline to discover once a rule is published.

### 3. Exploit deterministic short-circuiting

`AND` and `OR` never visit the unselected branch, and skipped branches are never charged against the work budget. Two consequences follow:

- Order operands so cheap or decisive checks come first; `TRUE OR equalsIgnoreCase(A, B)` performs none of the string work.
- Use guards as both correctness and cost controls: in `Address != NULL AND contains(trim(Address), "Street")`, a null `Address` costs two node visits instead of a failed call.

### 4. Keep runtime strings well below the ceiling

String work is charged against the 10,000-step budget and scales with input length:

| Operation | What it charges |
| --- | --- |
| `equalsIgnoreCase(a, b)` | `a.length + b.length + max(a.length, b.length)`, plus two lowercased copies |
| `contains` / `startsWith` / `endsWith` | `value.length + search.length` |
| `trim` / `lower` / `upper` | input length, plus the derived string cap check |
| `isBlank` | `text.length` (it allocates a trimmed copy) |
| `isEmpty` | nothing beyond argument evaluation — it only tests `null`/`''` |
| `tryNumber` (string input) | input length |
| `text` | result length |

Two 4,096-code-unit operands passed to `equalsIgnoreCase` already exceed the 10,000-step budget, so the string limit is a hard ceiling, not a working size. Cap and truncate input data upstream, prefer short codes over free text, and reach for `isEmpty` when whitespace does not matter.

### 5. Prefer `IN` over OR chains

`Country IN ("NL", "BE", "DE", "FR")` evaluates the value once and visits each literal until a match, while `Country == "NL" OR Country == "IE" OR ...` builds a comparison subtree per alternative, charging every node. Membership is also easier to review, which matters more than the constant factor.

### 6. Normalize once in the host, not per record

`lower(Text)` and `trim(Text)` allocate and charge on every evaluation. If a rule routinely filters on a normalized form, store that form as its own field when the record is written (lowercased, trimmed, or NFC-normalized), and let the rule compare exact values. Similarly, repeated conversions in one expression — there are no let-bindings, so every mention is re-evaluated — are cheaper as a host-computed field when the data is nearly always one type.

### 7. Keep schemas and records lean

Each evaluation preflights every declared field, referenced or not: descriptors are read, types checked, and string lengths bounded. That cost is paid per record per rule, so an expression evaluated against 10,000 records performs 10,000 record checks. Declare the record contract and nothing more, and combine conditions that form one business decision into one rule rather than several rules evaluated back-to-back on the same data.

### 8. Stay inside the documented envelope

| Limit | Value | Enforced at |
| --- | ---: | --- |
| Source length | 16,384 UTF-16 code units | Lexer, before tokenization |
| Tokens | 4,096 (plus EOF) | Lexer |
| String literal / runtime string value | 4,096 UTF-16 code units | Lexer / record validation and built-ins |
| Field name (schema key and bracketed name) | 256 UTF-16 code units | Options snapshot / lexer |
| Schema fields | 1,024 | Options snapshot |
| Nesting depth | 64 | Parser |
| Semantic diagnostics per call | 20 | Analyzer |
| Evaluation work | 10,000 deterministic steps | Evaluator |
| Diagnostic source excerpt | 120 UTF-16 code units | Diagnostics |

Design rules to fit these numbers rather than discovering them in production: fixed vocabularies as literal `IN` lists, unbounded sets as host-computed fields, and one human-reviewable rule per business decision.

---

## Security Considerations

### The language layer has no host capability by construction

BlendScript is a closed grammar over a private frozen AST. There is no `eval`, no `new Function`, no dynamic import, no registration API, and no way to name `process`, `require`, `window`, or any other host object — the corresponding syntax is simply rejected. Strings and field names are data at every point. Treat that capability-free property as a contract: if you fork or extend the evaluator to add a "call" mechanism, you have personally taken on the sandbox problem the package was designed to remove.

### Fail closed on every non-success

A rule that fails to evaluate must deny or default — never permit:

```typescript fragment
const result = evaluateExpression(rule, record);
// Fail closed: anything that is not a successful TRUE decision denies access.
const allowed = result.ok && result.value === true;
```

This matters most for authorization-style decisions, where "assume true on error" turns a missing field into an open door. `BS_MISSING_FIELD`, `BS_RUNTIME_TYPE_MISMATCH`, and `BS_NULL_NOT_ALLOWED` are data problems that should surface as visible denials, not silent approvals.

### The fixed limits are the DoS envelope

The caps in Performance Tip 8 bound every accepted input deterministically: source size, token count, nesting depth, schema size, and — critically — a 10,000-step evaluation budget that charges string work as a function of length. A hostile formula or a hostile record can waste at most a bounded amount of work. Do not raise `MAX_STRING_LENGTH` or `MAX_EVALUATION_STEPS` in a fork without re-deriving that bound, and never add a loop construct.

### Escape diagnostics when you render them

Source diagnostics contain author-controlled text: `message` interpolates field names, and `excerpt` is a verbatim slice of the formula. When you display them in HTML, include them in logs with structured formatting, or echo them back through an API, treat them like any other user input. Record diagnostics contain no data values, but `field` is a schema-controlled name and should be escaped the same way.

### Keep record diagnostics value-free

The record failure contract is deliberately minimal: `field`, `reason`, `expectedType`, `nullable`, `actualType`, and a generic message. The classification path uses property descriptors and `typeof` only — getters, `toJSON`, `toString`, and `valueOf` are never invoked, revoked proxies are classified safely, and tests assert that no `actualValue` member can appear. If you enrich errors for observability, do not spread the record or the rejected value back in: that is exactly the secret-leak path the design excludes.

### Treat schemas as trusted, programmer-owned input

Schemas define what data exists from the rule's perspective. If tenants, plugins, or configuration files can shape them, catch `BlendScriptApiError` at that boundary and return a 4xx-style configuration error instead of a 500, enforce the 1,024-field and 256-character limits yourself for good messages, and never bypass the reserved-key rejection (`__proto__`, `prototype`, `constructor`) or the accessor checks.

### Do not compare secrets in rules

`==` and `equalsIgnoreCase` are ordinary, non-constant-time comparisons, and the language offers no hashing or encryption. Rules are for business predicates over records, not authentication material. Keep credentials, tokens, and comparison secrets out of the record and out of the schema.

### Normalize strings in the host where it matters

Equality compares exact UTF-16 code units: NFC and NFD forms of the same text are different values, and `equalsIgnoreCase` uses locale-independent `toLowerCase()` — deliberately not the Turkish locale's casing. If a rule must match human text, normalize it in the host (canonical casing, Unicode normalization, whitespace collapsing) and store the normalized form as the field the rule reads.

### Inject ambient context instead of reaching for it

There is no clock, no locale, no randomness, and no I/O inside a rule: the same compiled source and the same record always produce the same value. That purity is what makes decisions reproducible and auditable. When a rule needs "now," a tenant, or a cutoff, compute it in the host and pass it as a declared field — and evaluate one instance to a `TRUE`/`FALSE` decision only after every declared field, including the injected one, has been validated.

### Keep compiled handles inside their owning instance

The per-instance `WeakMap` registry is a security boundary: a structural lookalike, a rehydrated object, or a handle from another loaded copy of the package throws `BS_INVALID_COMPILED_EXPRESSION` rather than executing anything. Never attempt to bypass it, and never accept a handle across an untrusted boundary — persist the source, recompile on load, and evaluate only handles your own process created.

---

# blendscript Testing Patterns

`blendsdk/blendscript` is synchronous, deterministic, dependency-free, and side-effect-free, which makes it unusually pleasant to test: real instances beat mocks, the same input always produces the same output, and every failure — for authored source or runtime records — is returned as a frozen, structured diagnostic instead of being thrown. Only programmer misuse (invalid arguments, invalid schemas, forged handles) throws `BlendScriptApiError`.

The patterns in this document mirror the package's own suites in `tests/**/*.spec.test.ts` and `tests/**/*.impl.test.ts`, but are written for consumers whose code embeds BlendScript, so they import from the package entry point rather than internal source paths.

---

## Test Setup

### Framework and configuration

- **Vitest 4.x** (`^4.1.10`) with `@vitest/coverage-v8` for coverage.
- **Node.js >= 22**, ESM only (`"type": "module"`), TypeScript strict mode.
- **No Docker, no database, no network, no environment variables.** Every test runs in-process and in milliseconds; there is no infrastructure to start or tear down.
- The package needs no `vitest.config.ts` — all options are passed as CLI flags in its `package.json` scripts:

| Script | Command | Purpose |
| --- | --- | --- |
| `test` | `vitest run --reporter=verbose --exclude 'tests/distribution/**'` | Full suite, one-shot |
| `test:watch` | `vitest watch --reporter=verbose --exclude 'tests/distribution/**'` | Watch mode |
| `test:coverage` | `vitest run --coverage --exclude 'tests/distribution/**'` | V8 coverage |
| `test:distribution` | `tsc ... tests/distribution/public-api.spec-d.ts` then `vitest run tests/distribution/...` | Type-level and built-artifact checks; requires `npm run build` first |

The distribution tests are excluded from `npm test` because they import built `dist/` output. In a consumer project, plain `vitest` / `vitest watch` is all you need. If you prefer a configuration file, this is the equivalent setup:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
```

Tests import Vitest APIs explicitly (`import { describe, expect, it } from 'vitest'`) instead of relying on globals; follow the same style so every test file is self-describing.

### Required imports

Only four runtime symbols are exported; everything else is a type. Import from the package entry point — never from a `dist/` path or an internal module, because no subpath exports exist.

```typescript
import { describe, expect, it } from 'vitest';

import {
  compileExpression,
  evaluateExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
};

describe('order rule', () => {
  it('should accept a Dutch order above the threshold', () => {
    const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', options);
    expect(compilation).toMatchObject({ ok: true });
    if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

    expect(
      evaluateExpression(compilation.expression, { Country: 'NL', OrderTotal: 1250 })
    ).toEqual({ ok: true, value: true });
  });
});
```

Frequently used importable items:

| Import | Kind | Typical use in tests |
| --- | --- | --- |
| `validateExpression`, `compileExpression`, `evaluateExpression` | functions | The three API calls under test |
| `BlendScriptApiError` | class | Asserting programmer misuse via `toThrowError` |
| `CompilationResult`, `ValidationResult`, `EvaluationResult` | types | Annotating helper return values |
| `CompiledExpression` | type | Typing handles stored in Maps or services |
| `ExpressionOptions`, `ExpressionSchema`, `ExpressionValue`, `ExpressionFieldType` | types | Typing schemas, options, and records |
| `SourceExpressionDiagnostic`, `RecordExpressionDiagnostic` | types | Typing and hand-building diagnostic fixtures |
| `SourceSpan`, `SourceLocation`, `RuntimeValueType`, `RecordDiagnosticReason` | types | Asserting exact spans and record metadata |

### Test file layout

The repository uses clear suffix conventions:

```text
tests/
  helpers/blendscript.ts
  language.spec.test.ts
  evaluation.spec.test.ts
  public-api.spec.test.ts
  record-diagnostics.spec.test.ts
  security/
    security.injection.spec.test.ts
    security.input-validation.spec.test.ts
  distribution/                     # excluded from `npm test`; run via `test:distribution`
    public-api.spec-d.ts
    distribution.spec.test.ts
```

| Suffix | Meaning |
| --- | --- |
| `*.spec.test.ts` | Behavior specifications executed against the public API |
| `*.impl.test.ts` | Internal implementation tests; in the repository they import `../src/*.js` — consumers will not need this style |
| `*.spec-d.ts` | Type-level checks only; never executed, verified by `tsc --noEmit` |

### Test helpers

Many spec files need the same three or four setup steps. Centralize them in one helper module instead of rewriting the narrowing boilerplate in every `it`:

```typescript
// tests/helpers/blendscript.ts
import { expect } from 'vitest';

import {
  BlendScriptApiError,
  compileExpression,
  evaluateExpression,
  validateExpression,
  type CompiledExpression,
  type ExpressionOptions,
  type ExpressionSchema,
  type ExpressionValue,
  type RecordExpressionDiagnostic,
  type SourceExpressionDiagnostic,
  type SourceSpan,
} from 'blendsdk/blendscript';

/** Compiles source or fails the test with the first diagnostic code. */
export function compile(source: string, schema: ExpressionSchema = {}): CompiledExpression {
  const result = compileExpression(source, { schema });
  if (!result.ok) {
    throw new Error(`Expected compilation success, received ${result.diagnostics[0]?.code}.`);
  }
  return result.expression;
}

/** Compiles and evaluates source, or fails the test with the diagnostic code. */
export function value(
  source: string,
  schema: ExpressionSchema,
  data: Readonly<Record<string, ExpressionValue>>
): ExpressionValue {
  const result = evaluateExpression(compile(source, schema), data);
  if (!result.ok) {
    throw new Error(`Expected evaluation success, received ${result.diagnostic.code}.`);
  }
  return result.value;
}

/** Asserts that validation reports one source diagnostic, optionally with an exact span. */
export function expectSourceDiagnostic(
  source: string,
  options: ExpressionOptions,
  code: SourceExpressionDiagnostic['code'],
  span?: SourceSpan
): void {
  expect(validateExpression(source, options)).toMatchObject({
    ok: false,
    diagnostics: [{ kind: 'source', code, ...(span ? { span } : {}) }],
  });
}

/** Asserts that a call performs programmer misuse with the given stable code. */
export function expectApiError(action: () => unknown, code: string): void {
  expect(action).toThrowError(BlendScriptApiError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

/** Evaluates a record that must fail record validation. */
export function evaluateRecordFailure(
  source: string,
  schema: ExpressionSchema,
  record: object
): RecordExpressionDiagnostic {
  const compilation = compileExpression(source, { schema });
  if (!compilation.ok) throw new Error('Expected the test expression to compile.');
  // The cast is deliberate: these helpers feed records that break the declared schema.
  const result = evaluateExpression(compilation.expression, record as never);
  if (result.ok) throw new Error('Expected a record failure.');
  if (result.diagnostic.kind !== 'record') {
    throw new Error(`Expected a record diagnostic, received ${result.diagnostic.code}.`);
  }
  return result.diagnostic;
}
```

Helpers throw a plain `Error` carrying the diagnostic code whenever a *setup* step unexpectedly fails, so a broken test reports `BS_UNKNOWN_FIELD` instead of a confusing assertion diff. They never swallow a real assertion failure.

---

## Unit Testing

Because `validateExpression`, `compileExpression`, and `evaluateExpression` are pure and synchronous, unit tests call the real implementation directly — there is nothing to fake. Two package-wide conventions keep tests reliable:

1. **Narrow before reading success members.** Vitest matchers do not narrow TypeScript unions, so after `expect(result).toMatchObject({ ok: true })`, add an explicit `if (!result.ok) throw ...` before touching `result.resultType`, `result.expression`, or `result.value`.
2. **Use table-driven `as const` cases.** Schemas, sources, records, and expected outcomes belong in a `as const` array that a single loop drives, exactly as the package's own suites do.

Quick reference for assertions:

| Goal | Pattern |
| --- | --- |
| Success with metadata | `toMatchObject({ ok: true })` + explicit narrowing |
| First source diagnostic | `toMatchObject({ ok: false, diagnostics: [{ code, span }] })` |
| Complete record diagnostic | `toEqual({ ok: false, diagnostic: { ... } })` + `Reflect.ownKeys` |
| Programmer misuse | `toThrowError(BlendScriptApiError)` + `toMatchObject({ code })` |
| Immutability | `expect(Object.isFrozen(result)).toBe(true)` |
| Inclusive boundary | Passes at the cap, fails with the exact code one unit above |

### Narrowing discriminated results

```typescript
import { describe, expect, it } from 'vitest';

import { compileExpression } from 'blendsdk/blendscript';

describe('result narrowing', () => {
  it('should narrow the compilation result before reading success members', () => {
    const result = compileExpression('TRUE', { schema: {} });
    expect(result).toMatchObject({ ok: true });

    if (!result.ok) throw new Error(result.diagnostics[0]?.code);
    expect(result.resultType).toEqual({ type: 'boolean', nullable: false });
    expect(result.referencedFields).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
```

### Table-driven cases

```typescript
import { describe, expect, it } from 'vitest';

import { value } from './helpers/blendscript.js';

describe('order predicate', () => {
  it('should evaluate representative equality, ordering, logic, and membership', () => {
    const schema = {
      Count: { type: 'number' },
      Enabled: { type: 'boolean' },
      Code: { type: 'string' },
    } as const;
    const data = { Count: 12, Enabled: true, Code: 'A' };
    const cases = [
      ['Count == 12', true],
      ['Count != 10', true],
      ['Count < 20', true],
      ['Count <= 12', true],
      ['Count > 20', false],
      ['Count >= 12', true],
      ['Enabled AND TRUE', true],
      ['NOT Enabled', false],
      ['Code IN ("A", "B")', true],
    ] as const;

    for (const [source, expected] of cases) expect(value(source, schema, data)).toBe(expected);
  });
});
```

This example assumes `tests/helpers/blendscript.ts` from **Test Setup**, imported as `./helpers/blendscript.js` from files that live directly under `tests/`.

### Testing asynchronous consumers

BlendScript itself never returns a Promise: validation, compilation, and evaluation are synchronous and must not be awaited. Asynchronous tests appear only when *your* code — rule loaders, HTTP handlers, queue consumers — wraps BlendScript in async operations. Keep the BlendScript assertions synchronous inside the `async` test:

```typescript
import { describe, expect, it, vi } from 'vitest';

import {
  compileExpression,
  evaluateExpression,
  type CompiledExpression,
  type ExpressionOptions,
  type ExpressionValue,
} from 'blendsdk/blendscript';

interface RuleStore {
  load(ruleId: string): Promise<string>;
}

export class RuleService {
  private readonly compiled = new Map<string, CompiledExpression>();

  public constructor(
    private readonly store: RuleStore,
    private readonly options: ExpressionOptions
  ) {}

  public async evaluate(
    ruleId: string,
    record: Readonly<Record<string, ExpressionValue>>
  ): Promise<ExpressionValue> {
    let expression = this.compiled.get(ruleId);
    if (!expression) {
      const source = await this.store.load(ruleId);
      const compilation = compileExpression(source, this.options);
      if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
      expression = compilation.expression;
      this.compiled.set(ruleId, expression);
    }
    const result = evaluateExpression(expression, record);
    if (!result.ok) throw new Error(result.diagnostic.message);
    return result.value;
  }
}

describe('RuleService', () => {
  it('should compile once and reuse the handle across evaluations', async () => {
    const store = { load: vi.fn(async () => 'Country == "NL" AND OrderTotal >= 1000') };
    const options: ExpressionOptions = {
      schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
      expectedResult: 'boolean',
    };
    const service = new RuleService(store, options);

    await expect(service.evaluate('nl-threshold', { Country: 'NL', OrderTotal: 1250 })).resolves.toBe(
      true
    );
    await expect(service.evaluate('nl-threshold', { Country: 'NL', OrderTotal: 999 })).resolves.toBe(
      false
    );
    expect(store.load).toHaveBeenCalledTimes(1);
  });
});
```

---

## Integration Testing

There are no external services to stand up: no Docker containers, no databases, no HTTP endpoints, no environment variables. "Integration" for BlendScript-based code therefore means running the **real engine against real rule sources and real record shapes** — never a substitute for the language itself — plus, in the repository, verifying the built and packaged artifacts.

The package's own integration surface lives in `tests/distribution/` and is run after a build:

```bash
npm run build
npm run test:distribution
```

`test:distribution` verifies, in order:

- **Type-level contract** — `tests/distribution/public-api.spec-d.ts` is type-checked with strict `tsc` (NodeNext resolution). It proves that handles from one package instance cannot be passed to another, that internal subpath imports fail to resolve, and that record-diagnostic metadata types are public.
- **Runtime parity** — the direct build (`packages/blendscript/dist/index.js`) and the umbrella build (`packages/blendsdk/dist/blendscript/index.js`) expose the identical four-symbol runtime namespace and produce identical results for the same conformance inputs.
- **Capability isolation** — both builds are imported in a subprocess with `globalThis.eval` and `globalThis.Function` disabled and must still compile and evaluate.
- **Packaging** — `npm pack --dry-run --json` output is inspected: only `dist/blendscript/**` JavaScript and declaration files, `README.md`, and the skill files ship, with no internal `blendsdk/` imports inside any shipped file.

For a consumer application, the equivalent integration test compiles your full stored rule pack against your production schema and evaluates golden records. Fail the suite if any stored rule no longer compiles:

```typescript
// tests/rule-pack.integration.test.ts
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  compileExpression,
  evaluateExpression,
  type CompiledExpression,
  type ExpressionOptions,
  type ExpressionValue,
} from 'blendsdk/blendscript';

interface StoredRule {
  readonly id: string;
  readonly source: string;
}

function isStoredRule(candidate: unknown): candidate is StoredRule {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'id' in candidate &&
    typeof candidate.id === 'string' &&
    'source' in candidate &&
    typeof candidate.source === 'string'
  );
}

async function loadStoredRules(fileUrl: URL): Promise<readonly StoredRule[]> {
  const parsed: unknown = JSON.parse(await readFile(fileUrl, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Expected the rule fixture to be a JSON array.');
  const rules = parsed.filter(isStoredRule);
  if (rules.length !== parsed.length) {
    throw new Error('Every stored rule must have a string id and source.');
  }
  return rules;
}

const options: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
    CouponCode: { type: 'string', nullable: true },
  },
  expectedResult: 'boolean',
};

describe('stored rule pack', () => {
  it('should compile every stored rule and evaluate golden records', async () => {
    const rules = await loadStoredRules(new URL('./fixtures/rules.json', import.meta.url));
    const compiled = new Map<string, CompiledExpression>();

    for (const rule of rules) {
      const compilation = compileExpression(rule.source, options);
      if (!compilation.ok) {
        const diagnostic = compilation.diagnostics[0];
        throw new Error(`${rule.id}: ${diagnostic?.code} ${diagnostic?.message}`);
      }
      compiled.set(rule.id, compilation.expression);
    }

    expect(compiled.size).toBe(rules.length);

    const nlThreshold = compiled.get('nl-threshold');
    if (!nlThreshold) throw new Error('Expected the nl-threshold rule in the pack.');

    const record: Readonly<Record<string, ExpressionValue>> = {
      Country: 'NL',
      OrderTotal: 1250,
      CouponCode: null,
    };
    expect(evaluateExpression(nlThreshold, record)).toEqual({ ok: true, value: true });
  });
});
```

With a minimal fixture alongside it:

```json
[
  { "id": "nl-threshold", "source": "Country == \"NL\" AND OrderTotal >= 1000" }
]
```

### Type-level contract tests

The package keeps a `.spec-d.ts` file that is never executed — it is compiled with strict `tsc` to lock the public contract. Reproduce the pattern for your own boundary types:

```typescript
// tests/type-tests/public-api.spec-d.ts
import {
  compileExpression,
  type CompiledExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Status: { type: 'string' } },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Status == "active"', options);
if (compilation.ok) {
  const expression: CompiledExpression = compilation.expression;
  void expression;
}

// @ts-expect-error A forged structural lookalike is not a compiled expression.
const forged: CompiledExpression = {};

// @ts-expect-error Internal modules are not part of the public API.
type InternalModule = typeof import('blendsdk/blendscript/evaluator');

declare const internalProbe: InternalModule;

void forged;
void internalProbe;
```

Check it with a strict, no-emit compile:

```bash
tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck tests/type-tests/public-api.spec-d.ts
```

For contract assertions inside regular spec files, Vitest's `expectTypeOf` works too when `vitest --typecheck` is enabled:

```typescript
import { describe, expectTypeOf, it } from 'vitest';

import { compileExpression, type CompilationResult } from 'blendsdk/blendscript';

describe('type contracts', () => {
  it('should type compileExpression with the public CompilationResult', () => {
    expectTypeOf(compileExpression('TRUE', { schema: {} })).toEqualTypeOf<CompilationResult>();
  });
});
```

---

## Mocking & Stubbing

BlendScript is deliberately closed: no I/O, no clock, no randomness, no host functions, and no registration API. There is nothing *inside* the package worth stubbing, and the real implementation is synchronous and fast enough for every test. The guidance is therefore:

- **Use real instances for all language behavior.** Validation, compilation, evaluation, diagnostics, and limits are fully deterministic — a fake can only weaken the test.
- **Mock at your own boundary, never BlendScript's.** When a component must be isolated from rule outcomes, introduce a facade and inject the engine.
- **Never hand-forge a compiled handle.** Handles are branded memory values; `evaluateExpression` verifies identity through a private `WeakMap` and throws `BlendScriptApiError` (`BS_INVALID_COMPILED_EXPRESSION`) for anything else — including plain objects, frozen objects, and symbols returned from a fake `compileExpression`. If you mock `compileExpression`, you must mock `evaluateExpression` coherently.

| Scenario | Recommended seam |
| --- | --- |
| Assert rule behavior | Real engine with crafted source and records |
| Isolate app logic from rule outcomes | Facade interface + fake implementation |
| Observe that app code called the engine | `vi.mock` with `importOriginal` + `vi.mocked` |
| Replace the engine entirely | `vi.mock` full factory — replace all runtime exports coherently |

### The recommended seam: a facade with dependency injection

Wrap the three functions behind an application-owned interface. Production wires it to BlendScript; tests substitute a fake:

```typescript
// src/rules/engine.ts
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type CompilationResult,
  type CompiledExpression,
  type EvaluationResult,
  type ExpressionOptions,
  type ExpressionValue,
  type ValidationResult,
} from 'blendsdk/blendscript';

/** The seam application code depends on; tests inject a fake implementation. */
export interface RuleEngine {
  validate(source: string, options: ExpressionOptions): ValidationResult;
  compile(source: string, options: ExpressionOptions): CompilationResult;
  evaluate(
    expression: CompiledExpression,
    record: Readonly<Record<string, ExpressionValue>>
  ): EvaluationResult;
}

/** Production engine: delegates to the real BlendScript runtime. */
export const blendScriptEngine: RuleEngine = {
  validate: validateExpression,
  compile: compileExpression,
  evaluate: evaluateExpression,
};
```

A small consumer component:

```typescript
// src/rules/registry.ts
import type { ExpressionOptions, SourceExpressionDiagnostic } from 'blendsdk/blendscript';

import type { RuleEngine } from './engine.js';

/** Registers authored rules only after the engine confirms they are valid. */
export class RuleRegistry {
  private readonly rules = new Map<string, string>();

  public constructor(private readonly engine: RuleEngine) {}

  public register(
    id: string,
    source: string,
    options: ExpressionOptions
  ): readonly SourceExpressionDiagnostic[] {
    const validation = this.engine.validate(source, options);
    if (!validation.ok) return validation.diagnostics;
    this.rules.set(id, source);
    return [];
  }

  public ids(): readonly string[] {
    return [...this.rules.keys()];
  }
}
```

Because diagnostic types are public and structural, fakes stay type-safe without casts:

```typescript
// tests/rule-registry.spec.test.ts
import { describe, expect, it } from 'vitest';

import type {
  CompilationResult,
  EvaluationResult,
  SourceExpressionDiagnostic,
  ValidationResult,
} from 'blendsdk/blendscript';

import type { RuleEngine } from '../src/rules/engine.js';
import { RuleRegistry } from '../src/rules/registry.js';

const unknownFieldDiagnostic: SourceExpressionDiagnostic = {
  kind: 'source',
  code: 'BS_UNKNOWN_FIELD',
  severity: 'error',
  message: 'Field "Missing" is not declared in the schema.',
  span: { start: 0, end: 7 },
  location: { line: 1, column: 1, endLine: 1, endColumn: 8 },
};

const rejectingEngine: RuleEngine = {
  validate: (): ValidationResult => ({ ok: false, diagnostics: [unknownFieldDiagnostic] }),
  compile: (): CompilationResult => ({ ok: false, diagnostics: [unknownFieldDiagnostic] }),
  evaluate: (): EvaluationResult => ({
    ok: false,
    diagnostic: {
      kind: 'record',
      code: 'BS_MISSING_FIELD',
      severity: 'error',
      message: 'Record is missing required field "Country".',
      field: 'Country',
      reason: 'missing-field',
      expectedType: 'string',
      nullable: false,
      actualType: 'missing',
    },
  }),
};

describe('RuleRegistry under a rejecting engine', () => {
  it('should surface the engine diagnostics and keep the registry empty', () => {
    const registry = new RuleRegistry(rejectingEngine);
    const diagnostics = registry.register('nl', 'Missing == "NL"', { schema: {} });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ kind: 'source', code: 'BS_UNKNOWN_FIELD' });
    expect(registry.ids()).toEqual([]);
  });
});
```

Prefer provoking real diagnostics for language tests — the real engine makes invalid input deterministic and free — and reserve hand-built diagnostics for simulating *outcomes* through a facade like the one above.

### Module mocking

When a module imports BlendScript directly and cannot take an injected engine, two `vi.mock` shapes cover most needs.

**Partial mock with real behavior preserved.** Override only the function you want to observe, and delegate the rest — including the overridden function's implementation — to the actual module:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('blendsdk/blendscript', async importOriginal => {
  const actual = await importOriginal<typeof import('blendsdk/blendscript')>();
  return { ...actual, validateExpression: vi.fn(actual.validateExpression) };
});

import { validateExpression } from 'blendsdk/blendscript';

describe('observed validation', () => {
  beforeEach(() => {
    vi.mocked(validateExpression).mockClear();
  });

  it('should keep real behavior while recording calls', () => {
    expect(validateExpression('TRUE', { schema: {} })).toEqual({
      ok: true,
      resultType: { type: 'boolean', nullable: false },
      referencedFields: [],
    });
    expect(vi.mocked(validateExpression)).toHaveBeenCalledTimes(1);
  });
});
```

Vitest also offers the shorthand `vi.mock('blendsdk/blendscript', { spy: true })`, which keeps every real implementation while wrapping each export in a spy.

**Full factory replacement.** Replace every runtime export your code under test imports — all three functions *and* `BlendScriptApiError` if it is constructed or caught — with coherent fakes, and remember that `vi.mock` factories are hoisted and cannot reference outer variables:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('blendsdk/blendscript', () => ({
  validateExpression: vi.fn(() => ({
    ok: true,
    resultType: { type: 'boolean', nullable: false },
    referencedFields: [],
  })),
  compileExpression: vi.fn((source: string) => ({
    ok: true,
    expression: { source },
    resultType: { type: 'boolean', nullable: false },
    referencedFields: [],
  })),
  evaluateExpression: vi.fn(() => ({ ok: true, value: true })),
  BlendScriptApiError: class BlendScriptApiError extends Error {
    public readonly code = 'BS_INVALID_ARGUMENT' as const;
  },
}));

import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

import { checkRule } from '../src/rules/direct-check.js';

describe('checkRule with the BlendScript module mocked', () => {
  beforeEach(() => {
    vi.mocked(compileExpression).mockClear();
    vi.mocked(evaluateExpression).mockClear();
  });

  it('should combine the mocked compile and evaluate results', () => {
    expect(checkRule('TRUE', { schema: {} }, {})).toBe(true);
    expect(vi.mocked(compileExpression)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(evaluateExpression)).toHaveBeenCalledTimes(1);
  });

  it('should surface a mocked runtime failure as an error', () => {
    vi.mocked(evaluateExpression).mockReturnValueOnce({
      ok: false,
      diagnostic: {
        kind: 'record',
        code: 'BS_MISSING_FIELD',
        severity: 'error',
        message: 'Record is missing required field "Country".',
        field: 'Country',
        reason: 'missing-field',
        expectedType: 'string',
        nullable: false,
        actualType: 'missing',
      },
    });

    expect(() => checkRule('TRUE', { schema: {} }, {})).toThrow(
      'Record is missing required field "Country".'
    );
  });
});
```

The `checkRule` subject used above is a typical direct-import consumer:

```typescript
// src/rules/direct-check.ts
import {
  compileExpression,
  evaluateExpression,
  type ExpressionOptions,
  type ExpressionValue,
} from 'blendsdk/blendscript';

/** Checks one rule without the facade; used where the engine cannot be injected. */
export function checkRule(
  source: string,
  options: ExpressionOptions,
  record: Readonly<Record<string, ExpressionValue>>
): boolean {
  const compilation = compileExpression(source, options);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
  const result = evaluateExpression(compilation.expression, record);
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.value === true;
}
```

### What not to do

- **Do not hand-build a `CompiledExpression`** to pass to the real `evaluateExpression`. The identity check throws `BS_INVALID_COMPILED_EXPRESSION`; a lookalike is a dead end by design.
- **Do not mix mocked and real functions.** A fake `compileExpression` returns fake handles, and the real `evaluateExpression` rejects them — mock the pair together.
- **Do not re-implement language semantics in fakes for behavior tests.** Call the real engine; it is deterministic, fast, and dependency-free.
- **Do not import from `dist/` paths or internal modules** such as `blendsdk/blendscript/evaluator`; only the package entry point is public, which the type tests enforce.

---

## Test Patterns by Feature

### Validation and source diagnostics

Assert the first diagnostic's code plus its exact span; validation is fail-fast and returns at most 20 ordered semantic diagnostics.

```typescript
import { describe, expect, it } from 'vitest';

import { validateExpression, type ExpressionOptions } from 'blendsdk/blendscript';

const options = {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
} as const satisfies ExpressionOptions;

describe('rule validation', () => {
  it('should report unknown fields at their exact span', () => {
    const result = validateExpression('Country == "NL" AND Missing != "x"', options);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          kind: 'source',
          code: 'BS_UNKNOWN_FIELD',
          severity: 'error',
          span: { start: 20, end: 27 },
        },
      ],
    });
  });

  it('should enforce an exact expected result type when it is provided', () => {
    expect(validateExpression('"yes"', { schema: {}, expectedResult: 'boolean' })).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'BS_EXPECTED_RESULT_TYPE_MISMATCH' }],
    });
  });

  it('should count UTF-16 columns and treat CRLF as one line break', () => {
    const result = validateExpression('"😀"\r\n$', { schema: {} });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'BS_INVALID_CHARACTER',
          span: { start: 6, end: 7 },
          location: { line: 2, column: 1, endLine: 2, endColumn: 2 },
        },
      ],
    });
  });

  it('should return at most twenty ordered semantic diagnostics', () => {
    const source = Array.from({ length: 21 }, (_, index) => `Missing${index}`).join(' AND ');
    const result = validateExpression(source, { schema: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(20);
      expect(result.diagnostics.every(({ code }) => code === 'BS_UNKNOWN_FIELD')).toBe(true);
      expect(result.diagnostics.map(({ span }) => span.start)).toEqual(
        [...result.diagnostics].map(({ span }) => span.start).sort((left, right) => left - right)
      );
    }
  });
});
```

### Compilation and opaque handles

Each compilation creates a **fresh, frozen handle**; validation and compilation share one normalized pipeline and must agree on metadata and diagnostics. Forged handles throw instead of returning diagnostics.

```typescript
import { describe, expect, it } from 'vitest';

import {
  BlendScriptApiError,
  compileExpression,
  evaluateExpression,
  validateExpression,
} from 'blendsdk/blendscript';

import { expectApiError } from './helpers/blendscript.js';

describe('compiled expressions', () => {
  it('should create a fresh frozen handle for every call', () => {
    const options = { schema: { Enabled: { type: 'boolean' } } } as const;
    const first = compileExpression('Enabled', options);
    const second = compileExpression('Enabled', options);
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) throw new Error('Expected both compilations to succeed.');

    expect(first.expression).not.toBe(second.expression);
    expect(Object.isFrozen(first.expression)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('should mirror validation metadata and diagnostics exactly', () => {
    const options = { schema: { Country: { type: 'string' } } } as const;
    const validation = validateExpression('Country == "NL"', options);
    const compilation = compileExpression('Country == "NL"', options);
    expect(compilation).toMatchObject(validation);
    expect(compilation).toMatchObject({ ok: true, expression: expect.any(Object) });

    const invalidValidation = validateExpression('Missing', options);
    const invalidCompilation = compileExpression('Missing', options);
    expect(invalidCompilation).toEqual(invalidValidation);
  });

  it('should reuse one handle across records without retaining state', () => {
    const compilation = compileExpression('Enabled', { schema: { Enabled: { type: 'boolean' } } });
    if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.code);
    const handle = compilation.expression;

    expect(evaluateExpression(handle, { Enabled: true })).toEqual({ ok: true, value: true });
    expect(evaluateExpression(handle, { Enabled: false })).toEqual({ ok: true, value: false });
    expect(evaluateExpression(handle, { Enabled: true })).toEqual({ ok: true, value: true });
  });

  it('should throw for forged handles instead of returning diagnostics', () => {
    for (const forged of [null, true, 1, 'compiled', {}, Object.freeze({})]) {
      expect(() => evaluateExpression(forged as never, {})).toThrowError(BlendScriptApiError);
    }
    expectApiError(
      () => evaluateExpression({} as never, {}),
      'BS_INVALID_COMPILED_EXPRESSION'
    );
  });
});
```

### Evaluation semantics

The interpreter is strict and coercion-free: `AND` binds before `OR`, logical operators short-circuit without charging unselected branches, and nullable equality is true only between *both-null* operands.

```typescript
import { describe, expect, it } from 'vitest';

import { value } from './helpers/blendscript.js';

describe('evaluation semantics', () => {
  it('should apply AND before OR', () => {
    const schema = { Country: { type: 'string' }, Enabled: { type: 'boolean' } } as const;
    expect(
      value('Country == "GB" OR Country == "NL" AND Enabled == TRUE', schema, {
        Country: 'GB',
        Enabled: false,
      })
    ).toBe(true);
  });

  it('should skip unselected branches and their work', () => {
    const schema = { A: { type: 'string' }, B: { type: 'string' } } as const;
    const data = { A: 'a'.repeat(4_096), B: 'a'.repeat(4_096) };
    expect(value('TRUE OR equalsIgnoreCase(A, B)', schema, data)).toBe(true);
    expect(value('FALSE AND equalsIgnoreCase(A, B)', schema, data)).toBe(false);
  });

  it('should implement nullable equality and membership without coercion', () => {
    const schema = { Text: { type: 'string', nullable: true } } as const;
    expect(value('Text == NULL', schema, { Text: null })).toBe(true);
    expect(value('Text == "x"', schema, { Text: null })).toBe(false);
    expect(value('Text IN ("x", NULL)', schema, { Text: null })).toBe(true);
  });
});
```

### Built-in functions

The twelve built-ins are fixed and pure; test them table-driven, including Unicode and locale-sensitive corners (`length` counts code points, comparison is never locale-aware).

```typescript
import { describe, expect, it } from 'vitest';

import { value } from './helpers/blendscript.js';

describe('built-in functions', () => {
  it('should evaluate all string built-ins with documented semantics', () => {
    const schema = {
      Text: { type: 'string', nullable: true },
      Search: { type: 'string' },
    } as const;
    const cases = [
      ['isEmpty(Text)', { Text: null, Search: '' }, true],
      ['isEmpty(Text)', { Text: ' ', Search: '' }, false],
      ['isBlank(Text)', { Text: ' \t', Search: '' }, true],
      ['contains(Text, Search)', { Text: 'BlendScript', Search: 'Script' }, true],
      ['startsWith(Text, Search)', { Text: 'BlendScript', Search: 'Blend' }, true],
      ['endsWith(Text, Search)', { Text: 'BlendScript', Search: 'Script' }, true],
      ['equalsIgnoreCase(Text, Search)', { Text: 'Blend', Search: 'blend' }, true],
      ['trim(Text)', { Text: '  a b  ', Search: '' }, 'a b'],
      ['lower(Text)', { Text: 'ÄBC', Search: '' }, 'äbc'],
      ['upper(Text)', { Text: 'abc', Search: '' }, 'ABC'],
      ['length(Text)', { Text: '😀a', Search: '' }, 2],
    ] as const;

    for (const [source, data, expected] of cases) expect(value(source, schema, data)).toBe(expected);
  });

  it('should use non-locale lowercase semantics for equalsIgnoreCase', () => {
    const schema = { A: { type: 'string' }, B: { type: 'string' } } as const;
    expect(value('equalsIgnoreCase(A, B)', schema, { A: 'İ', B: 'i' })).toBe(false);
  });
});
```

### Scalar fields and explicit conversion

The `scalar` type accepts exactly one string or one finite number and never converts implicitly. Test both the preserved representation and the explicit `tryNumber` / `text` conversions, including their failure modes.

```typescript
import { describe, expect, it } from 'vitest';

import {
  compileExpression,
  evaluateExpression,
  validateExpression,
} from 'blendsdk/blendscript';

const scalarSchema = Object.freeze({ Item: Object.freeze({ type: 'scalar' as const }) });

describe('scalar fields', () => {
  it('should preserve string and finite-number values without normalization', () => {
    const compilation = compileExpression('Item', { schema: scalarSchema });
    if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.code);

    for (const Item of [1, '1', 'ABC-1', '001'] as const) {
      expect(evaluateExpression(compilation.expression, { Item })).toEqual({
        ok: true,
        value: Item,
      });
    }
  });

  it('should convert complete decimal text and null out partial text', () => {
    const compilation = compileExpression('tryNumber(Item)', { schema: scalarSchema });
    if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.code);
    const expression = compilation.expression;

    expect(evaluateExpression(expression, { Item: '001' })).toEqual({ ok: true, value: 1 });
    expect(evaluateExpression(expression, { Item: '1e3' })).toEqual({ ok: true, value: 1_000 });
    for (const Item of ['', ' 1', '1abc', '0x10', 'Infinity']) {
      expect(evaluateExpression(expression, { Item })).toEqual({ ok: true, value: null });
    }
  });

  it('should require explicit conversion before concrete-type operations', () => {
    for (const source of ['Item > 1', 'Item == 1', 'contains(Item, "1")']) {
      const result = validateExpression(source, { schema: scalarSchema });
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'BS_TYPE_MISMATCH' }] });
      if (!result.ok) {
        expect(result.diagnostics[0]?.message).toMatch(/text\(\.\.\.\)|tryNumber\(\.\.\.\)/u);
      }
    }
  });
});
```

### Record validation and record diagnostics

Every declared field is validated before evaluation — even fields the expression never references — and every failure is a frozen, value-free record diagnostic. Assert the **complete member set** so no hidden value-carrying member can be added later.

```typescript
import { describe, expect, it } from 'vitest';

import { evaluateRecordFailure } from './helpers/blendscript.js';

const stringItem = Object.freeze({ Item: Object.freeze({ type: 'string' as const }) });

describe('record diagnostics', () => {
  it('should keep the missing-versus-undefined boundary explicit', () => {
    expect(evaluateRecordFailure('Item', stringItem, {})).toMatchObject({
      code: 'BS_MISSING_FIELD',
      reason: 'missing-field',
      actualType: 'missing',
    });
    expect(evaluateRecordFailure('Item', stringItem, { Item: undefined })).toMatchObject({
      code: 'BS_RUNTIME_TYPE_MISMATCH',
      reason: 'type-mismatch',
      actualType: 'undefined',
    });
  });

  it('should report accessor records without invoking the getter', () => {
    let getterRuns = 0;
    const record = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(record, 'Item', {
      get() {
        getterRuns += 1;
        return 'value';
      },
      enumerable: true,
    });

    expect(evaluateRecordFailure('Item', stringItem, record)).toMatchObject({
      reason: 'accessor-property',
      actualType: 'accessor',
    });
    expect(getterRuns).toBe(0);
  });

  it('should expose exactly the documented record diagnostic members', () => {
    const diagnostic = evaluateRecordFailure('Item', stringItem, { Item: 42 });
    expect(Reflect.ownKeys(diagnostic).sort()).toEqual([
      'actualType',
      'code',
      'expectedType',
      'field',
      'kind',
      'message',
      'nullable',
      'reason',
      'severity',
    ]);
  });

  it('should never include the rejected value in a diagnostic', () => {
    const secret = 'TOP-SECRET-RECORD-VALUE';
    const diagnostic = evaluateRecordFailure('Item', stringItem, { Item: secret.repeat(200) });

    expect(diagnostic).toMatchObject({ code: 'BS_STRING_VALUE_LIMIT_EXCEEDED' });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(diagnostic).not.toHaveProperty('actualValue');
  });
});
```

### Limits and resource bounds

All limits are inclusive: exactly at the cap passes, one unit above fails with a stable code. Test both sides, and treat the evaluation-step budget as a deterministic contract rather than an implementation detail.

```typescript
import { describe, expect, it } from 'vitest';

import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';

import { expectApiError, expectSourceDiagnostic } from './helpers/blendscript.js';

const emptyOptions = { schema: {} } as const;

describe('resource bounds', () => {
  it('should accept the source cap and reject the first code unit above it', () => {
    expect(validateExpression(`${' '.repeat(16_380)}TRUE`, emptyOptions)).toMatchObject({
      ok: true,
    });
    expectSourceDiagnostic(`${' '.repeat(16_381)}TRUE`, emptyOptions, 'BS_SOURCE_TOO_LONG', {
      start: 16_384,
      end: 16_385,
    });
  });

  it('should enforce the string literal cap inclusively', () => {
    expect(validateExpression(`"${'a'.repeat(4_096)}"`, emptyOptions)).toMatchObject({ ok: true });
    expectSourceDiagnostic(`"${'a'.repeat(4_097)}"`, emptyOptions, 'BS_STRING_LITERAL_TOO_LONG');
  });

  it('should enforce the schema field-count cap inclusively', () => {
    const schema1024: Record<string, { type: 'boolean' }> = {};
    for (let index = 0; index < 1_024; index += 1) schema1024[`F${index}`] = { type: 'boolean' };

    expect(compileExpression('TRUE', { schema: schema1024 })).toMatchObject({ ok: true });
    expectApiError(
      () => compileExpression('TRUE', { schema: { ...schema1024, F1024: { type: 'boolean' } } }),
      'BS_SCHEMA_FIELD_LIMIT_EXCEEDED'
    );
  });

  it('should enforce the evaluation step budget deterministically', () => {
    const schema = { A: { type: 'string' }, B: { type: 'string' } } as const;
    const data = { A: 'a'.repeat(4_096), B: 'b'.repeat(901) };

    const withinBudget = compileExpression('NOT contains(trim(A), trim(B))', { schema });
    if (!withinBudget.ok) throw new Error(withinBudget.diagnostics[0]?.code);
    expect(evaluateExpression(withinBudget.expression, data)).toEqual({ ok: true, value: true });

    const overBudget = compileExpression('NOT NOT contains(trim(A), trim(B))', { schema });
    if (!overBudget.ok) throw new Error(overBudget.diagnostics[0]?.code);
    expect(evaluateExpression(overBudget.expression, data)).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_EVALUATION_STEP_LIMIT_EXCEEDED' },
    });
  });
});
```

### Immutability, determinism, and reuse

Options, schemas, and records are captured through own data descriptors at the API boundary. Test that post-call mutations cannot change behavior, that repeated evaluations are identical (including failures), and that inputs are never mutated.

```typescript
import { describe, expect, it } from 'vitest';

import {
  compileExpression,
  evaluateExpression,
  type ExpressionValue,
} from 'blendsdk/blendscript';

describe('immutability and repeatability', () => {
  it('should snapshot the schema at compile time', () => {
    const schema: { Enabled: { type: 'boolean' | 'string' } } = {
      Enabled: { type: 'boolean' },
    };
    const compilation = compileExpression('Enabled', { schema });
    if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.code);

    schema.Enabled.type = 'string';

    expect(evaluateExpression(compilation.expression, { Enabled: true })).toEqual({
      ok: true,
      value: true,
    });
  });

  it('should repeat failures identically without touching the record', () => {
    const compilation = compileExpression('trim(Text)', {
      schema: { Text: { type: 'string', nullable: true } },
    });
    if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.code);

    const record: Readonly<Record<string, ExpressionValue>> = { Text: null };
    Object.freeze(record);

    const first = evaluateExpression(compilation.expression, record);
    const second = evaluateExpression(compilation.expression, record);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: false, diagnostic: { code: 'BS_NULL_NOT_ALLOWED' } });
    expect(Object.isFrozen(record)).toBe(true);
  });
});
```

### Security and capability boundary

Assert that the language cannot name or reach host capabilities, that record accessors and hostile value hooks are never invoked, and that broken values never make evaluation throw.

```typescript
import { describe, expect, it } from 'vitest';

import { validateExpression } from 'blendsdk/blendscript';

import { evaluateRecordFailure } from './helpers/blendscript.js';

describe('capability boundary', () => {
  it('should reject syntax that names or reaches host capabilities', () => {
    const sources = [
      'globalThis.process',
      'process.exit()',
      'require("node:fs")',
      'import("node:fs")',
      'Function("return 1")()',
      'eval("TRUE")',
      'constructor.constructor("return process")()',
      'this',
    ];
    for (const source of sources) {
      expect(validateExpression(source, { schema: {} })).toMatchObject({ ok: false });
    }
  });

  it('should never invoke accessors or hostile value hooks while classifying records', () => {
    let trapRuns = 0;
    const hostile = {
      toJSON() {
        trapRuns += 1;
        return 'serialized';
      },
      toString() {
        trapRuns += 1;
        return 'text';
      },
      valueOf() {
        trapRuns += 1;
        return 1;
      },
    };

    const diagnostic = evaluateRecordFailure(
      'Item',
      { Item: { type: 'string' } },
      { Item: hostile }
    );
    expect(diagnostic).toMatchObject({ reason: 'type-mismatch', actualType: 'object' });
    expect(trapRuns).toBe(0);
    expect(JSON.stringify(diagnostic)).not.toContain('serialized');
  });

  it('should survive a revoked proxy value without throwing', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() =>
      evaluateRecordFailure('Item', { Item: { type: 'string' } }, { Item: proxy })
    ).not.toThrow();
    expect(
      evaluateRecordFailure('Item', { Item: { type: 'string' } }, { Item: proxy })
    ).toMatchObject({ reason: 'type-mismatch', actualType: 'object' });
  });
});
```

A repository-level variant of this pattern (shown in `tests/security/security.injection.spec.test.ts`) reads every file under `src/` and asserts the production source contains no `eval(`, `new Function`, bare `Function(`, or dynamic `import(` call — a useful regression guard if you vendor or fork the package.

---

## Next Steps

Continue with Troubleshooting for diagnostic-driven debugging, keep the API Reference nearby while writing assertions against exact codes and spans, and browse the Examples Library for end-to-end scenarios that these test patterns can be adapted to. The documentation index lists all companion documents.

---

---

# blendscript Troubleshooting

---

BlendScript reports problems through two deliberately separate channels. Programmer misuse throws `BlendScriptApiError`; authored-formula and record problems come back as immutable diagnostics inside an `ok: false` result. Most "why did this fail" questions resolve by identifying which channel produced the failure first:

| Channel | Shape | Produced by | How to handle |
| --- | --- | --- | --- |
| Thrown programmer error | `BlendScriptApiError` instance with a `code` | Invalid `source`, `options`, `schema`, forged handles, non-ordinary record containers | `try/catch`, then read `error.code` |
| Authored-formula diagnostic | `SourceExpressionDiagnostic` (`kind: 'source'`) | Lexer, parser, analyzer — plus null/limit failures during evaluation | Read `diagnostics` / `diagnostic` on an `ok: false` result |
| Record diagnostic | `RecordExpressionDiagnostic` (`kind: 'record'`) | Record snapshot validation before evaluation | Read `field`, `reason`, `expectedType`, `nullable`, `actualType` |

All diagnostic codes are stable, machine-readable `BS_*` strings. Messages, locations, and excerpts are for humans; branch on `code` (and on `reason` for record diagnostics). Compiled handles are only valid in the loaded package instance that created them — compile and evaluate through one import path. Inside this monorepo the package is `blendsdk/blendscript`; npm consumers import the identical build as `blendsdk/blendscript`. Pick one and stay on it for a given handle.

---

## Common Errors

### Diagnostic Code Index

| Code | Raised by | Meaning |
| --- | --- | --- |
| `BS_SOURCE_TOO_LONG` | Lexer | Source exceeds 16,384 UTF-16 code units |
| `BS_TOKEN_LIMIT_EXCEEDED` | Lexer | More than 4,096 non-EOF tokens |
| `BS_STRING_LITERAL_TOO_LONG` | Lexer | Decoded string literal exceeds 4,096 code units |
| `BS_FIELD_NAME_TOO_LONG` | Lexer | Bracketed field name exceeds 256 code units |
| `BS_INVALID_CHARACTER` | Lexer | Character outside the closed v1 alphabet |
| `BS_INVALID_STRING` | Lexer | Malformed string literal (quotes, escapes, surrogates, line breaks) |
| `BS_INVALID_NUMBER` | Lexer | Malformed or non-finite number literal |
| `BS_UNEXPECTED_TOKEN` | Parser / analyzer | Grammar errors, bare built-in names, unknown call targets |
| `BS_NESTING_LIMIT_EXCEEDED` | Parser | More than 64 nesting levels |
| `BS_UNKNOWN_FIELD` | Analyzer | Field is not declared in the schema |
| `BS_TYPE_MISMATCH` | Analyzer | Incompatible or unconvertible operand types |
| `BS_INVALID_ARGUMENT_COUNT` | Analyzer | Wrong number of built-in arguments |
| `BS_EXPECTED_RESULT_TYPE_MISMATCH` | Analyzer | `expectedResult` is not satisfied exactly |
| `BS_MISSING_FIELD` | Evaluation | A declared record field is absent |
| `BS_RUNTIME_TYPE_MISMATCH` | Evaluation | A record value fails its declared type shape |
| `BS_STRING_VALUE_LIMIT_EXCEEDED` | Evaluation | Input or derived string exceeds 4,096 code units |
| `BS_NULL_NOT_ALLOWED` | Evaluation | `null` flows into a null-rejecting operation |
| `BS_EVALUATION_STEP_LIMIT_EXCEEDED` | Evaluation | Work budget of 10,000 steps exceeded |

The five thrown API codes are `BS_INVALID_ARGUMENT`, `BS_INVALID_OPTIONS`, `BS_INVALID_SCHEMA`, `BS_SCHEMA_FIELD_LIMIT_EXCEEDED`, and `BS_INVALID_COMPILED_EXPRESSION`.

---

### Errors Thrown by the API

#### Expression source must be a string. (BS_INVALID_ARGUMENT)

**Message** — `Expression source must be a string.`

**Cause** — `validateExpression` and `compileExpression` check `typeof source !== 'string'` before any lexing. A number, `null`, `undefined`, or an object arriving from a JSON payload, config file, or form field triggers the throw.

**Fix** — Convert values at the boundary and pass the raw string onward:

```typescript
import { validateExpression, type ExpressionOptions } from 'blendsdk/blendscript';

function validateSourceFromBoundary(value: unknown, options: ExpressionOptions): void {
  if (typeof value !== 'string') {
    throw new TypeError('Rule source must be a string.');
  }
  const result = validateExpression(value, options);
  console.log(result.ok ? 'valid' : result.diagnostics[0]?.code);
}

validateSourceFromBoundary('TRUE', { schema: {} }); // valid
```

---

#### BS_INVALID_OPTIONS — the options container is not accepted

**Messages** —

| Message | Trigger |
| --- | --- |
| `Expression options must be a caller-materialized ordinary object.` | `null`, arrays, class instances, or objects with a custom prototype such as `Object.create({ schema: {} })` |
| `Expression options require an explicit schema.` | No `schema` key at all — `{}` is rejected; pass `{ schema: {} }` for a field-free rule |
| `Expression options contain an unsupported member.` | Extra keys, including symbol keys; only `schema` and `expectedResult` are allowed |
| `Expression options cannot use accessor properties.` | `schema` or `expectedResult` provided through a getter |
| `expectedResult must be string, number, boolean, or null when provided.` | `'scalar'`, `'date'`, numbers — or explicitly passing `undefined` |

**Cause** — The API snapshots options through own data descriptors instead of reading them lazily. Containers that are not plain objects, keys outside the allowed set, and computed properties are rejected.

**Fix** — Build options as a fresh object literal with data properties only:

```typescript
import { compileExpression, type ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' } },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Country == "NL"', options);
console.log(compilation.ok); // true
```

Everything is captured at the call: mutating `options.schema` afterwards has no effect on an already-compiled handle.

---

#### BS_INVALID_SCHEMA — the schema container or a field descriptor is not accepted

**Messages** —

| Message | Trigger |
| --- | --- |
| `Expression schema must be a caller-materialized ordinary object.` | Arrays, class instances, `Object.create({ A: ... })`; `Object.create(null)` is accepted |
| `Expression schema cannot contain symbol keys.` | Since a symbol key cannot name a field |
| `Schema field names must contain 1 to 256 UTF-16 code units.` | Empty or over-long keys |
| `Schema field "__proto__" is reserved for safety.` | `__proto__`, `prototype`, `constructor` keys |
| `Schema field "X" cannot use an accessor property.` | Getter on the schema map itself |
| `Schema field "X" must use an ordinary object descriptor.` | Descriptor is an array, class instance, or inherited object |
| `Schema field "X" contains an unsupported descriptor member.` | Extra members beyond `type` and `nullable` |
| `Schema field "X" cannot use accessor properties.` | `type` or `nullable` provided through a getter |
| `Schema field "X" requires a type.` | Descriptor missing `type` |
| `Schema field "X" type must be string, number, boolean, or scalar.` | `'date'` or other unknown types |
| `Schema field "X" nullable must be Boolean when provided.` | `nullable: 'yes'` and similar |

**Cause** — Schema entries are validated as exactly `{ type, nullable? }` own data properties on an ordinary object. Getters are rejected instead of being invoked.

**Fix** — Declare schema literals and keep them literal with `as const satisfies ExpressionSchema`:

```typescript
import { compileExpression, type ExpressionSchema } from 'blendsdk/blendscript';

const schema = {
  Country: { type: 'string' },
  OrderTotal: { type: 'number' },
} as const satisfies ExpressionSchema;

const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', { schema });
console.log(compilation.ok); // true
```

---

#### Expression schema cannot contain more than 1024 fields. (BS_SCHEMA_FIELD_LIMIT_EXCEEDED)

**Message** — `Expression schema cannot contain more than 1024 fields.`

**Cause** — Schema size is capped at 1,024 declared fields; the check runs before any source analysis.

**Fix** — Stay at or below the cap, and split large rule sets when you reach it:

```typescript
import {
  BlendScriptApiError,
  compileExpression,
  type ExpressionFieldSchema,
  type ExpressionSchema,
} from 'blendsdk/blendscript';

function buildSchema(count: number): ExpressionSchema {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index): readonly [string, ExpressionFieldSchema] => [
      `F${index}`,
      { type: 'boolean' },
    ])
  );
}

const withinLimit = compileExpression('TRUE', { schema: buildSchema(1_024) });
console.log(withinLimit.ok); // true

try {
  compileExpression('TRUE', { schema: buildSchema(1_025) });
} catch (error) {
  if (error instanceof BlendScriptApiError && error.code === 'BS_SCHEMA_FIELD_LIMIT_EXCEEDED') {
    console.error(error.message); // Expression schema cannot contain more than 1024 fields.
  } else {
    throw error;
  }
}
```

---

#### Expected a compiled expression created by this package instance. (BS_INVALID_COMPILED_EXPRESSION)

**Message** — `Expected a compiled expression created by this package instance.`

**Cause** — A compiled handle is an opaque, branded memory value backed by a module-private `WeakMap`. The throw happens when you pass:

1. A structural lookalike such as `{}`, a spread copy, or `JSON.parse(JSON.stringify(handle))` (which serializes to `{}`).
2. `null`/`undefined` because compilation failed and evaluation was attempted anyway.
3. A handle compiled by a **different loaded copy** of the package — the direct package versus the umbrella, duplicated installs, or a reloaded module cache all create separate brands.

**Fix** — Keep the chain `compile → check ok → evaluate` intact, and persist `{ source, options }` instead of the handle:

```typescript
import {
  BlendScriptApiError,
  compileExpression,
  evaluateExpression,
} from 'blendsdk/blendscript';

const source = 'Enabled';
const compilation = compileExpression(source, {
  schema: { Enabled: { type: 'boolean' } },
});

if (!compilation.ok) {
  throw new Error(`Rule rejected: ${compilation.diagnostics[0]?.code ?? 'unknown'}`);
}

try {
  const result = evaluateExpression(compilation.expression, { Enabled: true });
  console.log(result.ok ? result.value : result.diagnostic.code); // true
} catch (error) {
  if (error instanceof BlendScriptApiError && error.code === 'BS_INVALID_COMPILED_EXPRESSION') {
    console.error('Handle identity lost — recompile from the stored source.');
  } else {
    throw error;
  }
}
```

---

#### Evaluation data must be a caller-materialized ordinary object. (BS_INVALID_ARGUMENT)

**Message** — `Evaluation data must be a caller-materialized ordinary object.`

**Cause** — The record **container** is not an ordinary object: it is `null`, an array, a class instance, or an object with an inherited prototype such as `Object.create({ Country: 'NL' })`. This is distinct from individual field problems, which are returned as diagnostics rather than thrown.

**Fix** — Materialize plain records (own data properties only) before evaluating:

```typescript
import { compileExpression, evaluateExpression, type ExpressionValue } from 'blendsdk/blendscript';

const compilation = compileExpression('Country == "NL"', {
  schema: { Country: { type: 'string' } },
});
if (!compilation.ok) throw new Error('Expression should compile.');

const record: Readonly<Record<string, ExpressionValue>> = { Country: 'NL' };
const result = evaluateExpression(compilation.expression, record);
console.log(result.ok ? result.value : result.diagnostic.code); // true
```

---

### Source Diagnostics from Lexing, Parsing, and Analysis

#### BS_UNKNOWN_FIELD

**Message** — `Field "Missing" is not declared in the schema.` Returned with the exact `span` and one-based `location` of the identifier. There are deliberately no spelling suggestions.

**Cause** — Field lookup is an exact, case-sensitive match against the declared schema. `missing`, `Missing`, and `[Missing]` are three different things unless declared exactly that way. Names containing spaces or keyword-like text require bracket syntax: `[Order Total]`, `[AND]`, `[A]]B]`.

**Fix** — Declare the field exactly as written, or fix the formula:

```typescript
import { compileExpression, type ExpressionSchema } from 'blendsdk/blendscript';

const schema = {
  Country: { type: 'string' },
  'Order Total': { type: 'number' },
} as const satisfies ExpressionSchema;

const compilation = compileExpression('[Order Total] >= 1000 AND Country == "NL"', { schema });
console.log(compilation.ok); // true

const typo = compileExpression('country == "NL"', { schema });
if (!typo.ok) console.error(typo.diagnostics[0]?.message);
// Field "country" is not declared in the schema.
```

---

#### BS_UNEXPECTED_TOKEN

**Messages** —

| Message | Trigger |
| --- | --- |
| `Built-in trim must be called with parentheses.` | A built-in name used as a bare field and not declared in the schema |
| `Only documented BlendScript built-ins can be called.` | `foo(` where `foo` is not one of the twelve built-ins |
| `Unexpected token after the complete expression.` | Stray tokens and chained comparisons such as `1 < 2 < 3` |
| `Expected a literal, field, built-in call, or grouped expression.` | Empty source, `A AND`, leading operators |
| `IN must be followed by a parenthesized literal list.` / `IN requires at least one literal.` / `IN members must be primitive literals.` / `A trailing comma is not allowed in IN.` / `The IN list is missing its closing parenthesis.` | `IN` grammar violations |
| `A trailing comma is not allowed in a call.` / `The built-in call is missing its closing parenthesis.` / `The grouped expression is missing its closing parenthesis.` | Unclosed or malformed call/group |

**Cause** — BlendScript is a closed language. The parser only builds fields, literals, operators, and calls to the fixed built-in set, with an explicit grammar (no chained comparisons, no trailing commas, `IN` accepts literal members only).

**Fix** — Use calls for built-ins and brackets for fields that collide with built-in names; rewrite chained comparisons:

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const schema = {
  trim: { type: 'string' },
  Text: { type: 'string' },
} as const;

const builtin = validateExpression('trim(Text) == "x"', { schema }); // call
const field = validateExpression('[trim] == "x"', { schema }); // field
console.log(builtin.ok, field.ok); // true true

const chained = validateExpression('1 < 2 < 3', { schema: {} });
const fixed = validateExpression('1 < 2 AND 2 < 3', { schema: {} });
console.log(chained.ok, fixed.ok); // false true
```

---

#### BS_TYPE_MISMATCH

**Messages** —

| Message | Trigger |
| --- | --- |
| `Equality operands must have compatible types.` | `==`/`!=` across incompatible types, or `NULL` against a non-nullable operand |
| `Equality operands must have compatible types. Use text(...) or tryNumber(...) to convert scalar values explicitly.` | Same, with a `scalar` operand — the conversion hint is appended |
| `Ordering comparisons require numeric operands.` | `<`, `<=`, `>`, `>=` on strings, booleans, or scalars |
| `IN members must have a type compatible with the left operand.` | Mixed-type membership list, or `NULL` against a non-nullable operand |
| `NOT requires a Boolean expression.` / `AND requires Boolean operands.` / `OR requires Boolean operands.` | Logical operators on non-Boolean input |
| `contains argument 1 must be string.` and similar | A built-in received the wrong argument type |

**Cause** — There is no implicit conversion anywhere in the language. `scalar` fields preserve either a string or a finite number and must be converted explicitly before concrete-type operations.

**Fix** — Convert scalars explicitly and guard nullability statically:

```typescript
import { compileExpression, validateExpression, type ExpressionSchema } from 'blendsdk/blendscript';

const schema = {
  Item: { type: 'scalar' },
  Text: { type: 'string' },
  Count: { type: 'number' },
} as const satisfies ExpressionSchema;

const rejected = validateExpression('Item == "1"', { schema });
console.log(rejected.ok); // false — BS_TYPE_MISMATCH with conversion hint

const numeric = compileExpression('tryNumber(Item) != NULL AND tryNumber(Item) >= 1', { schema });
const textual = compileExpression('text(Item) == "1"', { schema });
console.log(numeric.ok, textual.ok); // true true
```

Nullability must also be declared before `NULL` can appear in comparisons:

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const required = validateExpression('Country == NULL', {
  schema: { Country: { type: 'string' } },
});
console.log(required.ok); // false — BS_TYPE_MISMATCH

const nullable = validateExpression('Country == NULL', {
  schema: { Country: { type: 'string', nullable: true } },
});
console.log(nullable.ok); // true
```

---

#### BS_INVALID_ARGUMENT_COUNT

**Message** — `trim expects 1 argument(s).` (`<name> expects <count> argument(s).`)

**Cause** — The built-in set has fixed arity; calls are statically checked left-to-right.

| Built-in | Arguments | Result | Accepts `null` |
| --- | --- | --- | --- |
| `isEmpty(value)` | 1 string | boolean | Yes → `true` |
| `isBlank(value)` | 1 string | boolean | Yes → `true` |
| `contains(value, search)` | 2 strings | boolean | No |
| `startsWith(value, search)` | 2 strings | boolean | No |
| `endsWith(value, search)` | 2 strings | boolean | No |
| `equalsIgnoreCase(left, right)` | 2 strings | boolean | No |
| `trim(value)` | 1 string | string | No |
| `lower(value)` | 1 string | string | No |
| `upper(value)` | 1 string | string | No |
| `length(value)` | 1 string | number (code points) | No |
| `tryNumber(value)` | 1 scalar | number or null | Yes → `null` |
| `text(value)` | 1 scalar | string | No |

**Fix** — Match the signature:

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const schema = { Text: { type: 'string' } } as const;

const missing = validateExpression('contains(Text)', { schema });
console.log(missing.ok, missing.ok ? '' : missing.diagnostics[0]?.message);
// false "contains expects 2 argument(s)."

const fixed = validateExpression('contains(Text, "Blend")', { schema });
console.log(fixed.ok); // true
```

---

#### BS_EXPECTED_RESULT_TYPE_MISMATCH

**Message** — `Expression result must be a non-null boolean.` (`Expression result must be a non-null <expectedResult>.`)

**Cause** — When `expectedResult` is provided, the inferred type must match exactly **and** be non-nullable. Two frequent surprises:

- A nullable field used as the whole expression is not a "non-null string", even though the type name matches.
- `tryNumber(Item)` infers `{ type: 'number', nullable: true }`, so `expectedResult: 'number'` fails even though the result type is numeric.

**Fix** — Produce a non-null result, guard the nullable path, or drop `expectedResult`:

```typescript
import { validateExpression, type ExpressionOptions } from 'blendsdk/blendscript';

const nullableResult = validateExpression('Country', {
  schema: { Country: { type: 'string', nullable: true } },
  expectedResult: 'string',
});
console.log(nullableResult.ok); // false — nullable string is not a non-null string

const fixedOptions: ExpressionOptions = {
  schema: { Country: { type: 'string' } },
  expectedResult: 'string',
};
console.log(validateExpression('Country', fixedOptions).ok); // true

const guarded = validateExpression('tryNumber(Item) != NULL AND tryNumber(Item) > 0', {
  schema: { Item: { type: 'scalar' } },
  expectedResult: 'boolean',
});
console.log(guarded.ok); // true
```

---

#### BS_INVALID_CHARACTER

**Message** — `Character "+" is not valid BlendScript syntax.`

**Cause** — v1 has a closed alphabet. Anything outside it fails lexing at the first offending character, including arithmetic operators, ternaries, property access, assignment, comments, and regular expressions.

| You want | v1 behavior | Do instead |
| --- | --- | --- |
| Arithmetic `A + 1`, `A * 2` | `BS_INVALID_CHARACTER` | Compute host-side; pass the result as a field |
| Ternary `A ? B : C` | `BS_INVALID_CHARACTER` (`?`) | Rewrite with `AND` / `OR` logic |
| Property access `A.B` | `BS_INVALID_CHARACTER` (`.`) | Flatten data into schema fields |
| Comments `A // note` | `BS_INVALID_CHARACTER` (`/`) | Not supported — keep rules short |
| Assignment `A = 1`, statements `A;` | Invalid character / unexpected token | Rules are expressions only |
| Regex `/abc/`, templates `` `x` `` | `BS_INVALID_CHARACTER` | Not supported |

**Fix** — Express the same rule with supported operators, or precompute in host code:

```typescript
import { compileExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('OrderTotal >= 1000 AND NOT (Country == "NL")', {
  schema: { OrderTotal: { type: 'number' }, Country: { type: 'string' } },
});
console.log(compilation.ok); // true
```

---

#### BS_INVALID_STRING

**Messages** —

| Message | Trigger |
| --- | --- |
| `The string literal is missing its closing quote.` | Unterminated literal |
| `String literals cannot contain raw line breaks.` | Literal newline, CR, U+2028, or U+2029 inside quotes |
| `The string contains an unsupported escape sequence.` | `"\x"`, `"\q"`, and similar |
| `Unicode escapes require exactly four hexadecimal digits.` | `"\u123"` |
| `A high surrogate escape must be followed by a low surrogate escape.` | Lone `"\uD83D"` |
| `A low surrogate escape requires a preceding high surrogate escape.` | Lone `"\uDE00"` |
| `String literals cannot contain an unpaired surrogate.` | Raw high/low surrogate in the literal |

**Cause** — Strings are single-line and support exactly `\" \\ \n \r \t \b \f` plus `\uXXXX` escapes. Astral characters must be written directly or as a valid surrogate pair. The decoded literal is capped at 4,096 UTF-16 code units (`BS_STRING_LITERAL_TOO_LONG`).

**Fix** — Escape line breaks and use valid escapes for unicode:

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const schema = { Text: { type: 'string' } } as const;

const broken = validateExpression('Text == "line\nbreak"', { schema });
console.log(broken.ok, broken.ok ? '' : broken.diagnostics[0]?.code);
// false BS_INVALID_STRING

const fixed = validateExpression('Text == "line\\nbreak"', { schema });
console.log(fixed.ok); // true

const emoji = validateExpression('Text == "\\uD83D\\uDE00"', { schema });
console.log(emoji.ok); // true
```

---

#### BS_INVALID_NUMBER

**Messages** — `The number literal is malformed.` and `Number literals must be finite.`

**Cause** — Only decimal literals are supported: optional sign, digits with an optional fraction, optional exponent (`-12.5`, `+2`, `.5`, `5.`, `1e3`). Base prefixes (`0x10`, `0b10`, `0o10`), digit separators (`1_000`), and partially numeric text (`12.5suffix`, `1e`) fail as malformed, and overflow such as `1e309` fails as non-finite. Note that `NaN` and `Infinity` are lexed as identifiers, so they surface as `BS_UNKNOWN_FIELD`, not `BS_INVALID_NUMBER`.

**Fix** — Use supported decimal forms, or pass computed numbers as fields:

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const forms = ['0', '007', '-12.5', '+2', '.5', '5.', '1e3', '-2.5E-2'];

for (const source of forms) {
  const result = validateExpression(source, { schema: {} });
  console.log(source, result.ok ? result.resultType.type : result.diagnostics[0]?.code);
}

const overflow = validateExpression('1e309', { schema: {} });
console.log(overflow.ok ? '' : overflow.diagnostics[0]?.message);
// Number literals must be finite.
```

---

#### The limit diagnostics

**Messages and boundaries** —

| Code | Message | Boundary |
| --- | --- | --- |
| `BS_SOURCE_TOO_LONG` | `Expression source cannot exceed 16384 UTF-16 code units.` | Checked before tokenization; span is clipped to `[16384, 16385)` |
| `BS_TOKEN_LIMIT_EXCEEDED` | `Expression cannot contain more than 4096 tokens.` | Non-EOF tokens |
| `BS_STRING_LITERAL_TOO_LONG` | `String literals cannot exceed 4096 UTF-16 code units.` | Decoded length, after escape processing |
| `BS_FIELD_NAME_TOO_LONG` | `Field names cannot exceed 256 UTF-16 code units.` | Bracketed field names |
| `BS_NESTING_LIMIT_EXCEEDED` | `Expression nesting cannot exceed 64 levels.` | Groups, built-in calls, and `NOT`; `IN` list parentheses are not counted |

**Cause** — Every bound is fixed and inclusive at the stated value. Limits keep analysis and evaluation deterministic and terminate hostile input.

**Fix** — Keep rules within bounds; for nesting, flatten redundant groups and split long call chains:

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const sourceLimit = validateExpression(`${' '.repeat(16_381)}TRUE`, { schema: {} });
console.log(sourceLimit.ok ? '' : sourceLimit.diagnostics[0]?.message);
// Expression source cannot exceed 16384 UTF-16 code units.

const tooDeep = validateExpression(`${'('.repeat(65)}TRUE${')'.repeat(65)}`, { schema: {} });
console.log(tooDeep.ok ? '' : tooDeep.diagnostics[0]?.code);
// BS_NESTING_LIMIT_EXCEEDED
```

---

### Record and Runtime Diagnostics

#### BS_MISSING_FIELD

**Message** — `Record is missing required field "Country".` (record diagnostic, `reason: 'missing-field'`, `actualType: 'missing'`)

**Cause** — Before evaluation, **every declared field is validated** — including fields the expression never references. Evaluating `TRUE` with `{ schema: { Country: ... } }` and `{}` still fails. An own property whose value is `undefined` is a different failure (`BS_RUNTIME_TYPE_MISMATCH`, `actualType: 'undefined'`). The first failure is reported in captured schema-declaration order, not record order.

**Fix** — Provide every declared field, or keep the schema equal to the record contract:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('TRUE', {
  schema: { Country: { type: 'string' } },
});
if (!compilation.ok) throw new Error('Expression should compile.');

const result = evaluateExpression(compilation.expression, {});
if (!result.ok) {
  console.error(result.diagnostic.code); // BS_MISSING_FIELD
  console.error(result.diagnostic.message); // Record is missing required field "Country".
}
```

---

#### BS_RUNTIME_TYPE_MISMATCH

**Messages** —

| Message | `reason` | When |
| --- | --- | --- |
| `Record is missing required field "X".` | `missing-field` | Own property absent (`BS_MISSING_FIELD`) |
| `Record field "X" must be an own data property.` | `accessor-property` | Declared field is a getter/setter — never invoked |
| `Record field "X" cannot be null.` | `null-not-allowed` | `null` in a non-nullable field |
| `Record field "X" does not match its declared type.` | `type-mismatch` | `typeof` mismatch, or own `undefined` |
| `Record field "X" does not match its declared type.` | `non-finite-number` | `NaN` / `±Infinity` for `number` or `scalar` |
| `Record field "X" exceeds the string length limit.` | `string-too-long` | String over 4,096 code units (`BS_STRING_VALUE_LIMIT_EXCEEDED`) |

**Cause** — The evaluator never coerces. A string in a `number` field, a boolean in a `scalar` field, a class instance, or a getter-backed property all fail before any node is visited. Diagnostic metadata (`expectedType`, `nullable`, `actualType`) is derived from the property descriptor only — rejected values are never read, serialized, or included in the message.

**Fix** — Normalize records host-side before evaluating:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('OrderTotal >= 1000', {
  schema: { OrderTotal: { type: 'number' } },
});
if (!compilation.ok) throw new Error('Expression should compile.');

function toFiniteNumber(value: string | undefined): number {
  const parsed = Number(value ?? Number.NaN);
  return Number.isFinite(parsed) ? parsed : 0;
}

const result = evaluateExpression(compilation.expression, {
  OrderTotal: toFiniteNumber('1250'),
});
console.log(result.ok ? result.value : result.diagnostic.code); // true
```

---

#### BS_NULL_NOT_ALLOWED

**Messages** — `This operation cannot use a null value.` and `Built-in trim cannot use a null argument.` The span covers the complete operator or call.

**Cause** — A nullable field can be declared and validated, but it cannot flow into null-rejecting operations: ordering comparisons, `AND`/`OR`/`NOT`, and the built-ins `contains`, `startsWith`, `endsWith`, `equalsIgnoreCase`, `trim`, `lower`, `upper`, `length`, and `text`. Only `isEmpty`, `isBlank`, and `tryNumber` accept `null` at runtime.

**Fix** — Guard with an explicit null check and rely on short-circuiting, or compare booleans explicitly:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { Text: { type: 'string', nullable: true } } as const;

const unguarded = compileExpression('trim(Text) == "x"', { schema });
if (!unguarded.ok) throw new Error('Expression should compile.');
console.log(evaluateExpression(unguarded.expression, { Text: null }).ok); // false

const guarded = compileExpression('Text != NULL AND trim(Text) == "x"', { schema });
if (!guarded.ok) throw new Error('Expression should compile.');
console.log(evaluateExpression(guarded.expression, { Text: null }));
// { ok: true, value: false }
```

For nullable booleans, prefer `Enabled == TRUE` over `Enabled AND ...`; equality with `TRUE` returns `false` for `null` instead of failing.

---

#### BS_STRING_VALUE_LIMIT_EXCEEDED

**Messages** — `Record field "Text" exceeds the string length limit.` (input side) and `Built-in upper produced a string above the 4096 limit.` (derived side, source diagnostic on the call span).

**Cause** — Two distinct paths hit the same cap:

1. **Input**: a record string longer than 4,096 UTF-16 code units fails record validation.
2. **Derived**: a built-in can grow text past the cap even when inputs are within it — `upper('ß')` becomes `SS`, `lower`/`upper` of `İ`, and `equalsIgnoreCase` lowercasing can all expand length.

**Fix** — Enforce the cap host-side and account for case-mapping growth; there is no substring built-in, so truncation belongs to the caller:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('upper(Text)', {
  schema: { Text: { type: 'string' } },
});
if (!compilation.ok) throw new Error('Expression should compile.');

const grown = evaluateExpression(compilation.expression, { Text: 'ß'.repeat(4_096) });
console.log(grown.ok ? grown.value : grown.diagnostic.message);
// Built-in upper produced a string above the 4096 limit.
```

---

#### BS_EVALUATION_STEP_LIMIT_EXCEEDED

**Message** — `Evaluation cannot exceed 10000 deterministic work steps.`

**Cause** — Evaluation charges a deterministic budget: one step per visited node, plus the full UTF-16 length of every string consumed by a built-in (`contains` charges `value + search`, `equalsIgnoreCase` charges `left + right + max(left, right)` with a minimum of one per operation, `trim`/`lower`/`upper`/`length`/`isBlank`/`text`/`tryNumber` charge the argument length). Short-circuited branches are completely free, but repeated conversions of large strings quickly exhaust 10,000 steps.

**Fix** — Reduce repeated work, shorten inputs, or split the rule:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('equalsIgnoreCase(A, B)', {
  schema: { A: { type: 'string' }, B: { type: 'string' } },
});
if (!compilation.ok) throw new Error('Expression should compile.');

const result = evaluateExpression(compilation.expression, {
  A: 'a'.repeat(4_096),
  B: 'a'.repeat(4_096),
});
console.log(result.ok ? result.value : result.diagnostic.message);
// Evaluation cannot exceed 10000 deterministic work steps.
```

Two maximum-length strings already charge 12,288 steps inside `equalsIgnoreCase`; converting the same value three times in one rule overflows as well. Move bulky comparisons host-side, keep only the decisive comparisons in the rule, and use `TRUE OR <expensive>` style short-circuits where the outcome is already decided.

---

### TypeScript Compiler Errors

#### 'string' is not assignable to type 'ExpressionFieldType'

**Error** —

```text
Argument of type '{ schema: { Country: { type: string; }; }; }' is not assignable to parameter of type 'ExpressionOptions'.
  Type 'string' is not assignable to type 'ExpressionFieldType'.
```

**Cause** — Object literal properties widen: `{ type: 'string' }` is inferred as `{ type: string }`, and `ExpressionFieldType` is the union `'string' | 'number' | 'boolean' | 'scalar'`.

**Fix** — Preserve literals with `as const` / `satisfies`, or annotate explicitly:

```typescript
import { validateExpression, type ExpressionSchema } from 'blendsdk/blendscript';

const schema = {
  Country: { type: 'string' },
  OrderTotal: { type: 'number' },
} as const satisfies ExpressionSchema;

const result = validateExpression('Country == "NL" AND OrderTotal >= 1000', { schema });
console.log(result.ok); // true
```

---

#### Property 'value' does not exist on type ...

**Error** —

```text
Property 'value' does not exist on type 'Readonly<{ ok: false; diagnostic: ExpressionDiagnostic; }>'.
```

**Cause** — `ValidationResult`, `CompilationResult`, and `EvaluationResult` are discriminated unions. Accessing `value`, `expression`, or `diagnostics` before checking `ok` fails because the property only exists on one member — and at runtime the property would genuinely be absent.

**Fix** — Narrow with `if (!result.ok)` first:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('TRUE', { schema: {} });
if (!compilation.ok) throw new Error('Expression should compile.');

const result = evaluateExpression(compilation.expression, {});
if (!result.ok) throw new Error(result.diagnostic.message);

console.log(result.value); // true
```

---

#### Property '[compiledExpressionBrand]' is missing

**Error** —

```text
Property '[compiledExpressionBrand]' is missing in type '{}' but required in type 'CompiledExpression'.
```

**Cause** — `CompiledExpression` is intentionally opaque. The brand is a non-exported `unique symbol`, so no structural object can satisfy the type; only `compileExpression` can create handles. Forcing a cast (`evaluateExpression({} as CompiledExpression, {})`) compiles but throws `BlendScriptApiError` with `BS_INVALID_COMPILED_EXPRESSION` at runtime.

**Fix** — Use the handle type for annotations and let `compileExpression` create values:

```typescript
import { compileExpression, evaluateExpression, type CompiledExpression } from 'blendsdk/blendscript';

function run(expression: CompiledExpression, record: Readonly<Record<string, boolean>>): boolean {
  const result = evaluateExpression(expression, record);
  return result.ok && result.value === true;
}

const compilation = compileExpression('Enabled', { schema: { Enabled: { type: 'boolean' } } });
if (!compilation.ok) throw new Error('Expression should compile.');

console.log(run(compilation.expression, { Enabled: true })); // true
```

---

#### Two incompatible CompiledExpression types

**Error** —

```text
Argument of type 'CompiledExpression' is not assignable to parameter of type 'CompiledExpression'.
  Types have separate declarations of a private property 'compiledExpressionBrand'.
```

**Cause** — The direct package (`blendsdk/blendscript`) and the umbrella re-export (`blendsdk/blendscript`) load as separate module instances with separate brands, as do duplicated installs in `node_modules`. Mixing a handle from one instance with the evaluator of another is rejected by the compiler and, if forced, throws `BS_INVALID_COMPILED_EXPRESSION` at runtime.

**Fix** — Compile and evaluate through one import specifier per handle:

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Enabled', {
  schema: { Enabled: { type: 'boolean' } },
});
if (!compilation.ok) throw new Error('Expression should compile.');

console.log(evaluateExpression(compilation.expression, { Enabled: true }).ok); // true
```

If the compiler reports this mismatch, inspect your dependency tree for duplicate copies and standardize on a single package path.

---

#### Cannot find module 'blendsdk/blendscript/...'

**Error** —

```text
error TS2307: Cannot find module 'blendsdk/blendscript/evaluator' or its corresponding type declarations.
```

**Cause** — The export map exposes only the package root. Internal modules are deliberately unreachable, and deep `dist/` paths are blocked at runtime as well (`ERR_PACKAGE_PATH_NOT_EXPORTED` for subpaths). The full public surface is four runtime values plus types.

**Fix** — Import everything from the package root:

```typescript
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';

const validation = validateExpression('TRUE', { schema: {} });
console.log(validation.ok); // true

const compilation = compileExpression('TRUE', { schema: {} });
if (compilation.ok) {
  console.log(evaluateExpression(compilation.expression, {}).ok); // true
}
```

---

#### Cannot assign to 'reason' because it is a read-only property

**Error** —

```text
Cannot assign to 'reason' because it is a read-only property.
```

**Cause** — All results, diagnostics, and their nested members are frozen at runtime and `readonly` in the types. Mutation attempts fail in TypeScript, and in strict-mode JavaScript they throw `TypeError` because the objects are frozen.

**Fix** — Copy the values you need into new objects instead of mutating diagnostics:

```typescript
import {
  compileExpression,
  evaluateExpression,
  type ExpressionDiagnostic,
} from 'blendsdk/blendscript';

const compilation = compileExpression('Item', { schema: { Item: { type: 'string' } } });
if (!compilation.ok) throw new Error('Expression should compile.');

const result = evaluateExpression(compilation.expression, { Item: 1 });
if (!result.ok) {
  const summary: Readonly<{ code: ExpressionDiagnostic['code']; field?: string }> = {
    code: result.diagnostic.code,
    ...(result.diagnostic.kind === 'record' ? { field: result.diagnostic.field } : {}),
  };
  console.log(summary); // { code: 'BS_RUNTIME_TYPE_MISMATCH', field: 'Item' }
}
```

---

#### Error [ERR_PACKAGE_PATH_NOT_EXPORTED] — require of the package fails

**Symptom** —

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../node_modules/blendsdk/blendscript/package.json
```

**Cause** — The package is ESM-only (`"type": "module"`) and its export map defines only the `types` and `import` conditions. A CommonJS `require()` resolves against conditions that never match, so module resolution fails before any code runs.

**Fix** — Import with ESM syntax from an ESM consumer:

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const result = validateExpression('TRUE', { schema: {} });
console.log(result.ok); // true
```

If the consumer must stay CommonJS, load the package with a dynamic `import()` from an async function (make sure your compiler preserves the dynamic import — for example with `module: node16`/`nodenext`):

```typescript
async function validateRuleFromCommonJs(source: string): Promise<boolean> {
  const { validateExpression } = await import('blendsdk/blendscript');
  const result = validateExpression(source, { schema: {} });
  return result.ok;
}
```

---

## Debugging Strategies

### 1. Identify the failure channel first

Decide whether the call threw or returned `ok: false`. Thrown `BlendScriptApiError` means the caller passed something invalid (source, options, schema, handle, record container) — fix the integration. Returned diagnostics mean the input was structurally acceptable and the failure belongs to the formula or the record — fix the content.

```typescript
import {
  BlendScriptApiError,
  compileExpression,
  evaluateExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
};
const source = 'Country == "NL" AND OrderTotal >= 1000';

try {
  const compilation = compileExpression(source, options);
  if (!compilation.ok) {
    for (const diagnostic of compilation.diagnostics) {
      console.error(`${diagnostic.code}: ${diagnostic.message}`);
    }
  } else {
    const result = evaluateExpression(compilation.expression, { Country: 'NL', OrderTotal: 1250 });
    console.log(result.ok ? result.value : `${result.diagnostic.code}: ${result.diagnostic.message}`);
  }
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.error(`Programmer error ${error.code}: ${error.message}`);
  } else {
    throw error;
  }
}
```

### 2. Print the full diagnostic payload

Read `code`, `location`, `span`, and `excerpt` together — the span is machine precision, the location is human precision, and the excerpt is context. At most 20 semantic diagnostics are returned, sorted by span start, then span end, then code, so fixing the earliest spans first is the fastest path.

```typescript
import { compileExpression } from 'blendsdk/blendscript';

const source = 'Country == "NL" AND OrderTotal >= "1000"';
const compilation = compileExpression(source, {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
});

if (!compilation.ok) {
  for (const diagnostic of compilation.diagnostics) {
    const { code, message, location, span, excerpt } = diagnostic;
    console.error(`${code} (${location.line}:${location.column}) ${message}`);
    console.error(`  span: [${span.start}, ${span.end})`);
    console.error(`  suspect: ${JSON.stringify(source.slice(span.start, span.end))}`);
    if (excerpt !== undefined) console.error(`  excerpt: ${JSON.stringify(excerpt)}`);
  }
}
```

Note that `location` uses one-based lines and UTF-16 columns, counts `\r\n` as a single line break, and treats U+2028/U+2029 as line breaks. The `excerpt` is a bounded 120-code-unit window and may begin before the failing span, so always slice with `span` when you need the exact text.

### 3. Reduce to a minimal failing expression

Bisect the rule: validate literal subexpressions, then combine them with `AND`, then swap in fields. Because `validateExpression` and `compileExpression` share one pipeline, you can debug with validation alone — the compiled result differs only by the handle.

```typescript
import { validateExpression, type ExpressionSchema } from 'blendsdk/blendscript';

const schema = {
  Country: { type: 'string' },
  OrderTotal: { type: 'number' },
  Enabled: { type: 'boolean' },
} as const satisfies ExpressionSchema;

function check(source: string): void {
  const result = validateExpression(source, { schema, expectedResult: 'boolean' });
  if (result.ok) {
    console.log(`OK   ${source}`);
    return;
  }
  for (const diagnostic of result.diagnostics) {
    console.log(`FAIL ${source} → ${diagnostic.code} ${diagnostic.message}`);
  }
}

check('Country == "NL"');
check('Country == "NL" AND OrderTotal >= 1000');
check('Country == "NL" AND OrderTotal >= "1000"'); // string literal against number
check('Enabled AND OrderTotal >= "1000"');
```

### 4. Inspect record and runtime metadata instead of guessing

Record diagnostics are structured: `reason` explains the category, `field` names the culprit, `expectedType`/`nullable` describe the declaration, and `actualType` is a value-free classification. Runtime source diagnostics use the same shape as authoring failures, with spans against the original source.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('OrderTotal >= 1000', {
  schema: { OrderTotal: { type: 'number' } },
});
if (!compilation.ok) throw new Error('Expression should compile.');

const result = evaluateExpression(compilation.expression, { OrderTotal: 'not-a-number' });
if (!result.ok) {
  const diagnostic = result.diagnostic;
  if (diagnostic.kind === 'record') {
    console.error({
      code: diagnostic.code,
      field: diagnostic.field,
      reason: diagnostic.reason,
      expectedType: diagnostic.expectedType,
      nullable: diagnostic.nullable,
      actualType: diagnostic.actualType,
    });
  } else {
    console.error(diagnostic.code, diagnostic.message);
  }
}
```

### 5. Verify schema and formula agree, character by character

Most `BS_UNKNOWN_FIELD` reports are case or spelling mismatches. Print the declared keys, compare them with the formula, and remember that names with spaces or keyword collisions need brackets.

```typescript
import { validateExpression, type ExpressionSchema } from 'blendsdk/blendscript';

const schema = {
  Country: { type: 'string' },
  'Order Total': { type: 'number' },
} as const satisfies ExpressionSchema;

for (const name of Object.keys(schema)) {
  console.log(`schema field: ${JSON.stringify(name)}`);
}

const result = validateExpression('[Order Total] >= 1000 AND Country == "NL"', { schema });
console.log(result.ok ? 'valid' : result.diagnostics[0]?.message);
```

### 6. Keep the compile → evaluate chain inside one package instance

Never serialize handles, never rebuild them from lookalikes, and never pass a handle across import specifiers or duplicated installs. Persist `{ source, options }` and recompile after loading. Reuse the exact handle returned by one successful `compileExpression` call for as many records as needed.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('OrderTotal >= 1000', {
  schema: { OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const records = [{ OrderTotal: 999 }, { OrderTotal: 1_000 }, { OrderTotal: 1_001 }];

for (const record of records) {
  const result = evaluateExpression(compilation.expression, record);
  console.log(record.OrderTotal, result.ok ? result.value : result.diagnostic.code);
}
```

### 7. Budget-test with worst-case records

Limits are part of the contract, so test them deliberately: 4,096-code-unit strings, repeated conversions, and double-heavy comparisons. Work through a record your users could realistically paste, and confirm the result — a limit diagnostic on pathological input is the intended behavior, not a bug.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('equalsIgnoreCase(A, B)', {
  schema: { A: { type: 'string' }, B: { type: 'string' } },
});
if (!compilation.ok) throw new Error('Expression should compile.');

const worstCase = { A: 'a'.repeat(4_096), B: 'b'.repeat(4_096) };
const result = evaluateExpression(compilation.expression, worstCase);
console.log(result.ok ? result.value : result.diagnostic.code);
// BS_EVALUATION_STEP_LIMIT_EXCEEDED
```

### 8. Convert every confirmed failure into a regression test

For each reproduced failure, keep a minimal pair: the rejected input with its expected `code` and reason, and the accepted replacement with its expected value. Assert on `code`, `reason`, `field`, and boundary values (`4_096` vs `4_097` characters, `1_024` vs `1_025` schema fields, 64 vs 65 nesting levels, exact `result.value` including `false` and `null`). Asserting on `ok` alone hides regressions in diagnostic metadata.

---

## Known Pitfalls

### Formula Authoring

- **`NOT` binds tighter than comparisons.** `NOT A == TRUE` parses as `(NOT A) == TRUE`. Write `NOT (A == TRUE)` when you mean the comparison.
- **Chained comparisons are never valid.** `1 < 2 < 3` fails with `BS_UNEXPECTED_TOKEN` on the second operator; combine with `AND`.
- **Operators never coerce.** `Item == 1` fails statically for a scalar field, and `Text == Count` fails for `string` vs `number`. Convert with `text(...)` or `tryNumber(...)` first; ordering comparisons are numeric-only.
- **Null rules are static too.** `Country == NULL` and `Country IN ("NL", NULL)` require `nullable: true` on the field, or they are rejected before any record is seen.
- **Bare built-in names are special-cased.** `trim` alone reports `Built-in trim must be called with parentheses.`; declare a `trim` field and reference `[trim]` if you truly need that name.
- **A bare built-in-named field can still work.** When a field named `trim` is declared, `trim == "x"` parses as a field comparison — but `[trim]` is the unambiguous form. Prefer brackets for every keyword or built-in collision.
- **Keywords are case-insensitive; field names are not.** `true`, `TRUE`, and `Or` are keywords; `country` and `Country` are different fields.
- **`AND` binds tighter than `OR`.** `A OR B AND C` means `A OR (B AND C)`; parenthesize mixed logic.
- **Strings are single-line and escape-finite.** Only `\" \\ \n \r \t \b \f` and `\uXXXX` (with valid surrogate pairs) are accepted; no `\x`, no raw line breaks, no template literals.
- **Numbers are decimal and finite only.** No hex/binary/octal, digit separators, or overflow; `NaN` and `Infinity` are unknown fields, not number errors.
- **`IN` lists are literal-only and closed.** No field references inside, no empty list, no trailing comma, at least one member — duplicates are allowed.
- **Unsupported conveniences are deliberate syntax errors.** Arithmetic, ternaries, `A.B`, comments, regex, and statements all fail at the lexer or parser.

### Limits and Budgets

- **Counts are UTF-16 code units; `length(...)` counts code points.** `length("😀")` is `1`, yet 2,049 emoji already occupy 4,098 code units and fail record validation.
- **Only 20 semantic diagnostics come back, sorted deterministically.** Fix the earliest spans and re-run; the list is truncated, not complete.
- **First lexical or syntax error stops the pipeline.** Lexing and parsing fail fast with a single diagnostic; only semantic analysis collects multiple findings.
- **`expectedResult` demands a non-null result.** `tryNumber(Item)` is `{ type: 'number', nullable: true }`, so `expectedResult: 'number'` fails — guard with `tryNumber(Item) != NULL AND ...` or drop `expectedResult`.
- **Repeated conversions burn the 10,000-step budget.** Each `text(...)`/`tryNumber(...)`/`contains(...)` charges string lengths; two maximum-length conversions fit, three overflow. Short-circuited branches are free.

### Records and Runtime

- **Every declared field is preflighted, even unreferenced ones.** `TRUE` fails when a declared field is missing. Keep the schema equal to the record contract, or you will validate data the rule never reads.
- **Failure order follows schema declaration order, not the record.** The first failing field in the schema object is the one reported; reorder or fix accordingly.
- **`undefined` is not "missing".** Missing → `missing-field` + `BS_MISSING_FIELD`; own `undefined` → `type-mismatch` + `BS_RUNTIME_TYPE_MISMATCH`.
- **Accessors are rejected, never executed.** A declared getter produces `accessor-property` without running; undeclared extras are ignored without being read.
- **`NaN` and `±Infinity` are rejected everywhere numbers are expected**, including `scalar`. `-0` is treated as `0`.
- **Derived strings can exceed the cap below the input cap.** `upper`, `lower`, and `equalsIgnoreCase` can grow text (`ß` → `SS`, `İ` folding), and there is no substring built-in — enforce truncation host-side.
- **Evaluation mixes two channels.** A bad record container throws `BS_INVALID_ARGUMENT`; bad field values return `ok: false` diagnostics. Wrap calls in `try/catch` and still check `ok`.
- **`options` and schema are snapshotted at the call.** Later mutations do not affect compiled handles, and getters are rejected rather than read lazily — pass final values, not live views.

### Handles, Freezing, and Tooling

- **Handles are instance-bound and invisible to serialization.** `JSON.stringify(handle)` is `{}`; rehydrated or cross-instance handles throw `BS_INVALID_COMPILED_EXPRESSION`. Persist `{ source, options }` and recompile.
- **Results and diagnostics are frozen.** `TypeError` on mutation at runtime; `Cannot assign to ... read-only property` at compile time. Copy fields into new objects when you need to evolve them.
- **Schema literal widening breaks type checking.** `const schema = { A: { type: 'string' } }` infers `type: string`; annotate with `ExpressionSchema` or use `as const satisfies ExpressionSchema`.
- **`expectedResult` cannot be `'scalar'`.** `scalar` is a field type only; convert the result with `text(...)`/`tryNumber(...)` or expect `string`/`number`/`boolean`/`null`.
- **The package is ESM-only.** `require()` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`; use ESM imports, or a preserved dynamic `import()` from CommonJS, and target Node.js >= 22.

---

## Related Documentation

- API Reference — every exported type, diagnostic code, and limit in detail.
- Core Concepts — the language model behind the diagnostics.
- Testing Patterns — turning the checks above into regression tests.
- Examples Library — complete, working rules including scalar and nullable patterns.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
