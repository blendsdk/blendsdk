> **Package**: `blendsdk/blendscript`

# blendscript Overview

---

## What It Is

`blendsdk/blendscript` is a small, safe expression language for business rules, delivered as an ESM-only, strict TypeScript package in the BlendSDK monorepo. An application declares the fields a rule may reference in an explicit schema, then uses three functions — `validateExpression`, `compileExpression`, and `evaluateExpression` — to check spreadsheet-style formulas such as `Country == "NL" AND [Order Total] >= 1000`, compile them into opaque reusable handles, and evaluate them against records. The language is implemented as a private lexer, parser, static analyzer, and AST interpreter: there is no `eval`, no `new Function`, no dynamic import, no network or file access, and no way to define or call host functions, and the package has zero runtime dependencies. Authored-formula and record-data problems are returned as immutable, structured diagnostics instead of thrown exceptions; only programmer misuse — an invalid schema, invalid options, or a forged compiled handle — throws `BlendScriptApiError`. The complete runtime namespace is four symbols: `validateExpression`, `compileExpression`, `evaluateExpression`, and `BlendScriptApiError`; every other export is a type.

---

## Key Features

- **Safe by construction** — BlendScript is a closed language interpreted from a private, frozen AST, with no dynamic-code or dynamic-loader path anywhere in the production source.
- **Three-function API** — `validateExpression` checks source while it is authored, `compileExpression` compiles checked source into an opaque reusable handle, and `evaluateExpression` runs that handle against one record. Validation and compilation share one normalized pipeline, so the same input yields identical metadata and diagnostics.
- **Schema-bound static analysis** — every field must be declared (unknown fields fail with `BS_UNKNOWN_FIELD`), the result type is inferred, an optional `expectedResult` is enforced exactly, referenced fields are reported in first-source-occurrence order, and at most 20 ordered semantic diagnostics are returned.
- **Strict, coercion-free semantics** — operators and built-ins never convert values. The `scalar` field type preserves a string or a finite number exactly and requires explicit `text(...)` or `tryNumber(...)` conversion before concrete-type use.
- **Fixed built-in set** — twelve case-insensitive, pure, synchronous functions (`isEmpty`, `isBlank`, `contains`, `startsWith`, `endsWith`, `equalsIgnoreCase`, `trim`, `lower`, `upper`, `length`, `tryNumber`, `text`) with no registration API.
- **Structured, value-free diagnostics** — source problems carry exact UTF-16 spans plus one-based line/column locations and a bounded excerpt; record problems carry `reason`, `expectedType`, `nullable`, and `actualType` metadata, and never include the rejected value.
- **Deterministic resource bounds** — fixed limits on source length (16,384 UTF-16 code units), tokens (4,096), string length (4,096), field names (256), schema size (1,024 fields), and nesting (64), plus a 10,000-step evaluation budget with short-circuiting, so unselected branches perform no work.
- **Immutable input boundary** — tokens, AST nodes, payloads, results, and diagnostics are frozen; options, schemas, and records are captured through own data descriptors, so later caller mutations and declared accessors cannot change behavior. Record field accessors are never invoked, and every declared field is validated, including fields the formula does not reference. Proxy-backed inputs must be materialized into ordinary objects by the host, because proxies cannot be detected without running their traps.
- **Opaque compiled handles** — a compiled expression is a branded memory value owned by the loaded package instance, backed by a private `WeakMap`. Forged handles throw `BlendScriptApiError` (`BS_INVALID_COMPILED_EXPRESSION`), and handles cannot be serialized or transferred between package instances.
- **Zero runtime dependencies** — ESM-only, strict TypeScript, built only on ECMAScript built-ins, and verified to load and evaluate even when `eval` and `Function` are unavailable.

---

## When To Use

Use `blendsdk/blendscript` when:

- Business rules must be authored by domain experts, stored as text, and read like spreadsheet formulas (`Country IN ("NL", "BE")`).
- Rule text must be checked while it is edited and fail with precise, actionable diagnostics.
- The environment forbids `eval`, `Function`, dynamic imports, and host-defined functions.
- The readable fields and the expected result type must be constrained by an explicit schema before a rule is accepted.
- The same formula runs many times: compile once, then evaluate per record.
- Source data is spreadsheet-like and mixed — `scalar` fields hold either text or finite numbers, and rules convert deliberately with `tryNumber` or `text` instead of relying on implicit coercion.
- Records must be validated as complete before evaluation, and failure reports must be precise without exposing rejected values.

Prefer another approach when:

- You need arithmetic, variables, statements, loops, dates, regular expressions, comments, locale-specific behavior, or custom functions; these are deliberate v1 exclusions.
- You need a SQL expression builder — that is a different package (`blendsdk/expression`), and BlendScript makes no compatibility or ancestry claim with it, or with Filtrex.
- You need persistence or interchange of compiled rules: handles are in-memory only. Store the source and schema, then recompile after loading or upgrading.

---

## Architecture

BlendScript processes every expression through one deterministic, fail-fast pipeline. Validation and compilation are two exits from the same stages, which is why they agree on results and diagnostics:

```text
source + options (schema, expectedResult)
        │
        ▼
   Lexer         bounded tokens with exact UTF-16 spans
        │
        ▼
   Parser        frozen AST with explicit v1 precedence
        │
        ▼
   Analyzer      schema binding + static type inference
        │
        ├──── validateExpression ──► ValidationResult (no retained state)
        ▼
   Compile       opaque branded handle + private WeakMap payload
        │
        ▼
   Evaluator     AST interpretation over a validated record snapshot
        │
        ▼
   EvaluationResult ({ ok: true, value } | { ok: false, diagnostic })
```

Key design patterns:

- **Pipeline** — lexing, parsing, and analysis run once per call; `validateExpression` exits after analysis, while `compileExpression` continues along the same path into the handle factory.
- **Interpreter** — the evaluator walks the frozen private AST; no code is generated, cached as executable, or loaded dynamically.
- **Factory** — each successful compilation creates a fresh handle through an internal factory function; handles are never interned or reused across calls.
- **Opaque handle with private state** — the `CompiledExpression` brand is a unique symbol, and its payload lives in a module-private `WeakMap`, so structural lookalikes cannot be evaluated.
- **Discriminated unions** — every public result is `{ ok: true, ... }` or `{ ok: false, ... }`; a single check narrows the type.
- **Strategy table** — the twelve built-ins live in one closed, frozen lookup map whose static signatures are shared by the analyzer and the evaluator.
- **Immutable snapshots** — options, schemas, and records are captured through own data descriptors at the API boundary, and internal nodes, payloads, results, and diagnostics are frozen.
- **Bounded execution** — a deterministic work counter charges node visits and string operations against the fixed limits, so every accepted input terminates.

---

## Dependencies

| Direction                 | Name                                                    | Notes                                                                                       |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Runtime dependencies      | —                                                       | The manifest declares no `dependencies`; the implementation uses only ECMAScript built-ins. |
| Peer dependencies         | —                                                       | Nothing to install alongside.                                                               |
| Depended on by            | `blendsdk` umbrella package                             | Republishes the direct build byte-for-byte as `blendsdk/blendscript` and pins its version.  |
| Development-only tooling  | `typescript`, `vitest`, `@vitest/coverage-v8`, `@types/node` | Build, type-check, and tests only; nothing is shipped except `dist`.                   |

- Inside the monorepo, this package is a private workspace package imported as `blendsdk/blendscript`. npm consumers install the `blendsdk` umbrella and import from `blendsdk/blendscript`; both entry points expose the identical build.
- Runtime baseline: Node.js >= 22, ESM-only (`"type": "module"`), with `.d.ts` declarations shipped next to every module.
- Part of the BlendSDK monorepo published by TrueSoftware B.V. under the MIT license.

---

## Minimum Example

```typescript
import {
  compileExpression,
  evaluateExpression,
  validateExpression,
  type ExpressionOptions,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Country: { type: 'string' }, OrderTotal: { type: 'number' } },
  expectedResult: 'boolean',
};
const source = 'Country == "NL" AND OrderTotal >= 1000';

const validation = validateExpression(source, options);
if (!validation.ok) throw new Error(validation.diagnostics[0]?.message);

const compilation = compileExpression(source, options);
if (!compilation.ok) throw new Error(compilation.diagnostics[0]?.message);

const result = evaluateExpression(compilation.expression, { Country: 'NL', OrderTotal: 1250 });
if (!result.ok) throw new Error(result.diagnostic.message);

console.log(result.value); // true
```

The same `options` object drives authoring-time validation and compilation; the resulting handle is reused across records.

---

## Next Steps

Continue with Core Concepts for the language model and Basic Usage for the complete three-function workflow. The API Reference documents every exported type, diagnostic code, and limit, and the documentation index lists all companion documents.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
