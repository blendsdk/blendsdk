> **Package**: `blendsdk/stdlib`

# stdlib Core Concepts

`blendsdk/stdlib` is built from a small set of deliberately orthogonal concepts. At the foundation are **runtime type predicates** — functions that validate a value at runtime and narrow its TypeScript type at compile time — plus **nullish fallback** and **strict numeric validation**. On top of that sits a **placeholder-based template system** with three facets: **syntax**, **detection**, and **formatting**. Finally, **array normalization** turns "one value, many values, or nothing" inputs into predictable arrays.

Each concept below follows the same structure: what it is, how it works internally, a complete runnable example, and a reference table. Together with the Overview, this covers the entire public API surface:

1. [Runtime Type Predicates](#runtime-type-predicates)
2. [Nullish Fallback](#nullish-fallback)
3. [Strict Numeric Validation](#strict-numeric-validation)
4. [Template Placeholder Syntax](#template-placeholder-syntax)
5. [Template Detection](#template-detection)
6. [Template Formatting](#template-formatting)
7. [Array Normalization](#array-normalization)

---

## Runtime Type Predicates

### What It Is

`isString`, `isBoolean` and `isNullOrUndef` are the package's runtime type guards. Each accepts a value of type `unknown` and returns a boolean — and because each declares a TypeScript type predicate as its return type (`value is string`, `value is boolean`, `value is null | undefined`), a single call both checks the value at runtime and narrows its type inside the calling scope. They are the primary way to safely interrogate values that arrive untyped: environment variables, parsed payloads, query parameters, and loose JavaScript interop.

### How It Works

- **Minimal runtime checks.** `isString` and `isBoolean` use `typeof`; `isNullOrUndef` uses strict equality (`value === null || value === undefined`). Nothing is coerced, converted, or thrown.
- **Compile-time narrowing.** The `value is T` return type activates TypeScript's control-flow analysis: inside `if (isString(x))`, `x` is `string`. Narrowing also applies to negated checks (`if (!isNullOrUndef(x))`) and to property references (`if (isBoolean(config.enabled))`).
- **Primitives only.** `typeof` classifies the object wrappers `new String("x")` and `new Boolean(true)` as `"object"`, so the guards return `false` for them — they recognize primitives, not wrappers.
- **Exact nullish semantics.** `isNullOrUndef` is `true` only for `null` and `undefined`. The string `"undefined"`, `NaN`, `0`, `""` and `false` are all defined values.
- **Zero overhead.** Each check is a single operation per call — no allocation, no shared state — safe for hot loops and validation pipelines.

Strict numeric input is handled separately by `isNumeric`, which is deliberately *not* a type predicate — see [Strict Numeric Validation](#strict-numeric-validation).

### Complete Example

```typescript
import { isBoolean, isNullOrUndef, isString } from 'blendsdk/stdlib';

function describeValue(value: unknown): string {
    if (isString(value)) {
        return `string of length ${value.length}`; // value: string
    }
    if (isBoolean(value)) {
        return value ? 'boolean true' : 'boolean false'; // value: boolean
    }
    if (isNullOrUndef(value)) {
        return 'nullish'; // value: null | undefined
    }
    return `other (${typeof value})`;
}

// Negated predicates narrow too — after this check `level` is `string`
const level: string | undefined = process.env.LOG_LEVEL;
if (!isNullOrUndef(level)) {
    console.log(`log level: ${level.toUpperCase()}`);
}

console.log(describeValue('hello')); // → string of length 5
console.log(describeValue(false));   // → boolean false
console.log(describeValue(null));    // → nullish
console.log(describeValue(42));      // → other (number)
```

### Key Methods

| Name | Signature | Description |
| --- | --- | --- |
| `isString` | `(value: unknown) => value is string` | `true` only for string primitives; `new String("x")` wrappers return `false`. Narrows to `string`. |
| `isBoolean` | `(value: unknown) => value is boolean` | `true` only for boolean primitives; `new Boolean(true)` wrappers return `false`. Narrows to `boolean`. |
| `isNullOrUndef` | `(value: unknown) => value is null \| undefined` | `true` only for `null` and `undefined`. `""`, `0`, `false`, `NaN` and the string `"undefined"` are all defined. |

Related concepts: [Nullish Fallback](#nullish-fallback) builds directly on `isNullOrUndef`.

---

## Nullish Fallback

### What It Is

`isNullOrUndefDefault` returns its default value only when the input is `null` or `undefined`, and returns the input itself in every other case. It exists for one specific job: guaranteeing a concrete value when data crosses a boundary where `null`/`undefined` can appear even though the static type claims otherwise — indexed lookups, parsed payloads, untyped JavaScript modules.

### How It Works

- **Strict nullish test.** The implementation delegates to [`isNullOrUndef`](#runtime-type-predicates): `isNullOrUndef(value) ? defaultValue : value`. Only `null` and `undefined` trigger the fallback — it is a two-value test, not a truthiness test.
- **Falsy values survive.** Unlike `value || defaultValue`, which also replaces `""`, `0`, `false` and `NaN`, this helper keeps them: `isNullOrUndefDefault(0, 5)` is `0`, and `isNullOrUndefDefault("", "untitled")` is `""`. Semantically it matches the `??` operator, exposed as a first-class function so it can be used in callbacks, pipelines, and argument positions.
- **Shared generic type.** Both parameters share one type parameter. When the input's static type is non-nullish (e.g. `string`), the result is exactly that type. When the static type includes nullish (e.g. `string | undefined`), the result keeps that union — the compiler still requires you to handle the theoretical case, while the fallback guarantees a concrete value at runtime.
- **Distinct from template defaults.** [`formatString`](#template-formatting) treats `""` as missing and substitutes its default, while this helper returns `""` untouched. That difference is intentional: formatting substitutes display text, fallback preserves data.

### Complete Example

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

// Indexed lookups can be typed `string` and still yield `undefined`
// at runtime when the key is missing — exactly the gap this helper closes.
const settings: Record<string, string> = { theme: 'dark' };

const theme: string = isNullOrUndefDefault(settings.theme, 'light');   // → 'dark'
const locale: string = isNullOrUndefDefault(settings.locale, 'en-US'); // → 'en-US'

// Only null and undefined trigger the fallback — all other values survive
const retries: number = isNullOrUndefDefault(0, 5);             // → 0
const label: string = isNullOrUndefDefault('', 'untitled');     // → ''
const enabled: boolean = isNullOrUndefDefault(false, true);     // → false

console.log({ theme, locale, retries, label, enabled });
// → { theme: 'dark', locale: 'en-US', retries: 0, label: '', enabled: false }
```

### Key Methods

| Name | Signature | Description |
| --- | --- | --- |
| `isNullOrUndefDefault` | `<ReturnType>(value: ReturnType, defaultValue: ReturnType) => ReturnType` | Returns `defaultValue` only when `value` is `null` or `undefined`; returns `value` in all other cases, including `""`, `0`, `false` and `NaN`. |

Related concepts: [Runtime Type Predicates](#runtime-type-predicates) (its basis), [Template Formatting](#template-formatting) (subtly different `""` semantics).

---

## Strict Numeric Validation

### What It Is

`isNumeric` validates that a value is a finite number or a string that fully represents one. It is the strict counterpart to JavaScript's coercing helpers: where `parseFloat("42px")` happily returns `42` and `isNaN("")` reports `false`, `isNumeric` rejects anything that is not unambiguously numeric — no partial parses, no silent coercion.

### How It Works

- **Number primitives.** A number passes only when `Number.isFinite` is true, so `NaN`, `Infinity` and `-Infinity` are rejected.
- **Strings — full-string conversion.** The string is trimmed, empty and whitespace-only strings are rejected, and the entire remainder is converted with the unary `+` operator. Unlike `parseFloat`, `+` requires the whole string to be one valid JavaScript numeric literal: `+"42px"`, `+"1,000"` and `+"3.14.15"` produce `NaN` and fail. The converted result must then be finite, which is what rejects the strings `"NaN"` and `"Infinity"`.
- **All JavaScript numeric literal formats.** Because conversion goes through `+`, scientific notation (`"1e10"`), hexadecimal (`"0xFF"`), octal (`"0o10"`), binary (`"0b1010"`), signed and leading-dot forms (`"+42"`, `".5"`) are all accepted when complete.
- **Everything else fails, without coercion.** Booleans, `null`, `undefined`, arrays (even single-element `[42]`), objects, functions, `Symbol`, `BigInt` and `Number` object wrappers all return `false`. Type checks run first, so values such as `Symbol` never throw.
- **Not a type predicate.** The function returns `boolean`, not `value is number`: success may mean a number *or* a numeric string, so TypeScript cannot narrow the argument. Pair it with an explicit conversion (`Number(value)`) when you need the numeric value; see [Runtime Type Predicates](#runtime-type-predicates) for the narrowing variety of guards.

### Complete Example

```typescript
import { isNumeric } from 'blendsdk/stdlib';

function parsePort(value: string | undefined): number | undefined {
    if (value !== undefined && isNumeric(value)) {
        return Number(value);
    }
    return undefined;
}

console.log(parsePort('8080'));   // → 8080
console.log(parsePort(' 3000 ')); // → 3000
console.log(parsePort('8080px')); // → undefined
console.log(parsePort('1,000'));  // → undefined

// Direct checks — finite numbers and complete numeric strings only
console.log(isNumeric(42));       // → true
console.log(isNumeric('3.14'));   // → true
console.log(isNumeric('0xFF'));   // → true
console.log(isNumeric(Infinity)); // → false
console.log(isNumeric([42]));     // → false
```

### Key Methods

| Name | Signature | Description |
| --- | --- | --- |
| `isNumeric` | `(value: unknown) => boolean` | `true` only for finite number primitives and strings that fully represent a finite number. No coercion, no narrowing. |

Decision reference:

| Input | `isNumeric` | Reason |
| --- | --- | --- |
| `42`, `-3.14`, `Number.MAX_SAFE_INTEGER` | `true` | Finite number primitive |
| `NaN`, `Infinity` | `false` | Not a finite number |
| `'42'`, `' 3.14 '`, `'-100'` | `true` | Complete numeric string (whitespace trimmed) |
| `'1e10'`, `'0xFF'`, `'0o10'`, `'0b1010'`, `'.5'`, `'+42'` | `true` | Valid JavaScript numeric literal |
| `'42px'`, `'100%'`, `'1,000'`, `'3.14.15'` | `false` | Trailing or embedded non-numeric characters |
| `''`, `'   '` | `false` | Empty after trim |
| `'NaN'`, `'Infinity'`, `'-Infinity'` | `false` | Converts to a non-finite number |
| `true`, `false`, `null`, `undefined` | `false` | Neither number nor string |
| `[42]`, `{ value: 42 }`, `() => 42` | `false` | Non-primitive; no coercion |
| `BigInt(123)`, `Symbol('42')` | `false` | Unsupported primitive; no throw |
| `new Number(42)` | `false` | Object wrapper, not a primitive |

---

## Template Placeholder Syntax

### What It Is

The placeholder syntax is the small expression language shared by the package's two templating functions: a `${...}` marker embedded in ordinary text that names a value to substitute, optionally with a default. [Template Detection](#template-detection) recognizes the grammar; [Template Formatting](#template-formatting) resolves it.

### How It Works

- **Shape.** A placeholder starts with `${` and ends at the closing `}`. Between the delimiters is an expression: a key path, optionally followed by a first `|` and a default value. Only the first pipe splits key from default, so defaults may themselves contain `|`.
- **Key paths.** The key consists of word characters (letters, digits, underscore) and dots. Dots denote nested access — `${user.address.city}` walks three levels of the params object. Whitespace around the key is tolerated: `${ name }` works. Keys outside the `[\w.]` set — such as `${full-name}` — are not recognized as placeholders at all.
- **Defaults.** Everything between the first `|` and the closing `}` is the default, used verbatim when the key resolves to nothing. Defaults may contain spaces and special characters (`${email|no-reply@example.com}`); the only character they cannot contain is `}`. Whitespace inside a default is preserved literally, and an empty default (`${name|}`) is valid, resolving to `""`.
- **No escaping.** There is no escape sequence for a literal `${` — such a sequence always begins a placeholder. A backslash is an ordinary character: `\${name}` is a literal backslash followed by the resolved placeholder.

### Complete Example

```typescript
import { formatString } from 'blendsdk/stdlib';

const examples: string[] = [
    formatString('${name}', { name: 'Alice' }),
    formatString('${name|Guest}', {}),
    formatString('${user.name}', { user: { name: 'Alice' } }),
    formatString('${user.name|Guest}', { user: {} }),
    formatString('${ name }', { name: 'Alice' })
];

console.log(examples);
// → [ 'Alice', 'Guest', 'Alice', 'Guest', 'Alice' ]
```

### Key Forms

| Form | Meaning | Example |
| --- | --- | --- |
| `${key}` | Substitute the value of `key` | `formatString('${name}', { name: 'Alice' })` → `'Alice'` |
| `${key\|default}` | Substitute, falling back to the default when the value is missing, `null`, `undefined` or `""` | `formatString('${name\|Guest}', {})` → `'Guest'` |
| `${path.to.key}` | Resolve a nested value through dot-notation | `formatString('${user.name}', { user: { name: 'Alice' } })` → `'Alice'` |
| `${path.to.key\|default}` | Nested lookup with fallback | `formatString('${user.name\|Guest}', { user: {} })` → `'Guest'` |
| `${ key }` | Whitespace around the key is tolerated | `formatString('${ name }', { name: 'Alice' })` → `'Alice'` |

Related concepts: [Template Detection](#template-detection) and [Template Formatting](#template-formatting) are the two consumers of this syntax.

---

## Template Detection

### What It Is

`isTemplateString` answers a single yes/no question for strings: does this text contain at least one `${...}` placeholder? It is the cheap pre-check you run before rendering — branch on it to skip formatting entirely for plain text, or to validate template input early.

### How It Works

- **Single regex test.** A non-global pattern matching the [placeholder grammar](#template-placeholder-syntax) is tested against the input; one match short-circuits to `true`.
- **Syntactic, not semantic.** The check knows nothing about params or resolvability. `"Hello ${name}"` and `"Hello ${missing}"` are both template strings; whether a key can actually be resolved is [`formatString`](#template-formatting)'s concern.
- **Strict about shape.** `${}` and `${   }` (no key path), an unclosed `${`, `$name` and `{name}` all return `false` — a placeholder must be well formed to count.
- **Input is `string`.** The parameter is typed `string`, not `unknown`, so for untrusted values combine it with [`isString`](#runtime-type-predicates) before calling.

### Complete Example

```typescript
import { formatString, isTemplateString } from 'blendsdk/stdlib';

function render(template: string, params: Record<string, unknown>): string {
    if (!isTemplateString(template)) {
        return template; // plain text — nothing to resolve
    }
    return formatString(template, params);
}

console.log(render('Hello ${user.name|Guest}', { user: { name: 'Alice' } }));
// → Hello Alice

console.log(render('Plain text, no placeholders', {}));
// → Plain text, no placeholders

console.log(render('Broken ${ template', {}));
// → Broken ${ template

console.log(isTemplateString('${}')); // → false — no key path
```

### Key Methods

| Name | Signature | Description |
| --- | --- | --- |
| `isTemplateString` | `(value: string) => boolean` | `true` if the string contains at least one well-formed `${...}` placeholder. A syntactic check only — resolvability against params is not tested. |

Related concepts: [Template Placeholder Syntax](#template-placeholder-syntax), [Template Formatting](#template-formatting).

---

## Template Formatting

### What It Is

`formatString` renders a template: it walks the input string, finds every `${...}` placeholder, resolves each against a params object, and returns the substituted text. It supports the full [placeholder syntax](#template-placeholder-syntax) — simple keys, defaults, and dot-notation paths — and never throws: placeholders it cannot resolve are left visible in the output rather than silently dropped.

### How It Works

1. **Fast path.** If the template does not contain `"${"` at all, it is returned unchanged and params are ignored — plain strings (log lines, labels) cost nothing.
2. **Match and split.** Placeholders are replaced in a single pass with a global regex. Each match's inner expression is split at the first `|`: the part before is the key (trimmed), the part after is the default (verbatim).
3. **Resolve.** The key is resolved against `params` as a dot-notation path; traversal abandons the path at the first `null`/`undefined` intermediate and yields `undefined`.
4. **Test for presence.** A resolved value is used only if it is not `undefined`, not `null`, and not `""`. `0` and `false` are present values and are stringified with `String(value)`.
5. **Fall back.** When no value is present and the placeholder had a default (even an empty one), the default text is inserted exactly as written.
6. **Preserve otherwise.** Without a value and without a default, the raw placeholder is kept — `${unknown}` stays `${unknown}`, making the gap visible instead of silently inserting an empty string.

Additional behavior worth knowing:

- **`params` is optional.** With no params, defaults still resolve: `formatString("Hello ${name|Guest}")` returns `"Hello Guest"`.
- **Values are stringified, not formatted.** `String(value)` renders numbers and booleans naturally (`42`, `0`, `-5`, `4.5`, `true`, `false`). For dates or objects, pass pre-formatted strings when presentation matters.
- **No escaping.** A backslash before `${` is kept as a literal backslash and the placeholder is still resolved.
- **Empty string quirk.** `formatString` treats `""` as missing (the default applies), whereas [`isNullOrUndefDefault`](#nullish-fallback) preserves `""` — the two are deliberately different by design.

### Complete Example

```typescript
import { formatString } from 'blendsdk/stdlib';

interface Order {
    id: string;
    total: number;
    paid: boolean;
    customer: { name?: string };
}

const order: Order = {
    id: 'A-1024',
    total: 49.5,
    paid: false,
    customer: {}
};

// One template with simple, nested, default and boolean placeholders
const receipt = formatString(
    'Order ${order.id} for ${order.customer.name|valued customer}: $${order.total}, paid: ${order.paid}',
    { order }
);

console.log(receipt);
// → Order A-1024 for valued customer: $49.5, paid: false

// Missing keys without a default keep their raw placeholder
console.log(formatString('Hello ${unknown}', { order }));
// → Hello ${unknown}

// "" falls back to the default; 0 and false are real values
console.log(formatString('${a|fallback} / ${b} / ${c}', { a: '', b: 0, c: false }));
// → fallback / 0 / false

// Nullish intermediates abandon the path and keep the placeholder
console.log(formatString('${user.address.city}', { user: null }));
// → ${user.address.city}
```

### Key Methods

| Name | Signature | Description |
| --- | --- | --- |
| `formatString` | `(template: string, params?: Record<string, unknown>) => string` | Replaces every `${...}` placeholder in `template` with the matching value from `params`. Supports `${key}`, `${key\|default}` and dot-notation paths. Unresolvable placeholders are returned unchanged. |

Resolution rules:

| Situation | Result |
| --- | --- |
| Value present (`'Alice'`, `49.5`, `0`, `false`) | `String(value)` is inserted |
| Value is `""` | Treated as missing |
| Key missing / `null` / `undefined`, default provided | Default text inserted verbatim (whitespace preserved) |
| Key missing / `null` / `undefined`, no default | Raw placeholder kept (e.g. `${unknown}`) |
| Nullish intermediate in a dot path | Treated as missing, as above |
| `params` omitted entirely | Defaults resolve; other placeholders are kept |
| No `${` in template | Returned unchanged (fast path) |

Related concepts: [Template Placeholder Syntax](#template-placeholder-syntax), [Template Detection](#template-detection), [Nullish Fallback](#nullish-fallback).

---

## Array Normalization

### What It Is

`wrapInArray` normalizes a "single value, an array, or nothing" input into a guaranteed array. It is the standard way to accept configuration that may arrive as one item or a list (`plugins: PluginConfig | PluginConfig[] | undefined`), and to turn optional values into loopable collections without branching at every call site.

### How It Works

- **Three-way decision, in order.** `Array.isArray(obj)` → return the input itself (the same reference, no copy). Otherwise `isNullOrUndef(obj)` (see [Runtime Type Predicates](#runtime-type-predicates)) → return a fresh `[]`. Otherwise → return a new single-element array `[obj]`.
- **Reference preservation.** Because real arrays pass through untouched, `wrapInArray(arr) === arr` — normalization is free for callers that already pass arrays.
- **Only arrays count.** `Set`, `Map`, `arguments`-like objects and other array-likes are treated as single values and wrapped, not spread.
- **The generic is a declaration.** The parameter is typed `unknown`, so the compiler cannot verify that the element type `T` matches the runtime data — `wrapInArray<T>` is a promise you make as the caller. It is intended for inputs whose element type is already established by the surrounding domain (configuration your code owns), not for raw external data that has not been validated.

### Complete Example

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

interface PluginConfig {
    name: string;
}

function pluginNames(config: PluginConfig | PluginConfig[] | undefined): string[] {
    return wrapInArray<PluginConfig>(config).map((plugin) => plugin.name);
}

console.log(pluginNames(undefined));                               // → []
console.log(pluginNames({ name: 'logger' }));                      // → [ 'logger' ]
console.log(pluginNames([{ name: 'logger' }, { name: 'cache' }])); // → [ 'logger', 'cache' ]

// Arrays pass through by reference — no copy is made
const tags: string[] = ['a'];
console.log(wrapInArray<string>(tags) === tags); // → true
```

### Key Methods

| Name | Signature | Description |
| --- | --- | --- |
| `wrapInArray` | `<T>(obj: unknown) => T[]` | `[]` when `obj` is `null`/`undefined`; the original array (same reference) when `obj` is already an array; `[obj]` otherwise. |

Normalization reference:

| Input | Output |
| --- | --- |
| `undefined`, `null` | `[]` (new empty array) |
| `['a', 'b']` | Same reference, unchanged |
| `'a'`, `42`, `false` | Single-element array containing the value |
| `new Set([1, 2])`, array-like object | Wrapped as a single element (not spread) |

Related concepts: [Runtime Type Predicates](#runtime-type-predicates) — `isNullOrUndef` drives the nullish branch.

---

# stdlib Basic Usage

This guide takes you from installation to a working program, then walks through each part of the public API one concept at a time. For the architectural background, see the Overview; for the design rationale behind each function, see Core Concepts.

---

## Installation

### Requirements

- **Node.js >= 22** — the required runtime.
- **ESM only** — the package is `"type": "module"` and its exports map declares only `types` and `import` conditions. `require()` and CommonJS consumers are unsupported.
- **Zero runtime dependencies** — there is nothing else to install or version-align.

### Inside the BlendSDK Monorepo

`blendsdk/stdlib` is a private workspace package (`"private": true`). Inside the repository it is resolved from the workspace — install the workspace dependencies from the repository root:

```bash
# npm
npm install

# yarn
yarn install
```

Any workspace package can then import `blendsdk/stdlib` with no additional setup.

### External Projects

Applications outside the repository receive stdlib through the published `blendsdk` umbrella package — `blendsdk/stdlib` itself is not published standalone to the npm registry:

```bash
# npm
npm install blendsdk

# yarn
yarn add blendsdk
```

Regardless of how it is consumed, the canonical import specifier throughout the BlendSDK documentation is `blendsdk/stdlib`.

### TypeScript Setup

The package ships ESM with type declarations, so consume it from an ESM project with `NodeNext` resolution:

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true
    }
}
```

The type predicates give their full benefit under strict null checks: a `string | undefined` narrowed by `!isNullOrUndef(...)` becomes `string`, exactly as shown in the examples below.

---

## Quick Start

Create a file — `hello.ts` — with the following program:

```typescript
import { formatString, isString } from 'blendsdk/stdlib';

const rawName: unknown = 'Alice';

if (isString(rawName)) {
    console.log(formatString('Hello ${name|Guest}, welcome back!', { name: rawName }));
}
// → Hello Alice, welcome back!
```

Compile the file with `tsc` (see [TypeScript Setup](#typescript-setup)) or run it directly with a TypeScript-capable ESM runner on Node.js >= 22.

`isString` validated the untyped value at runtime and narrowed it to `string`; `formatString` then resolved the `${name|Guest}` placeholder from the params object. Because `formatString` treats missing values as non-fatal, calling `formatString('Hello ${name|Guest}, welcome back!')` without params renders `Hello Guest, welcome back!` instead of throwing. The rest of this guide builds up from these basics.

---

## Fundamentals

Everything in stdlib is a plain named export from the package root: pure functions, no classes, no initialization call, no shared state. The steps below introduce one concept at a time, each as a complete runnable ESM program.

### 1. Runtime Type Checks

`isString`, `isBoolean` and `isNullOrUndef` are runtime guards with TypeScript type predicates. The simple case — one check, one narrowed block:

```typescript
import { isString } from 'blendsdk/stdlib';

const value: unknown = 'blendsdk';

if (isString(value)) {
    // `value` is narrowed to `string` inside this block
    console.log(value.toUpperCase());
}
// → BLENDSDK

console.log(isString(42)); // → false
```

The next level — combining guards to interpret values from an untyped boundary (environment variables, JSON payloads, query parameters):

```typescript
import { isBoolean, isString } from 'blendsdk/stdlib';

const rawFlag: unknown = process.env.FEATURE_BETA;

let betaEnabled = false;
if (isBoolean(rawFlag)) {
    betaEnabled = rawFlag;
} else if (isString(rawFlag)) {
    betaEnabled = rawFlag === 'true';
}

console.log(`beta enabled: ${betaEnabled}`);
// with FEATURE_BETA=true → beta enabled: true
```

Narrowing also works in negated form, which is the idiomatic way to exclude `null` and `undefined`:

```typescript
import { isNullOrUndef } from 'blendsdk/stdlib';

const logLevel: string | undefined = process.env.LOG_LEVEL;

if (!isNullOrUndef(logLevel)) {
    // `logLevel` is narrowed from `string | undefined` to `string`
    console.log(`log level: ${logLevel.toUpperCase()}`);
}
```

Key behaviors:

- Guards recognize **primitives only** — `new String('x')` and `new Boolean(true)` are object wrappers and return `false`.
- `isNullOrUndef` matches exactly `null` and `undefined`. The values `""`, `0`, `false`, `NaN` and the string `"undefined"` are all defined.
- Guards never throw and never coerce — they answer one question about the value and nothing else.

| Call | Result |
| --- | --- |
| `isString('hi')` | `true` |
| `isString(new String('hi'))` | `false` — object wrapper, not a primitive |
| `isBoolean(0)` | `false` |
| `isNullOrUndef(undefined)` | `true` |
| `isNullOrUndef('undefined')` | `false` — the string is a real value |
| `isNullOrUndef(NaN)` | `false` — `NaN` is defined |

### 2. Nullish Fallbacks

`isNullOrUndefDefault` closes one specific gap: values your types claim are present but that can be `null`/`undefined` at runtime — indexed lookups and untyped payloads, for example:

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

// A Record lookup is typed `string`, but a missing key yields
// `undefined` at runtime — exactly the gap this helper closes.
const env: Record<string, string> = { REGION: 'eu-west-1' };

const region: string = isNullOrUndefDefault(env.REGION, 'us-east-1'); // → 'eu-west-1'
const zone: string = isNullOrUndefDefault(env.ZONE, 'us-east-1a');    // → 'us-east-1a'

console.log(`${region} / ${zone}`);
// → eu-west-1 / us-east-1a
```

The next level — it is a *nullish* test, not a truthiness test, so falsy values survive untouched:

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

console.log(isNullOrUndefDefault(0, 5));             // → 0
console.log(isNullOrUndefDefault('', 'untitled'));   // → ''
console.log(isNullOrUndefDefault(false, true));      // → false
console.log(isNullOrUndefDefault(null, 'fallback')); // → 'fallback'
```

This is the first-class-function equivalent of `??`: `0 || 5` yields `5`, but `isNullOrUndefDefault(0, 5)` keeps `0`.

### 3. Strict Numeric Validation

`isNumeric` answers "is this a finite number, or a string that fully represents one?" — without the coercion surprises of `parseFloat` or loose `Number()` usage:

```typescript
import { isNumeric } from 'blendsdk/stdlib';

function toTimeout(value: unknown, fallback: number): number {
    return isNumeric(value) ? Number(value) : fallback;
}

console.log(toTimeout('1500', 3000));   // → 1500
console.log(toTimeout(' 1500 ', 3000)); // → 1500 — surrounding whitespace is fine
console.log(toTimeout('1500ms', 3000)); // → 3000 — partial numbers are rejected
console.log(toTimeout(Infinity, 3000)); // → 3000 — Infinity is not finite

console.log(isNumeric(42));      // → true
console.log(isNumeric('0xFF'));  // → true — a complete JS numeric literal
console.log(isNumeric('1,000')); // → false — no thousands separators
```

Note that `isNumeric` returns a plain `boolean`, not a type predicate: success may mean a number *or* a numeric string, so TypeScript cannot narrow the argument. Convert explicitly with `Number(value)` when you need the numeric value, as in `toTimeout` above.

| Input | `isNumeric` | Why |
| --- | --- | --- |
| `42`, `-0.5`, `Number.MAX_SAFE_INTEGER` | `true` | Finite number primitive |
| `'42'`, `' 3.14 '`, `'-100'` | `true` | Complete numeric string |
| `'1e10'`, `'0xFF'`, `'0b1010'`, `'.5'`, `'+42'` | `true` | Valid JavaScript numeric literal |
| `NaN`, `Infinity`, `'Infinity'` | `false` | Not finite |
| `'42px'`, `'100%'`, `'1,000'`, `'3.14.15'`, `''` | `false` | Not a complete number |
| `true`, `null`, `undefined`, `[42]`, `{ value: 42 }` | `false` | Non-primitive or non-numeric type; no coercion |
| `BigInt(123)`, `Symbol('42')` | `false` | Unsupported types — returned without throwing |

### 4. Template Detection

`isTemplateString` is the cheap pre-check: does this string contain at least one well-formed `${...}` placeholder?

```typescript
import { isTemplateString } from 'blendsdk/stdlib';

console.log(isTemplateString('Hello ${name}'));      // → true
console.log(isTemplateString('${user.name|Guest}')); // → true
console.log(isTemplateString('Hello world'));        // → false
console.log(isTemplateString('${}'));                // → false — no key path
```

The next level — use it to validate user-provided templates before they ever reach the formatter:

```typescript
import { isTemplateString } from 'blendsdk/stdlib';

function validateTemplate(template: string): string[] {
    if (template.length === 0) {
        return ['template must not be empty'];
    }
    if (!isTemplateString(template)) {
        return ['template does not contain any ${...} placeholders'];
    }
    return [];
}

console.log(validateTemplate('Hi ${name}')); // → []
console.log(validateTemplate('Hi'));         // → [ 'template does not contain any ${...} placeholders' ]
```

Remember:

- The check is **syntactic** — it confirms placeholder *shape*, not that a key will resolve. `'${missing.key}'` returns `true`.
- Malformed markers do not count: `${}`, `${   }`, an unclosed `'${'`, `$name` and `{name}` all return `false`.
- The parameter is typed `string`; for values of unknown type, narrow with `isString` first (see [Runtime Type Checks](#1-runtime-type-checks)).

### 5. Template Formatting

`formatString` performs the actual substitution. Start with the simple case, then add defaults and dot-notation:

```typescript
import { formatString } from 'blendsdk/stdlib';

// 1 — the simple case: one placeholder, one value
console.log(formatString('Hello ${name}!', { name: 'Alice' }));
// → Hello Alice!

// 2 — defaults: used when the key resolves to nothing; params optional
console.log(formatString('Hello ${name|Guest}!'));
// → Hello Guest!

// 3 — dot-notation: nested values with fallbacks
console.log(
    formatString('Hi ${user.name|customer}, order ${order.id} totals $${order.total}', {
        user: { name: 'Ada' },
        order: { id: 'A-1024', total: 49.5 }
    })
);
// → Hi Ada, order A-1024 totals $49.5
```

The next level — how values are treated once found:

```typescript
import { formatString } from 'blendsdk/stdlib';

// 0 and false are real values and are stringified …
console.log(formatString('${retries} retries, paid: ${paid}', { retries: 0, paid: false }));
// → 0 retries, paid: false

// … while "" counts as missing, so the default applies
console.log(formatString('note: ${note|none}', { note: '' }));
// → note: none

// Unresolvable placeholders are kept verbatim — never silently dropped
console.log(formatString('Hello ${unknown}'));
// → Hello ${unknown}
```

Rules worth memorizing:

- **Unresolvable placeholders are kept verbatim** — `'Hello ${unknown}'` stays `'Hello ${unknown}'`, so gaps remain visible instead of silently becoming empty text.
- **"Missing" means** the key is absent, `null`, `undefined`, `""`, or a nullish step along a dot path.
- **Falsy-but-present values survive**: `0` renders `"0"`, `false` renders `"false"`.
- **Values are stringified with `String(value)`** — for dates or compound objects, pass pre-formatted strings when presentation matters.
- **No escaping**: there is no way to write a literal `${`; a backslash is an ordinary character and does not escape a placeholder.

### 6. Array Normalization

`wrapInArray` normalizes a "single value, an array, or nothing" input into a guaranteed array:

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

console.log(wrapInArray<string>('alpha'));    // → [ 'alpha' ]
console.log(wrapInArray<string>(undefined));  // → []
console.log(wrapInArray<string>(['a', 'b'])); // → [ 'a', 'b' ]
```

The next level — the classic optional-or-list configuration pattern:

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

interface PluginConfig {
    name: string;
}

function loadPlugins(config: PluginConfig | PluginConfig[] | undefined): string[] {
    return wrapInArray<PluginConfig>(config).map((plugin) => plugin.name);
}

console.log(loadPlugins(undefined));                               // → []
console.log(loadPlugins({ name: 'logger' }));                      // → [ 'logger' ]
console.log(loadPlugins([{ name: 'logger' }, { name: 'cache' }])); // → [ 'logger', 'cache' ]

// Arrays pass through by reference — no copy is made
const existing = ['a', 'b'];
console.log(wrapInArray<string>(existing) === existing); // → true
```

Key rules:

- `null` and `undefined` become `[]`.
- Real arrays pass through **by reference** — normalization is free for callers that already pass arrays.
- Everything else — including `Set`, `Map` and array-like objects — is wrapped as a single element, not spread.
- The generic `<T>` is a declaration, not a runtime check: it tells the compiler the element type of data your domain already guarantees.

### 7. Putting It All Together

The example below combines several primitives from this section into one small pipeline: validate an untyped template, normalize recipients, and render one message per recipient.

```typescript
import {
    formatString,
    isString,
    isTemplateString,
    wrapInArray
} from 'blendsdk/stdlib';

function renderNotifications(
    template: unknown,
    recipients: string | string[] | undefined,
    vars: Record<string, unknown>
): string[] {
    if (!isString(template) || !isTemplateString(template)) {
        return [];
    }
    return wrapInArray<string>(recipients).map((recipient) =>
        formatString(template, { ...vars, recipient })
    );
}

const messages = renderNotifications(
    'Hi ${recipient|there}, order ${order.id} ships ${order.when|soon}',
    ['ada@example.com', 'grace@example.com'],
    { order: { id: 'A-1024', when: 'Monday' } }
);

for (const message of messages) {
    console.log(message);
}
// → Hi ada@example.com, order A-1024 ships Monday
// → Hi grace@example.com, order A-1024 ships Monday
```

Each function does one job: `isString` guards the boundary, `isTemplateString` decides whether formatting applies, `wrapInArray` normalizes the recipient list, and `formatString` renders each message — with defaults covering anything missing.

---

## Configuration

`blendsdk/stdlib` has **no runtime configuration**: no `init()` call, no global options object, no environment variables, and no shared state. Behavior is controlled per call, through optional parameters, template syntax, and type parameters. The table below lists the defaults that govern that behavior.

### Behavior Defaults

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `params` (`formatString`) | `Record<string, unknown> \| undefined` | `undefined` (treated as `{}`) | Values used to resolve placeholders. When omitted, template defaults still resolve and other placeholders are kept. |
| default text (`${key\|default}`) | `string`, written inside the template | none | Inserted verbatim when the key resolves to nothing. Without a default, the raw placeholder is preserved. |
| `defaultValue` (`isNullOrUndefDefault`) | `ReturnType` — same type as `value` | required argument | Fallback returned only for `null` and `undefined` — never for `""`, `0` or `false`. |
| `T` (`wrapInArray<T>`) | type parameter | declared by the caller | Element type of the returned array; a compile-time declaration with no runtime validation. |

### Environment Settings

| Setting | Value | Notes |
| --- | --- | --- |
| Node.js | `>= 22` | Required runtime. |
| Module system | ESM only | `"type": "module"`; only `import` conditions are exported — `require()` is unsupported. |
| Runtime dependencies | none | Nothing to install, configure, or keep in sync. |
| TypeScript strictness | `"strict": true` recommended | Predicate-based narrowing is most useful with strict null checks; stdlib is written and tested in strict mode. |

### Recommended `tsconfig.json`

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true
    }
}
```

For the consuming package itself, set `"type": "module"` in its `package.json` so Node treats the compiled output as ESM. No other configuration exists: there is no logging, retry, or caching layer to tune, and the stateless checks — `isString`, `isBoolean`, `isNullOrUndef`, `isNumeric`, `isTemplateString` — have nothing to configure at all.

---

## Error Handling

stdlib is deliberately **fail-safe**: none of its eight public functions throws for data conditions. There are no error classes to catch, no error codes, and no partial results — every function returns a deterministic sentinel value instead. This section shows what those sentinels are, the only errors you can actually encounter, and the boundary patterns that keep both out of your code.

### Fail-Safe by Design

| Condition | Function | Result | Throws? |
| --- | --- | --- | --- |
| Key missing, no default | `formatString` | Raw placeholder kept (`'${unknown}'`) | No |
| Value is `null`, `undefined` or `""`, default provided | `formatString` | Default text inserted | No |
| Nullish intermediate in a dot path | `formatString` | Raw placeholder kept | No |
| Not a finite number or complete numeric string | `isNumeric` | `false` | No — type checks run before any conversion; `Symbol` and `BigInt` included |
| `null` / `undefined` input | `wrapInArray` | `[]` | No |
| `null` / `undefined` value | `isNullOrUndefDefault` | `defaultValue` | No |
| Any value | `isString`, `isBoolean`, `isNullOrUndef` | `boolean` answer | No |
| Any string | `isTemplateString` | `boolean` answer | No |

### Error Types and Their Meanings

| Error | Origin | Meaning | Recommended handling |
| --- | --- | --- | --- |
| `TypeError` | JavaScript runtime | A non-string value reached `formatString` as `template` (only possible by bypassing TypeScript, e.g. from plain JS) — `template.includes(...)` cannot run. | Guard with `isString` before calling `formatString`. |
| `SyntaxError` | External boundary (`JSON.parse`, ...) | Malformed input at your boundary — unrelated to stdlib. | `try`/`catch` at the boundary, then validate the parsed result with stdlib guards. |
| `TS2345` (compile time) | TypeScript | Argument of the wrong type — e.g. `formatString(42)`, or an `unknown` value passed without narrowing. | Fix the argument, or narrow it with a type guard first. |
| *(none)* | stdlib | stdlib defines no custom error classes. | Nothing to `instanceof`-check, nothing to translate. |

### Guarding Untyped Boundaries

Validate with the package's own type guards instead of relying on `try`/`catch` around library calls:

```typescript
import { formatString, isString, isTemplateString } from 'blendsdk/stdlib';

function render(templateSource: unknown, params: Record<string, unknown>): string | undefined {
    if (!isString(templateSource)) {
        return undefined; // not even a string — refuse quietly, no exception
    }
    return isTemplateString(templateSource)
        ? formatString(templateSource, params)
        : templateSource; // valid string, no placeholders — return as-is
}

console.log(render('Hello ${name}!', { name: 'Alice' })); // → Hello Alice!
console.log(render('Plain text', { name: 'Alice' }));     // → Plain text
console.log(render(null, { name: 'Alice' }));             // → undefined
console.log(render(42, { name: 'Alice' }));               // → undefined
```

### Catching at External Boundaries

Use `try`/`catch` for the boundaries that genuinely throw — parsing, I/O, network — and validate their payloads with stdlib checks. stdlib itself never needs to appear inside a catch strategy:

```typescript
import { isNumeric } from 'blendsdk/stdlib';

interface TimeoutSettings {
    timeout: number;
}

function parseTimeoutSettings(json: string): TimeoutSettings | undefined {
    try {
        const parsed: unknown = JSON.parse(json);
        if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'timeout' in parsed &&
            isNumeric(parsed.timeout)
        ) {
            return { timeout: Number(parsed.timeout) };
        }
        return undefined;
    } catch (error) {
        if (error instanceof SyntaxError) {
            console.error(`Invalid JSON: ${error.message}`);
        }
        return undefined;
    }
}

console.log(parseTimeoutSettings('{"timeout": 1500}')); // → { timeout: 1500 }
console.log(parseTimeoutSettings('{"timeout": "2s"}')); // → undefined
console.log(parseTimeoutSettings('not json'));          // → undefined (+ error logged)
```

Because stdlib never throws on data, the guards compose safely everywhere — inside `catch` blocks, validation loops, and configuration parsers — without introducing error handling of their own.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
