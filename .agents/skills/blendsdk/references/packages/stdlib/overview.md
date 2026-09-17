> **Package**: `blendsdk/stdlib`

# stdlib Overview

---

## What It Is

`blendsdk/stdlib` is the foundational utility package of the BlendSDK monorepo — a compact, zero-dependency collection of pure TypeScript helpers for runtime type checking and string templating. It answers three everyday questions: *What type is this value at runtime?* (`isString`, `isBoolean`, `isNullOrUndef`, `isNumeric`), *how do I turn a parameterized string into final text?* (`isTemplateString`, `formatString`), and *how do I normalize a value into a consistent shape?* (`wrapInArray`, `isNullOrUndefDefault`). The package sits at the bottom of the BlendSDK dependency graph — every other package can depend on it, while it depends on nothing outside itself. It is ESM-only, requires Node.js >= 22, is written in strict TypeScript, and is published by TrueSoftware B.V. under the MIT license.

---

## Key Features

- **Type-safe runtime guards** — `isString`, `isBoolean` and `isNullOrUndef` are TypeScript type predicates: one call validates the value at runtime and narrows its type inside `if`/`else` blocks.
- **Correct fallback semantics** — `isNullOrUndefDefault` replaces only `null` and `undefined`; `""`, `0` and `false` are treated as real values and never substituted.
- **Template formatting** — `formatString` resolves `${key}`, `${key|default}` and dot-notation `${user.name}` placeholders from a params object, stringifies numbers and booleans, treats `""` as missing, and preserves unrecognized placeholders instead of throwing.
- **Template detection** — `isTemplateString` cheaply reports whether a string contains at least one `${...}` placeholder.
- **Strict numeric validation** — `isNumeric` accepts finite numbers and complete numeric strings (including scientific, hex, octal and binary notation) and rejects `NaN`, `Infinity`, partial strings like `"42px"` or `"1,000"`, arrays, objects and `BigInt`.
- **Array normalization** — `wrapInArray<T>` produces a `T[]` from any input: `[]` for nullish values, the original reference for arrays, a single-element array otherwise.
- **Zero-dependency, ESM-first, tree-shakeable** — no runtime dependencies, no side effects, named exports only; bundlers include just the functions you import.

---

## When To Use

- You are building inside the BlendSDK monorepo or on top of BlendSDK and want the same proven primitives the rest of the stack uses instead of ad-hoc `typeof` checks.
- You handle loosely typed data — environment variables, JSON payloads, query parameters — and want runtime checks that also narrow TypeScript types.
- You render dynamic text from parameters — email templates, i18n messages, notification or log lines — and need default values and nested lookups (for example `${user.name|Guest}`).
- You normalize "single value or array" inputs from configuration files or APIs with `wrapInArray`.
- You validate numeric input strictly, where `"42px"`, `"1,000"` and `"Infinity"` must be rejected rather than coerced by `parseFloat`.
- You prefer tiny, focused utilities with no framework lock-in over a heavyweight dependency.

This package is deliberately not a schema validator: the functions check individual values, not object shapes. For structural validation, pair stdlib's primitives with a dedicated validator of your choice.

---

## Architecture

stdlib follows a flat, one-concern-per-module architecture. Every public API lives in a dedicated source file that exports plain named functions. `src/index.ts` is the single public entry point and re-exports every module. The dependency graph between modules has exactly one edge — `wrapInArray` uses `isNullOrUndef` — everything else is independent.

### Module Layout

```text
blendsdk/stdlib
├── src/index.ts             — barrel export (the only public entry point)
├── src/formatString.ts      — formatString
├── src/isTemplateString.ts  — isTemplateString
├── src/isString.ts          — isString
├── src/isBoolean.ts         — isBoolean
├── src/isNullOrUndef.ts     — isNullOrUndef, isNullOrUndefDefault
├── src/isNumeric.ts         — isNumeric
└── src/wrapInArray.ts       — wrapInArray ── imports ──▶ isNullOrUndef
```

### Public API

| Export | Signature | Notes |
| --- | --- | --- |
| `formatString` | `(template: string, params?: Record<string, unknown>) => string` | Supports `${key}`, `${key\|default}` and dot-notation paths such as `${user.name}`; unresolved placeholders are left untouched |
| `isTemplateString` | `(value: string) => boolean` | `true` if at least one valid `${...}` placeholder is present |
| `isString` | `(value: unknown) => value is string` | Type predicate; `new String(...)` wrappers return `false` |
| `isBoolean` | `(value: unknown) => value is boolean` | Type predicate; `new Boolean(...)` wrappers return `false` |
| `isNullOrUndef` | `(value: unknown) => value is null \| undefined` | The string `"undefined"` is a valid string, not nullish |
| `isNullOrUndefDefault` | `<ReturnType>(value: ReturnType, defaultValue: ReturnType) => ReturnType` | Returns the fallback only when the value is `null` or `undefined` |
| `isNumeric` | `(value: unknown) => boolean` | Accepts finite numbers and fully numeric strings (`"42"`, `"3.14"`, `"1e10"`, `"0xFF"`); rejects `NaN`, `Infinity`, `"42px"`, arrays, objects |
| `wrapInArray` | `<T>(obj: unknown) => T[]` | `[]` for `null`/`undefined`, the same array reference if already an array, otherwise `[value]` |

### Design Patterns

- **Type predicate pattern** — `isString`, `isBoolean` and `isNullOrUndef` declare return types like `value is string`, so a single call both validates at runtime and narrows the type at compile time.
- **Barrel / façade pattern** — `src/index.ts` re-exports all modules; consumers always import from the package root and never from internal file paths.
- **Fallback (strategy) pattern** — default values are supplied by the caller (`isNullOrUndefDefault`, `${key|default}`), keeping policy decisions out of the library.
- **Pure-function modules** — one concern per file, named exports only, no classes, no shared state, no side effects; outputs depend only on inputs.
- **Fail-safe behavior** — `formatString` leaves unresolved placeholders visible instead of silently inserting empty strings, and `isNumeric` rejects ambiguous input instead of coercing it.

---

## Dependencies

| Dependency type | Details |
| --- | --- |
| Runtime | None — zero external runtime dependencies |
| Internal | `src/wrapInArray.ts` → `src/isNullOrUndef.ts` (single import edge); `src/index.ts` re-exports all public modules |
| Peer | None |
| Dev (build and test only) | TypeScript (strict), Vitest with `@vitest/coverage-v8`, `@types/node` |

- **Depended on by** — All other `blendsdk/*` packages and applications built on BlendSDK can rely on stdlib as their base layer. Because the dependency direction is strictly upward, stdlib never imports from higher-level packages, and its public API is the stable contract for the rest of the monorepo.
- **Distribution** — The package is marked `"private": true`: it is consumed inside the BlendSDK monorepo and reaches end users through the published `blendsdk` umbrella package, not as a directly installed npm dependency.
- **Environment** — ESM only (`"type": "module"`; the exports map defines `types` and `import` conditions only, so `require()` is unsupported). Requires Node.js >= 22. Build output is compiled JavaScript plus `.d.ts` declarations in `dist/`.

---

## Minimum Example

The example below touches every area of the package: array normalization, type-guarded validation, template detection and template formatting. It is a complete ESM program — run it with a TypeScript-capable ESM runner or compile it with `tsc` first (Node.js >= 22).

```typescript
import {
    formatString,
    isNumeric,
    isString,
    isTemplateString,
    wrapInArray
} from 'blendsdk/stdlib';

const tags: string[] = wrapInArray<string>('invoice'); // → ['invoice']

// Type guards narrow `unknown` values inside conditional blocks
const raw: unknown = '42';
if (isString(raw) && isNumeric(raw)) {
    console.log(`numeric string: ${raw.trim()}`); // → numeric string: 42
}

// Format a template with dot-notation and a default value
const template = 'Hello ${user.name|Guest}, you have ${count|0} items';
if (isTemplateString(template)) {
    const message: string = formatString(template, { user: { name: 'Alice' }, count: 5 });
    console.log(message); // → Hello Alice, you have 5 items
}

console.log(tags); // → [ 'invoice' ]
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
