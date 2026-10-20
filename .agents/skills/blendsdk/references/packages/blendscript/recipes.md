> **Package**: `blendsdk/blendscript`

# blendscript Advanced Patterns

`blendsdk/blendscript` exposes three functions and one error class, but production applications wrap them in structure: caches, authorization policies, diagnostic formatters, batch pipelines, and durable storage. This document presents eight composable patterns for doing exactly that, using only the public API from the package root (workspace packages import from `blendsdk/blendscript`; npm consumers import the identical build from `blendsdk/blendscript`).

| Pattern | Solves | Key features combined |
| --- | --- | --- |
| The rule catalog | Recompiling on every request; shipping unvalidated rules | `validateExpression`, cached `compileExpression`, revision invalidation |
| Field-level access control | Rule authors referencing restricted fields | `referencedFields`, per-role policy, `expectedResult` |
| One diagnostic formatter | Presenting authoring and runtime failures consistently | `ExpressionDiagnostic` discriminated union |
| Mixed scalar conversions | Spreadsheet columns that are text or numbers | `scalar` fields, `tryNumber`, `text`, authoring diagnostics |
| Batch partitioning | Evaluating one rule over many rows without aborting | handle reuse, `EvaluationResult` narrowing |
| Durable documents | Surviving restarts, deploys, and upgrades | source + schema documents, rehydration |
| Evaluation budget | Heavy rules hitting the deterministic step limit | short-circuiting, work charging, failure classification |
| Schema-derived types | Host records drifting from the schema | `as const satisfies`, conditional types |

---

## The Rule Catalog: Validate on Write, Compile Once, Evaluate Often

**Use this pattern when** rules are stored as text, edited over time, and evaluated many times per process — for example a business-rules service or a pricing engine. The catalog validates a rule the moment it is saved, compiles each revision at most once, and keeps handles process-local.

### Complete example

```typescript
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type CompiledExpression,
  type EvaluationResult,
  type ExpressionOptions,
  type ExpressionValue,
  type SourceExpressionDiagnostic,
} from 'blendsdk/blendscript';

/** The durable rule definition owned by the application, not the library. */
interface RuleDefinition {
  readonly id: string;
  readonly revision: number;
  readonly source: string;
  readonly options: ExpressionOptions;
}

interface CachedHandle {
  readonly revision: number;
  readonly expression: CompiledExpression;
}

/** Validates rules while they are saved and compiles each revision at most once. */
class RuleCatalog {
  private readonly definitions = new Map<string, RuleDefinition>();
  private readonly handles = new Map<string, CachedHandle>();

  /** Validates and stores a definition; returns author diagnostics on failure. */
  public define(definition: RuleDefinition): readonly SourceExpressionDiagnostic[] {
    const validation = validateExpression(definition.source, definition.options);
    if (!validation.ok) return validation.diagnostics;
    this.definitions.set(definition.id, definition);
    this.handles.delete(definition.id);
    return [];
  }

  /** Compiles on first use after each revision and evaluates one complete record. */
  public evaluate(
    id: string,
    record: Readonly<Record<string, ExpressionValue>>
  ): EvaluationResult {
    const definition = this.definitions.get(id);
    if (definition === undefined) throw new Error(`Unknown rule ${JSON.stringify(id)}.`);
    let handle = this.handles.get(id);
    if (handle === undefined || handle.revision !== definition.revision) {
      const compilation = compileExpression(definition.source, definition.options);
      if (!compilation.ok) {
        const reason = compilation.diagnostics[0]?.message ?? 'unknown error';
        throw new Error(`Stored rule ${JSON.stringify(id)} no longer compiles: ${reason}`);
      }
      handle = { revision: definition.revision, expression: compilation.expression };
      this.handles.set(id, handle);
    }
    return evaluateExpression(handle.expression, record);
  }
}

const catalog = new RuleCatalog();

// A rejected definition is never activated: the previous revision stays in place.
const rejected = catalog.define({
  id: 'order-eligibility',
  revision: 1,
  source: 'Country = "NL"',
  options: {
    schema: { Country: { type: 'string' } },
    expectedResult: 'boolean',
  },
});

console.log(rejected.map(diagnostic => diagnostic.code));
// [ 'BS_INVALID_CHARACTER' ]

const accepted = catalog.define({
  id: 'order-eligibility',
  revision: 1,
  source: 'Country IN ("NL", "BE") AND OrderTotal >= 1000',
  options: {
    schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
    expectedResult: 'boolean',
  },
});

console.log(accepted.length); // 0

const first = catalog.evaluate('order-eligibility', { Country: 'NL', OrderTotal: 1250 });
const second = catalog.evaluate('order-eligibility', { Country: 'BE', OrderTotal: 250 });

if (first.ok && second.ok) {
  console.log(first.value, second.value); // true false
}
```

### Why this pattern is valuable

- `validateExpression` and `compileExpression` already share one normalized pipeline, so the catalog cannot disagree with itself: what `define` accepted is exactly what `evaluate` compiles. The catalog just decides *when* each stage runs.
- Compilation is the expensive stage; evaluation is not. Compiling per revision instead of per request removes the lex → parse → analyze loop from the hot path.
- Authoring feedback happens at save time, where a human can act on the diagnostic's `message`, `location`, and `excerpt`, instead of surfacing as a runtime exception.
- The revision field gives you a cache key for free: bump it on any change and the next evaluation transparently recompiles.

### Caveats and performance considerations

- Definitions must satisfy the options contract: an ordinary object containing exactly `schema` and optionally `expectedResult`. A violation throws `BlendScriptApiError` (`BS_INVALID_OPTIONS` / `BS_INVALID_SCHEMA`) from `define` — that is a host bug, not author feedback.
- Options are re-snapshotted by every `validateExpression`/`compileExpression` call. Freeze stored definitions (or copy them) so later mutation of the `options` object cannot silently change behavior.
- The handle cache lives in one process and one loaded package instance. Handles cannot be serialized, moved between workers, or reused after a restart — lazy recompilation is the designed recovery path, formalized in the durable-documents pattern below.
- Every `evaluate` revalidates the complete record against the rule's schema, including fields the expression never references. Keep per-rule schemas as small as the rule needs; cost per call scales with schema size, not expression size.

---

## Field-Level Access Control with referencedFields

**Use this pattern when** rule authors are not trusted with every field — a partner portal that must never read `Margin`, a tenant whose rules may only touch their own columns. The analyzer already proves which fields a rule references; use that as the authorization signal instead of writing your own scanner over rule text.

### Complete example

```typescript
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type CompiledExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

/** Fields each role may reference, keyed by role name. */
const FIELD_POLICIES = new Map<string, ReadonlySet<string>>([
  ['partner', new Set(['Country', 'OrderTotal'])],
  ['analyst', new Set(['Country', 'OrderTotal', 'Margin', 'Segment'])],
]);

type GuardedCompilation =
  | Readonly<{ ok: true; expression: CompiledExpression; referencedFields: readonly string[] }>
  | Readonly<{ ok: false; messages: readonly string[] }>;

/** Validates first, enforces the role's field policy, then compiles. */
function compileForRole(
  role: string,
  source: string,
  options: ExpressionOptions
): GuardedCompilation {
  const policy = FIELD_POLICIES.get(role);
  if (policy === undefined) throw new Error(`Unknown role ${JSON.stringify(role)}.`);

  const validation = validateExpression(source, options);
  if (!validation.ok) {
    return { ok: false, messages: validation.diagnostics.map(diagnostic => diagnostic.message) };
  }

  const forbidden = validation.referencedFields.filter(field => !policy.has(field));
  if (forbidden.length > 0) {
    return {
      ok: false,
      messages: forbidden.map(
        field => `The ${role} role is not allowed to reference ${JSON.stringify(field)}.`
      ),
    };
  }

  const compilation = compileExpression(source, options);
  if (!compilation.ok) {
    return { ok: false, messages: compilation.diagnostics.map(diagnostic => diagnostic.message) };
  }
  return {
    ok: true,
    expression: compilation.expression,
    referencedFields: compilation.referencedFields,
  };
}

const options: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
    Margin: { type: 'number' },
    Segment: { type: 'string', nullable: true },
  },
  expectedResult: 'boolean',
};

const partnerAttempt = compileForRole('partner', 'Margin > 0.2 AND Country == "NL"', options);
console.log(partnerAttempt.ok); // false
if (!partnerAttempt.ok) console.log(partnerAttempt.messages);
// [ 'The partner role is not allowed to reference "Margin".' ]

const analystAttempt = compileForRole('analyst', 'Margin > 0.2 AND Country == "NL"', options);
console.log(analystAttempt.ok); // true
if (analystAttempt.ok) console.log(analystAttempt.referencedFields);
// [ 'Margin', 'Country' ]

if (analystAttempt.ok) {
  const evaluation = evaluateExpression(analystAttempt.expression, {
    Country: 'NL',
    OrderTotal: 1000,
    Margin: 0.35,
    Segment: null,
  });
  if (evaluation.ok) console.log(evaluation.value); // true
}
```

### Why this pattern is valuable

- `referencedFields` is reported in first-source-occurrence order, only after a rule passes validation — a free, precise allow-list check with no regex parsing of your own.
- Forbidden fields are rejected with specific messages naming the field and the role, which is far friendlier than a generic "validation failed".
- Rules that reference undeclared fields never reach the policy check: they fail first with `BS_UNKNOWN_FIELD`, so your policy layer only ever reasons about fields that actually exist in the schema.
- The check is static: `referencedFields` includes fields inside branches that might short-circuit at runtime, because a rule's reach should be judged from its source, not from one dataset.

### Caveats and performance considerations

- The policy is an authoring gate, not a runtime redaction mechanism. Store the compiled handle together with the role that passed the check, and never route a partner-authored handle through an analyst code path.
- If a partner rule must be unable to read `Margin` even at runtime, compile against a reduced per-role schema instead: the field then fails as unknown, and evaluation physically cannot read it. Combining both techniques is common.
- On validation failure there is no `referencedFields`; reject on diagnostics first, as the example does.
- Field names are compared by exact spelling; bracketed names like `[Order Total]` decode to the same key you declared in the schema, so `referencedFields` always contains schema keys.

Invalid host configuration throws rather than returning diagnostics; keep that channel separate from author feedback:

```typescript fragment
import { BlendScriptApiError } from 'blendsdk/blendscript';

try {
  const outcome = compileForRole('partner', source, options);
  console.log(outcome.ok);
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.error(`BlendScript host configuration error (${error.code}): ${error.message}`);
  } else {
    throw error;
  }
}
```

---

## One Formatter for Every Diagnostic

**Use this pattern when** diagnostics flow to a CLI, an editor panel, an API response, or telemetry and must be rendered consistently. Both diagnostic families are plain data, so a single narrow-on-`kind` formatter can serve every surface.

### Complete example

```typescript
import {
  compileExpression,
  evaluateExpression,
  type ExpressionDiagnostic,
} from 'blendsdk/blendscript';

/** Renders any BlendScript diagnostic as one stable, value-free block of context. */
function formatDiagnostic(diagnostic: ExpressionDiagnostic): string {
  if (diagnostic.kind === 'source') {
    const position = `${diagnostic.location.line}:${diagnostic.location.column}`;
    const excerpt = diagnostic.excerpt === undefined ? '' : `\n  ${diagnostic.excerpt}`;
    return `${diagnostic.code} (${position}): ${diagnostic.message}${excerpt}`;
  }
  const expected = diagnostic.nullable
    ? `${diagnostic.expectedType} or null`
    : diagnostic.expectedType;
  return (
    `${diagnostic.code}: field ${JSON.stringify(diagnostic.field)} ` +
    `expected ${expected}, received ${diagnostic.actualType} (${diagnostic.reason})`
  );
}

// Authoring failure: an unknown field, caught while the rule is edited.
const invalid = compileExpression('MissingField AND TRUE', { schema: {} });
if (!invalid.ok) {
  for (const diagnostic of invalid.diagnostics) {
    console.log(formatDiagnostic(diagnostic));
  }
}
// BS_UNKNOWN_FIELD (1:1): Field "MissingField" is not declared in the schema.
//   MissingField AND TRUE

// Record failure: complete-record preflight rejects a wrongly typed value.
const compiled = compileExpression('trim(Code) == "EU"', {
  schema: { Code: { type: 'string' } },
  expectedResult: 'boolean',
});
if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message);

const recordFailure = evaluateExpression(compiled.expression, { Code: 42 });
if (!recordFailure.ok) {
  console.log(formatDiagnostic(recordFailure.diagnostic));
}
// BS_RUNTIME_TYPE_MISMATCH: field "Code" expected string, received number (type-mismatch)

// Runtime source failure: the same formatter covers evaluation-time diagnostics.
const nullable = compileExpression('trim(Code)', {
  schema: { Code: { type: 'string', nullable: true } },
});
if (!nullable.ok) throw new Error(nullable.diagnostics[0]?.message);

const nullFailure = evaluateExpression(nullable.expression, { Code: null });
if (!nullFailure.ok) {
  console.log(formatDiagnostic(nullFailure.diagnostic));
}
// BS_NULL_NOT_ALLOWED (1:1): Built-in trim cannot use a null argument.
//   trim(Code)
```

The two families differ in exactly one dimension — what they describe — which is why one function suffices:

| Capability | `SourceExpressionDiagnostic` (`kind: 'source'`) | `RecordExpressionDiagnostic` (`kind: 'record'`) |
| --- | --- | --- |
| Carries | `span`, `location`, optional `excerpt` | `field`, `reason`, `expectedType`, `nullable`, `actualType` |
| Describes | A position in the rule source | A declared field of the evaluated record |
| Produced by | Lexer, parser, analyzer — and some runtime checks | Record snapshot validation before evaluation |
| Includes rejected data | Never — only rule source text | Never — only a runtime type classification |

### Why this pattern is valuable

- Narrowing on `kind` lets TypeScript prove which members exist: after the `if`, only the source members are visible; in the else branch, only `field`, `reason`, `expectedType`, `nullable`, and `actualType`. A formatter written this way cannot regress into accessing the wrong member.
- Record diagnostics are deliberately value-free, so the formatted output can be logged, stored, or sent to telemetry without redaction logic — a hard requirement in regulated environments.
- Because both families are frozen plain objects, the same formatter works in a Node CLI, a browser editor, and a test assertion.

### Caveats and performance considerations

- Branch on `kind` first, never on the code. Codes overlap between families: `BS_STRING_VALUE_LIMIT_EXCEEDED` can be a record diagnostic (an oversized field) or a source diagnostic (a built-in produced a string above the limit).
- `kind: 'source'` does not mean "authoring time": `BS_NULL_NOT_ALLOWED`, `BS_EVALUATION_STEP_LIMIT_EXCEEDED`, and derived-string limits are produced during evaluation but still carry the original rule's `span` and `location`.
- The `excerpt` is bounded to 120 UTF-16 code units and is context, not an exact slice: it either begins at the span or ends at the source end. Use `span` (zero-based, half-open) and `location` (one-based line and UTF-16 column) for precise positions.
- `severity` is always `'error'` in v1; do not build warning pipelines against it yet.

---

## Taming Mixed Scalar Data with Explicit Conversions

**Use this pattern when** rule inputs arrive from spreadsheets, CSV files, or forms where a column is sometimes text (`"001"`, `"ABC-1"`) and sometimes a number (`1`). The `scalar` field type preserves either representation exactly and forces the rule to convert deliberately — there is no implicit coercion anywhere in the language.

### Complete example

```typescript
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type CompiledExpression,
  type ExpressionValue,
} from 'blendsdk/blendscript';

const schema = { Item: { type: 'scalar' } } as const;

// Authoring-time rejection: scalar fields never coerce implicitly.
const rejected = validateExpression('Item > 1', { schema });
if (!rejected.ok) {
  console.log(rejected.diagnostics[0]?.message);
}
// Ordering comparisons require numeric operands. Use text(...) or tryNumber(...) to convert scalar values explicitly.

// Guarded numeric conversion returns false for non-numeric text.
const numeric = compileExpression('tryNumber(Item) != NULL AND tryNumber(Item) > 1', { schema });
if (!numeric.ok) throw new Error(numeric.diagnostics[0]?.message);

// Exact text conversion preserves identifiers such as "001".
const textual = compileExpression('text(Item) == "001"', { schema });
if (!textual.ok) throw new Error(textual.diagnostics[0]?.message);

function run(expression: CompiledExpression, item: ExpressionValue): ExpressionValue {
  const result = evaluateExpression(expression, { Item: item });
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.value;
}

console.log(run(numeric.expression, '2')); // true
console.log(run(numeric.expression, '1')); // false
console.log(run(numeric.expression, 'ABC-1')); // false
console.log(run(textual.expression, '001')); // true
console.log(run(textual.expression, 1)); // false
```

The naive forms an author will try first are all rejected at validation time — with a conversion hint in the message:

```typescript fragment
// Every one of these fails with BS_TYPE_MISMATCH:
//   'Item == 1'            equality between scalar and number
//   'Item > 1'             ordering requires numbers
//   'contains(Item, "1")'  built-ins require concrete types
```

### Why this pattern is valuable

- The guarded numeric form (`tryNumber(Item) != NULL AND tryNumber(Item) > 1`) turns invalid text into a clean `false` — a normal business outcome — instead of failing the evaluation. Without the guard, `tryNumber(Item) > 1` on `"ABC-1"` aborts with `BS_NULL_NOT_ALLOWED`, which is usually not what a filter wants.
- `tryNumber` uses a locale-independent decimal grammar and returns a finite JavaScript number or `null` for everything else; `text(Item)` preserves the exact original string, so leading zeros and case survive.
- `text(Item) == "001"` and `tryNumber(Item) == 1` give you both interpretations of the same column — numeric semantics and identity semantics — from one field type, chosen per rule.

### Caveats and performance considerations

- Every conversion is charged against the 10,000-step evaluation budget: `tryNumber` charges the input length, `text` charges the produced string. The guarded comparison converts twice whenever the first check passes — see the evaluation-budget pattern below before stacking conversions.
- `tryNumber` accepts only the complete decimal grammar (optional sign, digits with optional fraction, optional exponent). It returns `null` for partial matches, surrounding whitespace, `0x` prefixes, `NaN`, `Infinity`, and `1e309`.
- Nullability differs by design: `tryNumber(null)` returns `null`, but `text(null)` fails with `BS_NULL_NOT_ALLOWED`. Never use `text` as a null-safe formatter.
- If a column is genuinely numeric in every row, declare it `number` and let record preflight enforce finiteness — conversions are for columns that are truly mixed.

---

## Batch Evaluation with Failure Partitioning

**Use this pattern when** one compiled rule must score many records — nightly eligibility runs, backfills, CSV imports — and a handful of malformed rows must not abort the batch. Compile once, evaluate every row, and treat failures as data.

### Complete example

```typescript
import {
  compileExpression,
  evaluateExpression,
  type CompiledExpression,
  type ExpressionDiagnostic,
} from 'blendsdk/blendscript';

type OrderRow = { readonly Country: string; readonly OrderTotal: number };

type RejectedRow = Readonly<{ row: OrderRow; diagnostic: ExpressionDiagnostic }>;

type BatchOutcome = Readonly<{
  matched: readonly OrderRow[];
  unmatched: readonly OrderRow[];
  rejected: readonly RejectedRow[];
}>;

/** Partitions rows into matches, non-matches, and rows that could not complete. */
function partitionOrders(
  expression: CompiledExpression,
  rows: readonly OrderRow[]
): BatchOutcome {
  const matched: OrderRow[] = [];
  const unmatched: OrderRow[] = [];
  const rejected: RejectedRow[] = [];

  for (const row of rows) {
    const result = evaluateExpression(expression, row);
    if (!result.ok) {
      rejected.push(Object.freeze({ row, diagnostic: result.diagnostic }));
      continue;
    }
    if (result.value === true) matched.push(row);
    else unmatched.push(row);
  }

  return Object.freeze({
    matched: Object.freeze(matched),
    unmatched: Object.freeze(unmatched),
    rejected: Object.freeze(rejected),
  });
}

const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const outcome = partitionOrders(compilation.expression, [
  { Country: 'NL', OrderTotal: 1250 },
  { Country: 'BE', OrderTotal: 999 },
  { Country: 'NL', OrderTotal: Number.NaN },
]);

console.log(outcome.matched.length, outcome.unmatched.length, outcome.rejected.length);
// 1 1 1

for (const { diagnostic } of outcome.rejected) {
  console.log(diagnostic.kind, diagnostic.code);
}
// record BS_RUNTIME_TYPE_MISMATCH
```

### Why this pattern is valuable

- Compile-once/evaluate-many is the library's intended workflow: the handle carries the source, AST, schema snapshot, and result type, so the loop contains zero parsing work.
- Every failure is representable: record-shape problems arrive as `kind: 'record'` diagnostics, and rule-completion problems (null where a concrete value was required, resource limits) arrive as `kind: 'source'` diagnostics. Both have `code`, so a single `rejected` list captures everything, and callers can refine the classification later.
- The output is fully frozen, so the partition can be handed to reporting code without defensive copying — and rejected rows still carry their original record for retry or quarantine.

### Caveats and performance considerations

- Record preflight runs before the expression for every row and checks every declared field, including unreferenced ones. A row missing a declared field fails with `BS_MISSING_FIELD`; a non-finite number fails with `BS_RUNTIME_TYPE_MISMATCH` (`reason: 'non-finite-number'`) even if the expression would not have read it.
- Records must be caller-materialized ordinary objects. Class instances, arrays, `Date` values, and prototype-carrying objects throw `BlendScriptApiError` (`BS_INVALID_ARGUMENT`); map ORM entities to plain objects before the loop.
- Nothing is cached between rows: each call re-snapshots the record, and short-circuiting is per evaluation. Cost per row is `O(schema size + expression steps)` — keep the rule's schema focused.
- The `result.value === true` partition only makes sense when the rule was compiled with `expectedResult: 'boolean'`, as above.
- `Number.NaN` in the example demonstrates a subtle point: TypeScript happily types it as `number`, but BlendScript rejects it at runtime. Runtime preflight, not the type system, is the guardrail for externally sourced data.

---

## Durable Rule Documents and Rehydration

**Use this pattern when** rules must survive process restarts, deployments, and upgrades. Compiled handles are opaque, branded, `WeakMap`-backed memory values owned by one loaded package instance — they are deliberately not serializable. The durable artifact is the *document*: source plus schema plus expected result.

### Complete example

```typescript
import {
  compileExpression,
  validateExpression,
  type CompilationResult,
  type ExpressionOptions,
  type ExpressionSchema,
  type ExpressionValueType,
} from 'blendsdk/blendscript';

/** The complete, JSON-serializable representation of one durable rule. */
interface StoredRuleDocument {
  readonly id: string;
  readonly revision: number;
  readonly source: string;
  readonly schema: ExpressionSchema;
  readonly expectedResult?: ExpressionValueType;
}

/** Rebuilds a fresh options object, omitting `expectedResult` when it is absent. */
function optionsFor(document: StoredRuleDocument): ExpressionOptions {
  if (document.expectedResult === undefined) {
    return { schema: document.schema };
  }
  return { schema: document.schema, expectedResult: document.expectedResult };
}

/** Recompiles one stored document into a handle owned by this process. */
function hydrate(document: StoredRuleDocument): CompilationResult {
  return compileExpression(document.source, optionsFor(document));
}

const document: StoredRuleDocument = {
  id: 'eu-orders',
  revision: 7,
  source: 'Country IN ("NL", "BE", "DE") AND OrderTotal >= 1000',
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
};

// Write path: validate before persisting the document.
const authoring = validateExpression(document.source, optionsFor(document));
console.log(authoring.ok); // true

// Read path: storage returns the document; hydrate recompiles it for this process.
const hydrated = hydrate(document);
console.log(hydrated.ok); // true

// Drift path: the schema evolved and the stored rule no longer binds.
const legacy: StoredRuleDocument = {
  id: 'legacy-shipping',
  revision: 3,
  source: 'ShippingZone == "EU"',
  schema: { Country: { type: 'string' } },
  expectedResult: 'boolean',
};

const report = hydrate(legacy);
if (!report.ok) {
  for (const diagnostic of report.diagnostics) {
    console.log(diagnostic.code, diagnostic.message);
  }
}
// BS_UNKNOWN_FIELD Field "ShippingZone" is not declared in the schema.
```

Which artifacts belong on disk, and which never do:

| Artifact | Durable? | Notes |
| --- | --- | --- |
| Rule source | ✅ | The canonical, reviewable, diffable rule text |
| Schema + `expectedResult` | ✅ | Store inline or as a pinned version reference; without it a rule is not reproducible |
| `CompiledExpression` handle | ❌ | A branded value owned by one loaded package instance; passing anything else to `evaluateExpression` throws `BS_INVALID_COMPILED_EXPRESSION` |
| Diagnostics | Optional | Plain frozen objects; store as text if you need an audit trail |

### Why this pattern is valuable

- It turns upgrades into a report instead of a surprise: rehydrate every document at startup or in CI, quarantine failures with their diagnostics, and serve only rules that still bind to the current schema.
- The document is plain JSON — no classes, no handles — so any storage layer can persist it and any process can rebuild it, which is exactly how rules travel across queues, workers, and environments.
- Because hydration re-runs the full lex → parse → analyze pipeline, a document that was valid when saved but references a removed field is caught *before* it evaluates anything.

### Caveats and performance considerations

- Key presence matters for options: a present-but-`undefined` `expectedResult` is invalid (`BS_INVALID_OPTIONS`), unlike an absent key. Always build options conditionally, as `optionsFor` does.
- Hydration compiles, so cache handles per process exactly as the rule-catalog pattern does; do not hydrate inside request loops.
- Treat schema changes as migrations: bump revisions, rehydrate all documents in staging, and fix or quarantine failures before deploying.
- Never persist handles and never try to reconstruct one; the compiler brand is intentionally not exported, so nothing you build by hand can pass the identity check.
- The document must be treated like code: it is reviewed, versioned, and diffed. BlendScript itself cannot touch anything beyond the declared schema, which bounds the blast radius of any rule.

---

## Staying Inside the Evaluation Budget

**Use this pattern when** rules run under strict capacity expectations and some inputs are large. Evaluation is bounded by a deterministic 10,000-step budget with short-circuiting: unselected branches charge nothing, so operand order is both a performance decision and a correctness-of-failure decision.

```typescript fragment
// Before: the expensive comparison is charged for every row.
const before = 'equalsIgnoreCase(Name, Reference) AND Enabled == TRUE';

// After: the cheap Boolean runs first, and short-circuiting charges the
// comparison only when `Enabled` is true. Both forms are logically identical.
const after = 'Enabled == TRUE AND equalsIgnoreCase(Name, Reference)';
```

### Complete example

```typescript
import {
  compileExpression,
  evaluateExpression,
  type EvaluationResult,
} from 'blendsdk/blendscript';

const compilation = compileExpression('Enabled == TRUE AND equalsIgnoreCase(Name, Reference)', {
  schema: {
    Enabled: { type: 'boolean' },
    Name: { type: 'string' },
    Reference: { type: 'string' },
  },
  expectedResult: 'boolean',
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

type Classification = 'match' | 'no-match' | 'row-unusable' | 'rule-exhausted';

/** Classifies an evaluation without conflating "false" with "could not finish". */
function classify(result: EvaluationResult): Classification {
  if (result.ok) return result.value === true ? 'match' : 'no-match';
  if (result.diagnostic.code === 'BS_EVALUATION_STEP_LIMIT_EXCEEDED') return 'rule-exhausted';
  return 'row-unusable';
}

console.log(
  classify(
    evaluateExpression(compilation.expression, {
      Enabled: true,
      Name: 'BlendScript',
      Reference: 'BLENDSCRIPT',
    })
  )
); // 'match'

console.log(
  classify(
    evaluateExpression(compilation.expression, {
      Enabled: false,
      Name: 'a'.repeat(4_096),
      Reference: 'a'.repeat(4_096),
    })
  )
); // 'no-match' — the disabled row never charges the string comparison

console.log(
  classify(
    evaluateExpression(compilation.expression, {
      Enabled: true,
      Name: 'a'.repeat(4_096),
      Reference: 'a'.repeat(4_096),
    })
  )
); // 'rule-exhausted' — equalsIgnoreCase pre-charges 12,288 steps
```

The fixed v1 limits that shape rule design:

| Limit | Value | Enforced at |
| --- | --- | --- |
| Source length | 16,384 UTF-16 code units | Before lexing |
| Tokens | 4,096 | During lexing |
| String length (literal and runtime) | 4,096 UTF-16 code units | Lexing, record preflight, and derived strings |
| Field name | 256 UTF-16 code units | Lexing and schema validation |
| Schema fields | 1,024 | Options validation (throws) |
| Nesting depth | 64 | Parsing |
| Evaluation steps | 10,000 | Evaluation |
| Source excerpt | 120 UTF-16 code units | Diagnostic construction |
| Semantic diagnostics per call | 20 | Analysis |

### Why this pattern is valuable

- The budget is deterministic, not wall-clock: the same inputs always produce the same step count, so worst-case cost is testable and reproducible across machines.
- Short-circuiting is free capacity: `Enabled == TRUE AND equalsIgnoreCase(Name, Reference)` charges the comparison only for enabled rows, which changes both the cost *and* the set of failures a batch can see.
- Classifying `BS_EVALUATION_STEP_LIMIT_EXCEEDED` distinctly from `'no-match'` lets callers decide policy — log a metric, quarantine the row, split the rule — instead of silently mislabeling exhausted rows as non-matches.

### Caveats and performance considerations

- Calibration data from the package's own specification tests: `NOT contains(trim(A), trim(B))` with 4,096- and 901-character inputs consumes exactly 10,000 steps and passes; wrapping it in one additional `NOT` crosses the limit. And `equalsIgnoreCase` over two 4,096-character strings pre-charges 3 × 4,096 = 12,288 steps, so it can never succeed at maximum lengths. There is very little slack — operand ordering is required design, not micro-optimization.
- String work dominates: built-ins pre-charge before executing native string operations, and conversions (`tryNumber`, `text`) charge input or output length. A guarded scalar conversion converts twice when its first check passes.
- The budget is per evaluation, not per batch: a 10,000-row batch gets 10,000 independent budgets, but each row must still fit alone.
- Do not retry an exhausted evaluation on the same record — the outcome is deterministic. Tighten the rule (reorder operands, drop redundant conversions), split it, or normalize data upstream so the rule sees fields that need no conversion.
- Limits are fixed in v1 and not configurable through options; design for them rather than around them.

---

## Deriving Record Types from the Schema

**Use this pattern when** the same schema should govern both the rule engine and the TypeScript call sites, so record-shape mistakes fail at build time. Keep the schema `as const`, satisfy `ExpressionSchema`, and derive the exact record type with conditional types.

### Complete example

```typescript
import {
  compileExpression,
  evaluateExpression,
  type ExpressionSchema,
  type ExpressionValue,
} from 'blendsdk/blendscript';

/** True when a field descriptor declares nullable: true. */
type NullableField<F> = F extends { readonly nullable: true } ? true : false;

/** The concrete non-null value type declared by one field descriptor. */
type ConcreteValue<F> = F extends { readonly type: 'scalar' }
  ? string | number
  : F extends { readonly type: 'boolean' }
    ? boolean
    : F extends { readonly type: 'number' }
      ? number
      : string;

type ValueOfField<F> = NullableField<F> extends true ? ConcreteValue<F> | null : ConcreteValue<F>;

/** The exact record shape a schema requires, assignable to evaluation input. */
type RecordFor<S extends ExpressionSchema> = Readonly<
  { [K in keyof S]: ValueOfField<S[K]> } & Record<string, ExpressionValue>
>;

const orderSchema = {
  Country: { type: 'string' },
  OrderTotal: { type: 'number' },
  Segment: { type: 'string', nullable: true },
} as const satisfies ExpressionSchema;

type OrderRecord = RecordFor<typeof orderSchema>;

const rule = compileExpression('Segment == "enterprise" AND OrderTotal >= 1000', {
  schema: orderSchema,
  expectedResult: 'boolean',
});
if (!rule.ok) throw new Error(rule.diagnostics[0]?.message);

const record: OrderRecord = {
  Country: 'NL',
  OrderTotal: 1250,
  Segment: 'enterprise',
};

const result = evaluateExpression(rule.expression, record);
if (!result.ok) throw new Error(result.diagnostic.message);

console.log(result.value); // true

// The derived type rejects shape errors before any rule runs.
// @ts-expect-error OrderTotal is required.
const missing = { Country: 'NL', Segment: null } satisfies OrderRecord;
// @ts-expect-error Segment must be a string or null, never a number.
const wrong = { Country: 'NL', OrderTotal: 10, Segment: 7 } satisfies OrderRecord;

void missing;
void wrong;
```

A misspelled descriptor never satisfies the schema type — the same schema constant that drives the rule engine also gates its own declaration:

```typescript fragment
// Compile-time: `as const satisfies ExpressionSchema` rejects a misspelled field type.
const broken = { Country: { type: 'sting' } } as const satisfies ExpressionSchema;
```

### Why this pattern is valuable

- One schema constant drives three things at once: authoring-time validation, runtime record preflight, and the host's TypeScript record type. They cannot drift apart silently.
- Nullability is encoded (`nullable: true` produces `string | null`, not `string`), so callers are forced to decide what a null means before handing data to the evaluator.
- `scalar` maps to `string | number`, matching exactly the two runtime representations the library accepts for mixed columns.
- The negative examples show the payoff: a missing field or a wrongly typed field is a red squiggle at the call site instead of a `BS_RUNTIME_TYPE_MISMATCH` in production logs.

### Caveats and performance considerations

- Types are erased. BlendScript's runtime preflight remains the ground truth, especially for data that never passed through TypeScript (JSON, databases, queues). TypeScript's `number` includes `NaN` and `±Infinity`, which always fail runtime validation (`reason: 'non-finite-number'`).
- Keep schemas `as const` and `satisfies ExpressionSchema`; widening a descriptor to the general `ExpressionFieldType` degrades `RecordFor` to a loose approximation.
- The mapping covers exactly the v1 surface: four field types and `nullable`. It cannot express the 4,096-code-unit string cap, the 1,024-field schema cap, or the `expectedResult` contract — those remain runtime concerns.
- Changing the schema changes `RecordFor` and breaks record construction at build time. That is the point: record updates are forced alongside rule updates, while runtime diagnostics cover everything the type system never saw.
- The index signature in `RecordFor` mirrors runtime behavior: undeclared extra members are allowed by the type and ignored by the evaluator without ever being read.

---

## Integration Notes

- The durable document (id, revision, source, schema, expectedResult) is the interchange format: plain JSON with no handles, no functions, no classes. Any configuration store, database, or queue can persist it, and any process can rehydrate it.
- The published `blendsdk` umbrella republishes the direct `blendsdk/blendscript` build byte-for-byte as `blendsdk/blendscript` and pins the version, so both entry points expose identical behavior and the same four runtime symbols: `validateExpression`, `compileExpression`, `evaluateExpression`, and `BlendScriptApiError`.
- Keep compiled handles inside the instance that created them. Across workers, RPC boundaries, or caching tiers, pass the document and rehydrate on the other side.
- Results, diagnostics, and records are frozen plain objects, and record diagnostics are value-free by construction, so they can be logged, serialized, or forwarded to telemetry without redaction logic.
- The implementation has zero runtime dependencies and no dynamic-code path; it runs unchanged in environments where `eval` and `Function` are unavailable.

---

## Related Documents

- Core Concepts for the language model these patterns build on.
- Best Practices for the day-to-day conventions behind these patterns.
- Common Scenarios for compact, task-oriented recipes.
- API Reference for every exported type, diagnostic code, and limit.
- Examples Library for additional runnable programs.

---

# blendscript Common Scenarios

This FAQ-style guide answers the questions that come up most often when integrating `blendsdk/blendscript`. Each scenario gives a short explanation and a complete, runnable TypeScript example that imports only from the package root. Scenarios are ordered from basic authoring workflows to advanced edge cases.

| #  | Scenario                                                        |
| -- | --------------------------------------------------------------- |
| 1  | How do I validate a rule while it is being authored?            |
| 2  | How do I compile a rule once and evaluate it against many records? |
| 3  | How do I get precise locations and excerpts for authoring errors? |
| 4  | How do I enforce the exact result type of a rule?               |
| 5  | How do I compare values without relying on implicit coercion?   |
| 6  | How do I test a field against a fixed set of literal values?    |
| 7  | How do I compare and normalize text values?                     |
| 8  | How do I handle a nullable field?                               |
| 9  | How do I handle a field that may hold text or a number?         |
| 10 | How do I convert numeric text safely?                           |
| 11 | How do I reference field names with spaces, symbols, or keywords? |
| 12 | How do I reference a field with the same name as a built-in?    |
| 13 | How do I make sure a record is complete before evaluation?      |
| 14 | How do I respond to evaluation failures without exceptions?     |
| 15 | How do I make sure a rule cannot reach the host environment?    |
| 16 | How do I keep rules terminating and avoid wasted work?          |

---

## How do I validate a rule while it is being authored?

**Solution**: Call `validateExpression` every time the rule text or schema changes. It checks syntax, schema bindings, and types without retaining any executable state, and returns a discriminated result that carries the inferred `resultType` and the `referencedFields` when the rule is valid. Authored-text problems are reported as diagnostics — they never throw.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const source = 'Country == "NL" AND OrderTotal >= 1000';
const options = {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
} as const;

const result = validateExpression(source, options);

if (result.ok) {
  console.log(result.resultType); // { type: 'boolean', nullable: false }
  console.log(result.referencedFields); // ['Country', 'OrderTotal']
} else {
  for (const diagnostic of result.diagnostics) {
    console.log(diagnostic.code, diagnostic.message);
  }
}
```

---

## How do I compile a rule once and evaluate it against many records?

**Solution**: `compileExpression` runs the same pipeline as validation and, on success, returns an opaque `CompiledExpression` handle. Reuse that handle for every record — each evaluation is independent and retains no record state. Handles are in-memory values owned by the loaded package instance, so persist the source and schema, then recompile after loading or upgrading.

```typescript
import { compileExpression, evaluateExpression, type ExpressionValue } from 'blendsdk/blendscript';

const options = {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
} as const;

const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', options);
if (!compilation.ok) {
  throw new Error(compilation.diagnostics[0]?.message ?? 'Rule did not compile.');
}

const expression = compilation.expression;
const records: ReadonlyArray<Readonly<Record<string, ExpressionValue>>> = [
  { Country: 'NL', OrderTotal: 1250 },
  { Country: 'BE', OrderTotal: 900 },
  { Country: 'NL', OrderTotal: 100 },
];

for (const record of records) {
  const result = evaluateExpression(expression, record);
  console.log(result.ok ? result.value : result.diagnostic.message);
}
// true
// false
// false
```

---

## How do I get precise locations and excerpts for authoring errors?

**Solution**: Every source diagnostic carries a stable `code`, an actionable `message`, a zero-based half-open UTF-16 `span`, one-based `location` coordinates, and a bounded `excerpt`. Diagnostics are ordered by span and returned in batches of at most 20, so an editor can highlight the exact range and list the rest in order.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const source = 'Country == "NL" AND OrdrTotal >= 1000';
const result = validateExpression(source, {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
});

if (!result.ok) {
  for (const diagnostic of result.diagnostics) {
    const { line, column, endLine, endColumn } = diagnostic.location;
    console.log(`${diagnostic.code} at ${line}:${column}-${endLine}:${endColumn}`);
    console.log(diagnostic.message);
    console.log(`excerpt: ${diagnostic.excerpt ?? ''}`);
  }
}
// BS_UNKNOWN_FIELD at 1:21-1:30
// Field "OrdrTotal" is not declared in the schema.
// excerpt: Country == "NL" AND OrdrTotal >= 1000
```

---

## How do I enforce the exact result type of a rule?

**Solution**: Set `expectedResult` when a rule must produce exactly `string`, `number`, `boolean`, or `null`. The analyzer rejects both mismatched types and nullable results that cannot guarantee a non-null value, with the stable code `BS_EXPECTED_RESULT_TYPE_MISMATCH`. When you omit `expectedResult`, any inferred type is accepted.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const schema = { Status: { type: 'string' }, Item: { type: 'scalar' } } as const;

// A Boolean business rule.
console.log(validateExpression('Status == "active"', { schema, expectedResult: 'boolean' }));
// { ok: true, resultType: { type: 'boolean', nullable: false }, referencedFields: ['Status'] }

// A value-producing rule.
console.log(validateExpression('trim(Status)', { schema, expectedResult: 'string' }));
// { ok: true, resultType: { type: 'string', nullable: false }, referencedFields: ['Status'] }

// Mismatch: the rule produces text, not a Boolean.
const textForBoolean = validateExpression('trim(Status)', { schema, expectedResult: 'boolean' });
if (!textForBoolean.ok) {
  console.log(textForBoolean.diagnostics[0]?.code); // BS_EXPECTED_RESULT_TYPE_MISMATCH
}

// Nullable results never satisfy a non-null expectation.
const nullableNumber = validateExpression('tryNumber(Item)', { schema, expectedResult: 'number' });
if (!nullableNumber.ok) {
  console.log(nullableNumber.diagnostics[0]?.code); // BS_EXPECTED_RESULT_TYPE_MISMATCH
}

// Make the result non-null before demanding a concrete type.
console.log(validateExpression('tryNumber(Item) != NULL', { schema })); // { ok: true, Boolean }
console.log(validateExpression('NULL', { schema: {}, expectedResult: 'null' })); // { ok: true }
```

---

## How do I compare values without relying on implicit coercion?

**Solution**: BlendScript never converts values, so equality is strict, ordering comparisons are numeric-only, and logical operators require Booleans. Author the rule against matching types, or convert explicitly with `text(...)` / `tryNumber(...)` first. `!`, `&&`, and `||` are accepted synonyms for `NOT`, `AND`, and `OR`, and `AND` binds tighter than `OR`.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const schema = {
  Text: { type: 'string' },
  Count: { type: 'number' },
  Enabled: { type: 'boolean' },
} as const;

for (const source of ['Text == Count', 'Text < "z"', 'Count AND Enabled']) {
  const result = validateExpression(source, { schema });
  if (!result.ok) {
    console.log(source, '->', result.diagnostics[0]?.code); // BS_TYPE_MISMATCH
  }
}

// Corrected: compare values of matching types and use Boolean operands for logic.
const fixed = validateExpression('Count == 10 AND Enabled', { schema });
console.log(fixed);
// { ok: true, resultType: { type: 'boolean', nullable: false }, referencedFields: ['Count', 'Enabled'] }
```

---

## How do I test a field against a fixed set of literal values?

**Solution**: Use `IN` with a non-empty, parenthesized list of primitive literals. Evaluation is strict and duplicate literals are harmless; include `NULL` in the list only when the schema field is nullable.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { Country: { type: 'string' } } as const;

const compiled = compileExpression('Country IN ("GB", "NL", "BE")', {
  schema,
  expectedResult: 'boolean',
});
if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message);

console.log(evaluateExpression(compiled.expression, { Country: 'NL' })); // { ok: true, value: true }
console.log(evaluateExpression(compiled.expression, { Country: 'XX' })); // { ok: true, value: false }
```

```typescript fragment
// Invalid IN forms and their diagnostics:
Country IN ()               // BS_UNEXPECTED_TOKEN — the list cannot be empty
Country IN ("NL",)          // BS_UNEXPECTED_TOKEN — no trailing comma
Country IN (OtherField)     // BS_UNEXPECTED_TOKEN — members must be primitive literals
Country IN (NULL)           // BS_TYPE_MISMATCH — NULL needs a nullable field
```

---

## How do I compare and normalize text values?

**Solution**: Use the fixed string built-ins for trimming, case conversion, substring checks, and comparison. String comparisons are case-sensitive by default; `equalsIgnoreCase` case-folds both sides with non-locale `toLowerCase()` semantics, and `length` counts Unicode code points, not UTF-16 units. All string built-ins reject `null` at evaluation time except `isEmpty` and `isBlank`.

| Built-in          | Language signature                                 | Returns                                          |
| ----------------- | -------------------------------------------------- | ------------------------------------------------ |
| `trim`            | `trim(text)`                                       | Text without leading/trailing whitespace         |
| `lower` / `upper` | `lower(text)` / `upper(text)`                      | Non-locale lowercase / uppercase text            |
| `contains`        | `contains(text, search)`                           | Whether `search` occurs anywhere in `text`       |
| `startsWith`      | `startsWith(text, search)`                         | Whether `text` starts with `search`              |
| `endsWith`        | `endsWith(text, search)`                           | Whether `text` ends with `search`                |
| `equalsIgnoreCase`| `equalsIgnoreCase(left, right)`                    | Case-insensitive equality                        |
| `isEmpty`         | `isEmpty(text)`                                    | `true` for `null` or `""`                        |
| `isBlank`         | `isBlank(text)`                                    | `true` for `null` or whitespace-only text        |
| `length`          | `length(text)`                                     | Number of Unicode code points (`"😀a"` is `2`)   |

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { Name: { type: 'string' } } as const;

const compiled = compileExpression(
  'equalsIgnoreCase(trim(Name), "blendscript") AND length(Name) > 0',
  { schema }
);
if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message);

console.log(evaluateExpression(compiled.expression, { Name: '  BlendScript  ' })); // { ok: true, value: true }
console.log(evaluateExpression(compiled.expression, { Name: '   ' })); // { ok: true, value: false }

const codePoints = compileExpression('length(Name)', { schema });
if (!codePoints.ok) throw new Error(codePoints.diagnostics[0]?.message);
console.log(evaluateExpression(codePoints.expression, { Name: '😀a' })); // { ok: true, value: 2 }
```

---

## How do I handle a nullable field?

**Solution**: Declare the field with `nullable: true`, then guard with `field == NULL` (or use the null-aware built-ins `isEmpty`, `isBlank`, and `tryNumber`). Because `AND`/`OR` short-circuit, a left-hand null check protects a right-hand operation that would otherwise fail with `BS_NULL_NOT_ALLOWED` — exactly the pattern rules like "no coupon, or a summer coupon" need. Comparing a non-nullable field to `NULL` is a static `BS_TYPE_MISMATCH`.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { CouponCode: { type: 'string', nullable: true } } as const;

const guarded = compileExpression('CouponCode == NULL OR startsWith(CouponCode, "SUMMER-")', {
  schema,
});
if (!guarded.ok) throw new Error(guarded.diagnostics[0]?.message);

console.log(evaluateExpression(guarded.expression, { CouponCode: null })); // { ok: true, value: true }
console.log(evaluateExpression(guarded.expression, { CouponCode: 'SUMMER-2024' })); // { ok: true, value: true }
console.log(evaluateExpression(guarded.expression, { CouponCode: 'WINTER-2024' })); // { ok: true, value: false }

// Unguarded use of a null value fails at evaluation time with an exact source location.
const unguarded = compileExpression('trim(CouponCode) == "X"', { schema });
if (!unguarded.ok) throw new Error(unguarded.diagnostics[0]?.message);

const failure = evaluateExpression(unguarded.expression, { CouponCode: null });
if (!failure.ok && failure.diagnostic.kind === 'source') {
  console.log(failure.diagnostic.code); // BS_NULL_NOT_ALLOWED
}
```

---

## How do I handle a field that may hold text or a number?

**Solution**: Declare the field with `type: 'scalar'`. A scalar field preserves a string or a finite number exactly as stored and refuses direct concrete-type operations — the analyzer rejects them with a hint to convert explicitly. Use `tryNumber(...)` for numeric intent and `text(...)` for textual intent.

```typescript
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';

const schema = { Item: { type: 'scalar' } } as const;

// Scalar fields never coerce: concrete operators need explicit conversion.
const rejected = validateExpression('Item == 1', { schema });
if (!rejected.ok) {
  console.log(rejected.diagnostics[0]?.code); // BS_TYPE_MISMATCH
  console.log(rejected.diagnostics[0]?.message);
  // Equality operands must have compatible types. Use text(...) or tryNumber(...) to convert scalar values explicitly.
}

const numeric = compileExpression('tryNumber(Item) != NULL AND tryNumber(Item) > 1', { schema });
const textual = compileExpression('text(Item) == "001"', { schema });
if (!numeric.ok || !textual.ok) throw new Error('Expected both conversions to compile.');

console.log(evaluateExpression(numeric.expression, { Item: '2' })); // { ok: true, value: true }
console.log(evaluateExpression(numeric.expression, { Item: 'ABC-1' })); // { ok: true, value: false }
console.log(evaluateExpression(textual.expression, { Item: 1 })); // { ok: true, value: false }
console.log(evaluateExpression(textual.expression, { Item: '001' })); // { ok: true, value: true }
```

---

## How do I convert numeric text safely?

**Solution**: `tryNumber(...)` converts a number unchanged, converts a string only when the complete value matches BlendScript's locale-independent decimal grammar and produces a finite number, absorbs `null`, and returns `null` for anything else. Pair it with `!= NULL` before comparing, since the result is nullable.

| Field value (or literal)                   | `tryNumber(...)` returns |
| ------------------------------------------ | ------------------------ |
| `1` (number)                               | `1`                      |
| `'1'`, `'001'`, `'-12.5'`                  | Parsed finite number     |
| `'.5'`, `'5.'`, `'+2'`, `'1e3'`            | Parsed finite number     |
| `''`, `' '`, `' 1'`, `'1 '`                | `null`                   |
| `'1abc'`, `'0x10'`, `'NaN'`, `'Infinity'`  | `null`                   |
| `'1e309'`                                  | `null` (non-finite)      |
| `null`                                     | `null`                   |

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { AmountText: { type: 'string' } } as const;

const compiled = compileExpression(
  'tryNumber(AmountText) != NULL AND tryNumber(AmountText) > 100',
  { schema }
);
if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message);

for (const AmountText of ['150', '00120', ' 150', 'abc', '1e309']) {
  console.log(AmountText, evaluateExpression(compiled.expression, { AmountText }));
}
// '150'   → { ok: true, value: true }
// '00120' → { ok: true, value: true }
// ' 150'  → { ok: true, value: false }
// 'abc'   → { ok: true, value: false }
// '1e309' → { ok: true, value: false }
```

---

## How do I reference field names with spaces, symbols, or keywords?

**Solution**: Wrap the exact field name in brackets whenever it is not a plain identifier — spaces, punctuation, and keywords all work inside the brackets. A literal `]` inside a name is written `]]`. Field names are matched exactly (case-sensitively) against the schema and must be 1–256 UTF-16 code units.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const schema = {
  Country: { type: 'string' },
  'Order Total': { type: 'number' },
  'A]B': { type: 'boolean' },
  AND: { type: 'boolean' },
} as const;

// Spaces and other non-identifier characters: wrap the exact name in brackets.
console.log(validateExpression('[Order Total] >= 1000', { schema, expectedResult: 'boolean' }));
// { ok: true, resultType: { type: 'boolean', nullable: false }, referencedFields: ['Order Total'] }

// A literal ']' inside a name is written as ']]'.
console.log(validateExpression('[A]]B]', { schema, expectedResult: 'boolean' }));
// { ok: true, ... referencedFields: ['A]B'] }

// Keywords such as AND must be bracketed to mean the field.
console.log(validateExpression('[AND] OR Country == "NL"', { schema, expectedResult: 'boolean' }));
// { ok: true, ... referencedFields: ['AND', 'Country'] }
```

---

## How do I reference a field with the same name as a built-in?

**Solution**: A bare built-in name without parentheses is parsed as a field reference, so it resolves against the schema like any other field; bracketing is equivalent and always unambiguous. With parentheses, the name is always the built-in call, and calls are case-insensitive. If no such field is declared, the analyzer asks for the call form instead of silently guessing.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const schema = { trim: { type: 'string' }, Name: { type: 'string' } } as const;

// A bare built-in name without parentheses is a field reference.
console.log(validateExpression('trim == "x"', { schema })); // { ok: true, ... }

// Bracketing is equivalent and unambiguous.
console.log(validateExpression('[trim] == "x"', { schema })); // { ok: true, ... }

// With parentheses it is always the built-in call, regardless of case.
console.log(validateExpression('Trim(Name) == "x"', { schema })); // { ok: true, ... }

// If the field is not declared, the analyzer asks for the call form.
const missing = validateExpression('trim', { schema: { Name: { type: 'string' } } });
if (!missing.ok) {
  console.log(missing.diagnostics[0]?.code); // BS_UNEXPECTED_TOKEN
  console.log(missing.diagnostics[0]?.message); // Built-in trim must be called with parentheses.
}
```

Only the twelve documented built-ins can ever be called; any other `name(...)` fails with `BS_UNEXPECTED_TOKEN` ("Only documented BlendScript built-ins can be called.").

---

## How do I make sure a record is complete before evaluation?

**Solution**: Evaluation always validates every declared field first, even fields the rule never references, and never reads undeclared extras. Declared fields must be own data properties with matching finite values; accessor properties are rejected without invoking the getter. Failures are value-free record diagnostics with `reason`, `expectedType`, `nullable`, and `actualType` metadata.

```typescript
import { compileExpression, evaluateExpression, type ExpressionValue } from 'blendsdk/blendscript';

const schema = { Name: { type: 'string' }, Unused: { type: 'boolean' } } as const;
const compiled = compileExpression('Name == "Blend"', { schema });
if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message);

// Every declared field is required, including fields the rule never references.
const missing = evaluateExpression(compiled.expression, { Name: 'Blend' });
if (!missing.ok && missing.diagnostic.kind === 'record') {
  console.log(missing.diagnostic.code); // BS_MISSING_FIELD
  console.log(missing.diagnostic.field); // Unused
  console.log(missing.diagnostic.reason); // missing-field
  console.log(missing.diagnostic.actualType); // missing
}

// Declared accessor properties are rejected without ever invoking the getter.
const record: Record<string, ExpressionValue> = {};
Object.defineProperty(record, 'Name', { get: () => 'Blend', enumerable: true });
Object.defineProperty(record, 'Unused', { value: true, enumerable: true });
const accessor = evaluateExpression(compiled.expression, record);
if (!accessor.ok && accessor.diagnostic.kind === 'record') {
  console.log(accessor.diagnostic.reason); // accessor-property
  console.log(accessor.diagnostic.actualType); // accessor
}

// A complete record evaluates normally.
console.log(evaluateExpression(compiled.expression, { Name: 'Blend', Unused: false }));
// { ok: true, value: true }
```

An own `undefined` value is reported as a type mismatch (`actualType: 'undefined'`), distinct from a missing field. Non-finite numbers and oversized strings are record diagnostics too, while `null`, arrays, or class instances as the record container itself are programmer misuse that throws `BlendScriptApiError` with `BS_INVALID_ARGUMENT`.

---

## How do I respond to evaluation failures without exceptions?

**Solution**: Narrow the `EvaluationResult` union: success carries `value`, failure carries one `diagnostic` whose `kind` distinguishes `'source'` failures (null misuse, work limits, with exact spans) from `'record'` failures (missing, mismatched, or oversized field values). The only exceptions in the whole API are `BlendScriptApiError` instances thrown for programmer misuse such as invalid options, invalid schemas, or forged handles.

```typescript
import { BlendScriptApiError, compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { Amount: { type: 'number' }, Name: { type: 'string' } } as const;
const compiled = compileExpression('Amount >= 100 AND contains(Name, "Blend")', { schema });
if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message);

const success = evaluateExpression(compiled.expression, { Amount: 150, Name: 'BlendScript' });
console.log(success); // { ok: true, value: true }

const mismatch = evaluateExpression(compiled.expression, { Amount: '150', Name: 'BlendScript' });
if (!mismatch.ok && mismatch.diagnostic.kind === 'record') {
  console.log(mismatch.diagnostic.code); // BS_RUNTIME_TYPE_MISMATCH
  console.log(mismatch.diagnostic.field); // Amount
  console.log(mismatch.diagnostic.reason); // type-mismatch
  console.log(mismatch.diagnostic.expectedType); // number
  console.log(mismatch.diagnostic.actualType); // string
}

// Programmer misuse is the only thing that throws; catch it at the call site.
const oversized: Record<string, { type: 'boolean' }> = {};
for (let index = 0; index < 1_025; index += 1) {
  oversized[`F${index}`] = { type: 'boolean' };
}
try {
  compileExpression('TRUE', { schema: oversized });
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.log(error.code); // BS_SCHEMA_FIELD_LIMIT_EXCEEDED
  }
}
```

---

## How do I make sure a rule cannot reach the host environment?

**Solution**: Treat `validateExpression` as the gate: only rules that pass validation should ever be stored, compiled, or evaluated. The grammar has no member access, calls, imports, `eval`, or `Function`, so host-capability syntax cannot even parse — there is no sandbox to escape because there is nothing to reach.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const attempts = [
  'process.exit()',
  'require("node:fs")',
  'import("node:fs")',
  'Function("return 1")()',
  'eval("TRUE")',
  'constructor.constructor("return process")()',
  'globalThis.process',
  'this',
];

for (const source of attempts) {
  const result = validateExpression(source, { schema: {} });
  if (result.ok) {
    throw new Error(`Unexpectedly accepted host-capability syntax: ${source}`);
  }
  console.log(source, '->', result.diagnostics[0]?.code);
}
// process.exit() -> BS_INVALID_CHARACTER
// require("node:fs") -> BS_UNEXPECTED_TOKEN
// import("node:fs") -> BS_UNEXPECTED_TOKEN
// Function("return 1")() -> BS_UNEXPECTED_TOKEN
// eval("TRUE") -> BS_UNEXPECTED_TOKEN
// constructor.constructor("return process")() -> BS_INVALID_CHARACTER
// globalThis.process -> BS_INVALID_CHARACTER
// this -> BS_UNKNOWN_FIELD

// Only validated, schema-bound rules ever reach compilation and evaluation.
const safe = validateExpression('contains(lower(Name), "blend")', {
  schema: { Name: { type: 'string' } },
  expectedResult: 'boolean',
});
console.log(safe); // { ok: true, ... } — reads declared data only
```

---

## How do I keep rules terminating and avoid wasted work?

**Solution**: `AND` stops at the first `false` and `OR` at the first `true`, so unselected branches perform no work — place a cheap decisive check on the left to guard the rest. Every evaluation additionally has a fixed 10,000-step work budget; if a rule exhausts it, you get `BS_EVALUATION_STEP_LIMIT_EXCEEDED` instead of a hang.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { Enabled: { type: 'boolean' }, Code: { type: 'string', nullable: true } } as const;

const compiled = compileExpression('Enabled OR trim(Code) == "x"', { schema });
if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message);

// The right side is never evaluated, so trim(null) never runs.
console.log(evaluateExpression(compiled.expression, { Enabled: true, Code: null }));
// { ok: true, value: true }

// Here the left side is false, so the right side runs and fails on null.
const failure = evaluateExpression(compiled.expression, { Enabled: false, Code: null });
if (!failure.ok && failure.diagnostic.kind === 'source') {
  console.log(failure.diagnostic.code); // BS_NULL_NOT_ALLOWED
}
```

---

## Related Documents

- Core Concepts — the language model, schema binding, and inference.
- Basic Usage — the complete three-function workflow.
- Testing Patterns — writing reliable tests for rules and schemas.
- Troubleshooting — diagnostic codes and their causes.
- API Reference — every export, option, limit, and error type.

---

# blendscript Examples Library

This library collects copy-paste-ready examples for `blendsdk/blendscript`, organized from the three-function basics through complete rule-engine patterns. Every example is synchronous, strict TypeScript: it includes all imports, runs top to bottom, and shows expected results in comments. Examples use the direct package name; npm consumers of the `blendsdk` umbrella can substitute the identical `blendsdk/blendscript` entry point.

---

## 1. Getting Started

The whole API is three functions: `validateExpression` checks source while it is authored, `compileExpression` compiles checked source into an opaque reusable handle, and `evaluateExpression` runs that handle against one record.

### Validate an Expression

`validateExpression` returns the inferred result type and the referenced fields, or an ordered list of source diagnostics — no executable state is retained.

```typescript
import { validateExpression, type ExpressionOptions } from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
  },
  expectedResult: 'boolean',
};

const result = validateExpression('Country == "NL" AND OrderTotal >= 1000', options);

if (result.ok) {
  console.log(JSON.stringify(result.resultType)); // {"type":"boolean","nullable":false}
  console.log(result.referencedFields); // [ 'Country', 'OrderTotal' ]
} else {
  const first = result.diagnostics[0];
  if (first) console.error(`${first.code}: ${first.message}`);
}
```

### Compile and Evaluate a Rule

`compileExpression` continues along the same normalized pipeline and returns an opaque handle; `evaluateExpression` validates the record and interprets the expression against it.

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
  },
  expectedResult: 'boolean',
};

const compilation = compileExpression('Country == "NL" AND OrderTotal >= 1000', options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, { Country: 'NL', OrderTotal: 1250 });
if (!result.ok) throw new Error(result.diagnostic.message);

console.log(result.value); // true
```

### Reuse One Compiled Expression Across Records

A compiled handle holds no record state, so the same rule evaluates any number of records independently.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Enabled', {
  schema: { Enabled: { type: 'boolean' } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const records = [{ Enabled: true }, { Enabled: false }, { Enabled: true }];

for (const record of records) {
  const result = evaluateExpression(compilation.expression, record);
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(result.value);
}
// Output:
// true
// false
// true
```

### Inspect Inferred Result Types

Every literal and field reference has a statically inferred `{ type, nullable }` pair, and nullability flows through field declarations.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const literals = ['TRUE', '"hello"', '42', 'NULL'] as const;

for (const source of literals) {
  const result = validateExpression(source, { schema: {} });
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  console.log(`${source} => ${JSON.stringify(result.resultType)}`);
}
// TRUE => {"type":"boolean","nullable":false}
// "hello" => {"type":"string","nullable":false}
// 42 => {"type":"number","nullable":false}
// NULL => {"type":"null","nullable":true}

const field = validateExpression('OptionalCode', {
  schema: { OptionalCode: { type: 'string', nullable: true } },
});
if (!field.ok) throw new Error(field.diagnostics[0]?.message);
console.log(JSON.stringify(field.resultType)); // {"type":"string","nullable":true}
```

---

## 2. Schema Declarations

Every field an expression may reference must be declared, and the declared set is exactly the set of fields every evaluated record must carry.

### Declare String, Number, and Boolean Fields

The four field types are `string`, `number`, `boolean`, and `scalar`; records must match the declared type exactly at runtime.

```typescript
import { compileExpression, evaluateExpression, type ExpressionSchema } from 'blendsdk/blendscript';

const schema: ExpressionSchema = {
  Name: { type: 'string' },
  Count: { type: 'number' },
  Enabled: { type: 'boolean' },
};

const compilation = compileExpression('Enabled AND Count >= 1 AND contains(Name, "Blend")', {
  schema,
  expectedResult: 'boolean',
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, {
  Name: 'BlendScript',
  Count: 3,
  Enabled: true,
});
if (!result.ok) throw new Error(result.diagnostic.message);

console.log(result.value); // true
```

### Make a Field Optional with `nullable`

A record may contain `null` for a field only when its descriptor sets `nullable: true`; the default is `false`.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Code == NULL OR Code == "active"', {
  schema: { Code: { type: 'string', nullable: true } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

for (const Code of [null, 'active', 'closed'] as const) {
  const result = evaluateExpression(compilation.expression, { Code });
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(`${Code} => ${result.value}`);
}
// Output:
// null => true
// active => true
// closed => false
```

### Understand Mixed `scalar` Fields

A `scalar` field preserves whatever the record holds — a string or a finite number — without normalization, which is ideal for spreadsheet-like data. Direct concrete-type use is rejected at authoring time; rules must convert with `text(...)` or `tryNumber(...)`.

```typescript
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';

const schema = { Item: { type: 'scalar' as const } };

// A scalar field passes its value through exactly as provided.
const passthrough = compileExpression('Item', { schema });
if (!passthrough.ok) throw new Error(passthrough.diagnostics[0]?.message);
console.log(evaluateExpression(passthrough.expression, { Item: '001' })); // { ok: true, value: '001' }
console.log(evaluateExpression(passthrough.expression, { Item: 1 })); // { ok: true, value: 1 }

// Concrete-type operations without an explicit conversion fail at authoring time.
const rejected = validateExpression('Item > 1', { schema });
if (!rejected.ok) {
  const diagnostic = rejected.diagnostics[0];
  if (diagnostic) {
    console.log(diagnostic.code); // BS_TYPE_MISMATCH
    // Ordering comparisons require numeric operands. Use text(...) or tryNumber(...) to convert scalar values explicitly.
    console.log(diagnostic.message);
  }
}
```

### Use Bracketed Field Names for Spaces and Keywords

Wrap a field name in brackets when it contains spaces, collides with a keyword, or contains special characters. Inside brackets, `]]` escapes one literal closing bracket.

```typescript
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';

// Field names with spaces need brackets.
const spaced = validateExpression('Country == "NL" AND [Order Total] >= 1000', {
  schema: {
    Country: { type: 'string' },
    'Order Total': { type: 'number' },
  },
  expectedResult: 'boolean',
});
console.log(spaced.ok); // true

// `]]` inside brackets escapes one literal closing bracket: [A]]B] names the field `A]B`.
const escaped = validateExpression('[A]]B] == TRUE', {
  schema: { 'A]B': { type: 'boolean' } },
});
console.log(escaped.ok); // true

// Keywords such as AND must be bracketed when used as field names.
const keyword = compileExpression('[AND] == TRUE', {
  schema: { AND: { type: 'boolean' } },
});
if (!keyword.ok) throw new Error(keyword.diagnostics[0]?.message);
console.log(evaluateExpression(keyword.expression, { AND: true })); // { ok: true, value: true }
```

---

## 3. Operators and Logic

BlendScript uses spreadsheet-style precedence — `NOT` binds tightest, then comparisons, then `AND`, then `OR` — and values are compared strictly, with no implicit conversion.

### Apply Comparison Operators

```typescript
import { compileExpression, evaluateExpression, type ExpressionValue } from 'blendsdk/blendscript';

function evaluateCount(source: string, Count: number): ExpressionValue {
  const compilation = compileExpression(source, { schema: { Count: { type: 'number' } } });
  if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
  const result = evaluateExpression(compilation.expression, { Count });
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.value;
}

console.log(evaluateCount('Count == 12', 12)); // true
console.log(evaluateCount('Count != 10', 12)); // true
console.log(evaluateCount('Count < 20', 12)); // true
console.log(evaluateCount('Count <= 12', 12)); // true
console.log(evaluateCount('Count > 20', 12)); // false
console.log(evaluateCount('Count >= 12', 12)); // true
```

### Respect Operator Precedence and Symbolic Forms

`AND` binds tighter than `OR`, `NOT` binds tighter than comparison, and `!`, `&&`, and `||` are exact symbolic equivalents of the canonical keywords.

```typescript
import {
  compileExpression,
  evaluateExpression,
  type CompiledExpression,
  type ExpressionValue,
} from 'blendsdk/blendscript';

const schema = {
  Country: { type: 'string' as const },
  Enabled: { type: 'boolean' as const },
};
const data = { Country: 'GB', Enabled: false };

function run(expression: CompiledExpression): ExpressionValue {
  const result = evaluateExpression(expression, data);
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.value;
}

// AND binds tighter than OR, so this parses as
// Country == "GB" OR (Country == "NL" AND Enabled == TRUE).
const precedence = compileExpression(
  'Country == "GB" OR Country == "NL" AND Enabled == TRUE',
  { schema }
);
if (!precedence.ok) throw new Error(precedence.diagnostics[0]?.message);
console.log(run(precedence.expression)); // true

// NOT binds tighter than comparison; the symbolic forms evaluate identically.
const canonical = compileExpression('NOT Enabled OR Country == "GB"', { schema });
const symbolic = compileExpression('!Enabled || Country == "GB"', { schema });
if (!canonical.ok || !symbolic.ok) throw new Error('Expected both forms to compile.');
console.log(run(canonical.expression), run(symbolic.expression)); // true true
```

### Test Membership with IN

`IN` performs strict equality against a non-empty, literal-only list; duplicate members are allowed.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Country IN ("GB", "NL", "NL")', {
  schema: { Country: { type: 'string' } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

console.log(evaluateExpression(compilation.expression, { Country: 'NL' })); // { ok: true, value: true }
console.log(evaluateExpression(compilation.expression, { Country: 'XX' })); // { ok: true, value: false }

// Members must be primitive literals; fields or calls inside the list are rejected.
const invalid = compileExpression('Country IN (Other)', {
  schema: { Country: { type: 'string' }, Other: { type: 'string' } },
});
if (invalid.ok) throw new Error('Expected a syntax diagnostic.');
const diagnostic = invalid.diagnostics[0];
if (diagnostic) {
  // BS_UNEXPECTED_TOKEN - IN members must be primitive literals.
  console.log(diagnostic.code, '-', diagnostic.message);
}
```

### Compare Nulls with NULL and IN

`NULL` is a first-class literal: equality and membership treat it as an ordinary comparable value, but only when the left operand is nullable.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { Text: { type: 'string' as const, nullable: true } };

const equals = compileExpression('Text == NULL', { schema });
const membership = compileExpression('Text IN ("x", NULL)', { schema });
if (!equals.ok || !membership.ok) throw new Error('Expected both expressions to compile.');

console.log(evaluateExpression(equals.expression, { Text: null })); // { ok: true, value: true }
console.log(evaluateExpression(equals.expression, { Text: 'x' })); // { ok: true, value: false }
console.log(evaluateExpression(membership.expression, { Text: null })); // { ok: true, value: true }
console.log(evaluateExpression(membership.expression, { Text: 'y' })); // { ok: true, value: false }
// A NULL member on a non-nullable field (Text IN (NULL)) fails with BS_TYPE_MISMATCH.
```

---

## 4. Built-in Functions

The language ships exactly twelve built-ins. They are pure, synchronous, and resolved case-insensitively — `startswith` and `startsWith` are the same function.

### Match Substrings with String Predicates

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = {
  Text: { type: 'string' as const },
  Search: { type: 'string' as const },
};
const data = { Text: 'BlendScript', Search: 'Script' };

const cases = [
  ['contains(Text, Search)', true],
  ['startsWith(Text, Search)', false],
  ['endsWith(Text, Search)', true],
] as const;

for (const [source, expected] of cases) {
  const compilation = compileExpression(source, { schema });
  if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
  const result = evaluateExpression(compilation.expression, data);
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(`${source} => ${result.value} (expected ${expected})`);
}
// Output:
// contains(Text, Search) => true (expected true)
// startsWith(Text, Search) => false (expected false)
// endsWith(Text, Search) => true (expected true)
```

### Compare Case-Insensitively

`equalsIgnoreCase` lowercases both operands with non-locale semantics before comparing.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = {
  Input: { type: 'string' as const },
  Expected: { type: 'string' as const },
};
const compilation = compileExpression('equalsIgnoreCase(Input, Expected)', { schema });
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

console.log(evaluateExpression(compilation.expression, { Input: 'Blend', Expected: 'blend' }));
// { ok: true, value: true }
console.log(evaluateExpression(compilation.expression, { Input: 'ABC', Expected: 'abc' }));
// { ok: true, value: true }
// Lowercasing is locale-independent, so 'İ' and 'i' are not equal.
console.log(evaluateExpression(compilation.expression, { Input: 'İ', Expected: 'i' }));
// { ok: true, value: false }
```

### Check for Empty and Blank Strings

`isEmpty` treats only `null` and `''` as empty; `isBlank` additionally treats whitespace-only strings as blank. Both accept `null` at runtime.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { Text: { type: 'string' as const, nullable: true } };

const isEmpty = compileExpression('isEmpty(Text)', { schema });
const isBlank = compileExpression('isBlank(Text)', { schema });
if (!isEmpty.ok || !isBlank.ok) throw new Error('Expected both expressions to compile.');

for (const Text of [null, '', ' ', ' \t'] as const) {
  const emptyResult = evaluateExpression(isEmpty.expression, { Text });
  if (!emptyResult.ok) throw new Error(emptyResult.diagnostic.message);
  const blankResult = evaluateExpression(isBlank.expression, { Text });
  if (!blankResult.ok) throw new Error(blankResult.diagnostic.message);
  console.log(JSON.stringify(Text), 'empty:', emptyResult.value, 'blank:', blankResult.value);
}
// Output:
// null empty: true blank: true
// "" empty: true blank: true
// " " empty: false blank: true
// " \t" empty: false blank: true
```

### Convert Case and Count Code Points

`lower` and `upper` return new strings; `length` counts Unicode code points, not UTF-16 code units.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const schema = { Text: { type: 'string' as const } };
const cases = [
  ['lower(Text)', 'ÄBC', 'äbc'],
  ['upper(Text)', 'abc', 'ABC'],
  ['length(Text)', '😀a', 2],
] as const;

for (const [source, Text, expected] of cases) {
  const compilation = compileExpression(source, { schema });
  if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);
  const result = evaluateExpression(compilation.expression, { Text });
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(`${source} => ${result.value} (expected ${expected})`);
}
// Output:
// lower(Text) => äbc (expected äbc)
// upper(Text) => ABC (expected ABC)
// length(Text) => 2 (expected 2)
```

### Parse Numbers with tryNumber

`tryNumber` converts a scalar to a number only when the complete value matches the locale-independent decimal grammar; anything else — including `null` input — yields `null` instead of failing.

```typescript
import { compileExpression, evaluateExpression, type ExpressionValue } from 'blendsdk/blendscript';

const compilation = compileExpression('tryNumber(Item)', {
  schema: { Item: { type: 'scalar', nullable: true } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const values: readonly ExpressionValue[] = [
  1, '1', '001', '-12.5', '.5', '5.', '+2', '1e3',
  null, '', ' ', '1abc', ' 1', '0x10', '1e309',
];

for (const Item of values) {
  const result = evaluateExpression(compilation.expression, { Item });
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(`${JSON.stringify(Item)} => ${JSON.stringify(result.value)}`);
}
// Output:
// 1 => 1
// "1" => 1
// "001" => 1
// "-12.5" => -12.5
// ".5" => 0.5
// "5." => 5
// "+2" => 2
// "1e3" => 1000
// null => null
// "" => null
// " " => null
// "1abc" => null
// " 1" => null
// "0x10" => null
// "1e309" => null
```

### Format Values with text

`text` returns the exact authored representation of a string or the JavaScript number formatting of a finite number — and it rejects `null` at runtime, so it must be guarded.

```typescript
import { compileExpression, evaluateExpression, type ExpressionValue } from 'blendsdk/blendscript';

const compilation = compileExpression('text(Item)', {
  schema: { Item: { type: 'scalar' } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const values: readonly ExpressionValue[] = [1, '1', '001', 'ABC-1'];
for (const Item of values) {
  const result = evaluateExpression(compilation.expression, { Item });
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(`${JSON.stringify(Item)} => ${JSON.stringify(result.value)}`);
}
// Output:
// 1 => "1"
// "1" => "1"
// "001" => "001"
// "ABC-1" => "ABC-1"

// text(...) rejects null at runtime, even on a nullable field. The literal text(NULL)
// is rejected even earlier, at authoring time, with BS_TYPE_MISMATCH.
const nullable = compileExpression('text(Item)', {
  schema: { Item: { type: 'scalar', nullable: true } },
});
if (!nullable.ok) throw new Error(nullable.diagnostics[0]?.message);

const nullResult = evaluateExpression(nullable.expression, { Item: null });
if (!nullResult.ok && nullResult.diagnostic.kind === 'source') {
  console.log(nullResult.diagnostic.code); // BS_NULL_NOT_ALLOWED
}
```

---

## 5. Mixed Scalar Field Patterns

`scalar` fields preserve spreadsheet-style input exactly. Before any concrete-type operation, rules must convert explicitly, and the standard patterns below stay safe for arbitrary mixed data.

### Write Safe Numeric Rules over Mixed Data

The `tryNumber(...) != NULL` guard runs first, so invalid text never reaches the ordering comparison — and `AND` short-circuits the second conversion away when the first check fails.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const numeric = compileExpression('tryNumber(Item) != NULL AND tryNumber(Item) > 1', {
  schema: { Item: { type: 'scalar' } },
});
if (!numeric.ok) throw new Error(numeric.diagnostics[0]?.message);

console.log(evaluateExpression(numeric.expression, { Item: 2 })); // { ok: true, value: true }
console.log(evaluateExpression(numeric.expression, { Item: '2' })); // { ok: true, value: true }
console.log(evaluateExpression(numeric.expression, { Item: 'ABC-1' })); // { ok: true, value: false }
```

### Write Exact Text Rules over Mixed Data

`text(...)` preserves the authored representation, so zero-padded codes and numeric values compare exactly as written.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

// '001' and 1 are textually different — exactly what zero-padded codes need.
const textual = compileExpression('text(Item) == "001"', {
  schema: { Item: { type: 'scalar' } },
});
if (!textual.ok) throw new Error(textual.diagnostics[0]?.message);

console.log(evaluateExpression(textual.expression, { Item: '001' })); // { ok: true, value: true }
console.log(evaluateExpression(textual.expression, { Item: 1 })); // { ok: true, value: false }
```

---

## 6. Diagnostics and Error Handling

Expression and record problems are returned as immutable, structured diagnostics — authored input never throws. Only programmer misuse throws `BlendScriptApiError`.

### Read a Source Diagnostic

Every source diagnostic carries a stable code, an exact UTF-16 span, one-based line/column coordinates, and a bounded excerpt.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const result = validateExpression('Country == "NL"', { schema: {} });
if (result.ok) throw new Error('Expected an unknown-field diagnostic.');

const diagnostic = result.diagnostics[0];
if (!diagnostic) throw new Error('Expected at least one diagnostic.');

console.log(diagnostic.kind); // source
console.log(diagnostic.code); // BS_UNKNOWN_FIELD
console.log(diagnostic.message); // Field "Country" is not declared in the schema.
console.log(diagnostic.span); // { start: 0, end: 7 }
console.log(diagnostic.location); // { line: 1, column: 1, endLine: 1, endColumn: 8 }
console.log(diagnostic.excerpt); // Country == "NL"

// Lexical and syntax problems stop the pipeline with exactly one diagnostic.
const syntax = validateExpression('TRUE)', { schema: {} });
if (!syntax.ok) {
  const first = syntax.diagnostics[0];
  if (first) console.log(first.code, first.span); // BS_UNEXPECTED_TOKEN { start: 4, end: 5 }
}
```

### Enforce an Expected Result Type

Providing `expectedResult` requires a non-null result of exactly that type, which makes authoring-time checks stricter than inference alone.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const result = validateExpression('"yes"', { schema: {}, expectedResult: 'boolean' });
if (result.ok) throw new Error('Expected a result-type mismatch.');

const diagnostic = result.diagnostics[0];
if (!diagnostic) throw new Error('Expected at least one diagnostic.');

console.log(diagnostic.code); // BS_EXPECTED_RESULT_TYPE_MISMATCH
console.log(diagnostic.message); // Expression result must be a non-null boolean.
console.log(diagnostic.span); // { start: 0, end: 5 }
```

### React to a Missing Record Field

Record validation runs before interpretation and covers every declared field — even fields the expression never references.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

// `TRUE` references no fields, but the declared `Code` field is still preflighted.
const compilation = compileExpression('TRUE', {
  schema: { Code: { type: 'string' } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, {});
if (result.ok) throw new Error('Expected a record failure.');

console.log(result.diagnostic.kind); // record
console.log(result.diagnostic.code); // BS_MISSING_FIELD
console.log(result.diagnostic.message); // Record is missing required field "Code".
```

### Inspect Structured Record Metadata

A record diagnostic describes the failure with `field`, `reason`, `expectedType`, `nullable`, and `actualType` — and never contains the rejected value.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('Count > 0', {
  schema: { Count: { type: 'number' } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, { Count: '5' });
if (result.ok) throw new Error('Expected a record failure.');

const diagnostic = result.diagnostic;
if (diagnostic.kind === 'record') {
  console.log(diagnostic.code); // BS_RUNTIME_TYPE_MISMATCH
  console.log(diagnostic.field); // Count
  console.log(diagnostic.reason); // type-mismatch
  console.log(diagnostic.expectedType); // number
  console.log(diagnostic.nullable); // false
  console.log(diagnostic.actualType); // string
}
```

### Handle Thrown Programmer Errors

Only broken calls throw `BlendScriptApiError`; catch it and branch on the stable `code` instead of the message.

```typescript
import {
  BlendScriptApiError,
  validateExpression,
  type ExpressionFieldSchema,
} from 'blendsdk/blendscript';

// One field above the 1,024-field schema limit is programmer misuse, so it throws.
const schema: Record<string, ExpressionFieldSchema> = {};
for (let index = 0; index <= 1_024; index += 1) {
  schema[`F${index}`] = { type: 'boolean' };
}

try {
  validateExpression('TRUE', { schema });
} catch (error) {
  if (error instanceof BlendScriptApiError) {
    console.log(error.code); // BS_SCHEMA_FIELD_LIMIT_EXCEEDED
    console.log(error.message); // Expression schema cannot contain more than 1024 fields.
  } else {
    throw error;
  }
}
// Other throwing codes: BS_INVALID_ARGUMENT, BS_INVALID_SCHEMA, BS_INVALID_OPTIONS,
// and BS_INVALID_COMPILED_EXPRESSION for forged or foreign compiled handles.
```

### Collect and Order Multiple Diagnostics

Semantic diagnostics are sorted by source position and capped at 20 per call; lexical and syntax problems return exactly one diagnostic instead.

```typescript
import { validateExpression } from 'blendsdk/blendscript';

const source = Array.from({ length: 21 }, (_, index) => `Missing${index}`).join(' AND ');
const result = validateExpression(source, { schema: {} });
if (result.ok) throw new Error('Expected unknown-field diagnostics.');

console.log(result.diagnostics.length); // 20
console.log(result.diagnostics.every(diagnostic => diagnostic.code === 'BS_UNKNOWN_FIELD')); // true
const first = result.diagnostics[0];
if (first) console.log(first.span.start); // 0
```

### Recognize the Evaluation Step Limit

Every valid expression runs inside a fixed deterministic work budget; valid but expensive records can still be rejected, and the diagnostic points at the exact call.

```typescript
import { compileExpression, evaluateExpression } from 'blendsdk/blendscript';

const compilation = compileExpression('equalsIgnoreCase(A, B)', {
  schema: { A: { type: 'string' }, B: { type: 'string' } },
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

// Each value is individually valid at the 4,096 code-unit string limit, but the
// combined native string work exceeds the fixed 10,000-step evaluation budget.
// (With short values the same expression simply returns true.)
const result = evaluateExpression(compilation.expression, {
  A: 'a'.repeat(4_096),
  B: 'a'.repeat(4_096),
});

if (!result.ok && result.diagnostic.kind === 'source') {
  console.log(result.diagnostic.code); // BS_EVALUATION_STEP_LIMIT_EXCEEDED
  console.log(result.diagnostic.message); // Evaluation cannot exceed 10000 deterministic work steps.
}
```

---

## 7. Real-World Patterns

End-to-end patterns that combine validation, compilation, evaluation, and diagnostics.

### Build a Small Rule Engine

Compile a catalog of rules once at startup, then evaluate each rule against incoming records — the compiled handles are reusable and stateless.

```typescript
import {
  compileExpression,
  evaluateExpression,
  type CompiledExpression,
  type ExpressionSchema,
  type ExpressionValue,
} from 'blendsdk/blendscript';

interface Rule {
  readonly name: string;
  readonly source: string;
}

const schema: ExpressionSchema = {
  Country: { type: 'string' },
  OrderTotal: { type: 'number' },
  IsVip: { type: 'boolean' },
};

const rules: readonly Rule[] = [
  { name: 'domestic-order', source: 'Country == "NL" AND OrderTotal >= 100' },
  { name: 'vip-customer', source: 'IsVip == TRUE' },
];

const compiled = new Map<string, CompiledExpression>();
for (const rule of rules) {
  const compilation = compileExpression(rule.source, { schema, expectedResult: 'boolean' });
  if (!compilation.ok) {
    throw new Error(`${rule.name}: ${compilation.diagnostics[0]?.message}`);
  }
  compiled.set(rule.name, compilation.expression);
}

const records: readonly Readonly<Record<string, ExpressionValue>>[] = [
  { Country: 'NL', OrderTotal: 250, IsVip: false },
  { Country: 'US', OrderTotal: 40, IsVip: true },
];

for (const record of records) {
  for (const [name, expression] of compiled) {
    const result = evaluateExpression(expression, record);
    if (!result.ok) throw new Error(`${name}: ${result.diagnostic.message}`);
    console.log(`${name}: ${result.value}`);
  }
}
// Output:
// domestic-order: true
// vip-customer: false
// domestic-order: false
// vip-customer: true
```

### End-to-End: Discount Eligibility with a Nullable Guard

This rule combines `IN`, `expectedResult`, and a short-circuit null guard: when `PromoCode` is `null`, the left side of `OR` is true and `upper(...)` — which would reject null — is never invoked.

```typescript
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
    PromoCode: { type: 'string', nullable: true },
  },
  expectedResult: 'boolean',
};

const source =
  'Country IN ("NL", "BE", "DE") AND OrderTotal > 50 AND ' +
  '(PromoCode == NULL OR startsWith(upper(PromoCode), "SAVE"))';

const validation = validateExpression(source, options);
if (!validation.ok) throw new Error(validation.diagnostics[0]?.message);

const compilation = compileExpression(source, options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const records = [
  { Country: 'NL', OrderTotal: 120, PromoCode: null },
  { Country: 'BE', OrderTotal: 80, PromoCode: 'save10' },
  { Country: 'US', OrderTotal: 200, PromoCode: null },
] as const;

for (const record of records) {
  const result = evaluateExpression(compilation.expression, record);
  if (!result.ok) throw new Error(result.diagnostic.message);
  console.log(result.value);
}
// Output:
// true
// true
// false
```

### Persist Source and Recompile on Load

Compiled handles are opaque in-memory values owned by the loaded package instance: they cannot be serialized or transferred. Persist the source and schema instead, then recompile after loading or upgrading.

```typescript
import { compileExpression, evaluateExpression, type ExpressionSchema } from 'blendsdk/blendscript';

interface StoredRule {
  readonly source: string;
  readonly schema: ExpressionSchema;
}

const stored: StoredRule = {
  source: 'Country == "NL" AND OrderTotal >= 1000',
  schema: {
    Country: { type: 'string' },
    OrderTotal: { type: 'number' },
  },
};

// Later — possibly after a restart or a package upgrade — compile the stored source.
const compilation = compileExpression(stored.source, {
  schema: stored.schema,
  expectedResult: 'boolean',
});
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, { Country: 'NL', OrderTotal: 1250 });
if (!result.ok) throw new Error(result.diagnostic.message);

console.log(result.value); // true
```

---

## Where to Go Next

- API Reference — every exported type, diagnostic code, and fixed limit.
- Troubleshooting — diagnosing common source and record failures.
- Documentation Index — all companion documents for `blendsdk/blendscript`.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
