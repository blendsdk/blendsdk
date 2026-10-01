> **Package**: `blendsdk/stdlib`

# stdlib API Reference

Complete reference for every public export of `blendsdk/stdlib`. The package exposes **eight functions** — there are no exported classes, interfaces, enums, or runtime constants. Every function is pure (no shared state, no side effects) and none of them throw: unexpected input produces `false`, a fallback, or an unchanged placeholder instead. All symbols are named ESM exports of the package root.

---

## Importing the Package

The exports map defines a single entry — the package root — so all symbols are imported from `blendsdk/stdlib`:

```typescript
import {
    formatString,
    isBoolean,
    isNumeric,
    isNullOrUndef,
    isNullOrUndefDefault,
    isString,
    isTemplateString,
    wrapInArray
} from 'blendsdk/stdlib';
```

The package is ESM-only (`"type": "module"`; the exports map provides `import` and `types` conditions only — `require()` is not supported) and requires Node.js >= 22. Deep imports into `dist/` are not available.

---

## API at a Glance

| Export | Signature | Description |
|--------|-----------|-------------|
| `formatString` | `(template: string, params?: Record<string, unknown>) => string` | Replaces `${...}` placeholders with values from `params`; supports defaults and dot-notation |
| `isBoolean` | `(value: unknown) => value is boolean` | Type predicate — `true` for boolean primitives |
| `isNumeric` | `(value: unknown) => boolean` | `true` for finite numbers and complete numeric strings; strict, no coercion |
| `isNullOrUndef` | `(value: unknown) => value is null \| undefined` | Type predicate — `true` only for `null` and `undefined` |
| `isNullOrUndefDefault` | `<ReturnType>(value: ReturnType, defaultValue: ReturnType) => ReturnType` | Returns the fallback only for `null`/`undefined`; all other values survive |
| `isString` | `(value: unknown) => value is string` | Type predicate — `true` for string primitives |
| `isTemplateString` | `(value: string) => boolean` | `true` when the string contains at least one well-formed `${...}` placeholder |
| `wrapInArray` | `<T>(obj: unknown) => T[]` | `[]` for nullish input, the same array when already an array, `[value]` otherwise |

---

## Type Checking Functions

### isBoolean

Tests whether a value is a boolean primitive. The return type is a **type predicate**, so a single call both validates at runtime and narrows the argument's compile-time type.

**Signature**

```typescript
export function isBoolean(value: unknown): value is boolean
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `value` | `unknown` | Yes | — | The value to test. |

**Returns**

`value is boolean` — a type predicate. `true` when the value is the primitive `true` or `false`; `false` for everything else. Inside `if (isBoolean(x))`, `x` is narrowed to `boolean`.

**Example**

```typescript
import { isBoolean } from 'blendsdk/stdlib';

const settings: Record<string, unknown> = { verbose: true, retries: 3 };

if (isBoolean(settings.verbose)) {
    console.log(settings.verbose ? 'verbose on' : 'verbose off'); // → verbose on
}

console.log(isBoolean(false));             // → true
console.log(isBoolean(Boolean(1)));        // → true  — Boolean() returns a primitive
console.log(isBoolean('true'));            // → false — a string, not a boolean
console.log(isBoolean(new Boolean(true))); // → false — object wrapper
```

**Notes**

- Calling `Boolean(x)` as a function returns a primitive and passes the check; `new Boolean(x)` creates an object wrapper and fails it.
- The `Boolean` constructor itself is not a boolean value: `isBoolean(Boolean)` returns `false`.

---

### isNullOrUndef

Tests whether a value is `null` or `undefined`. The return type is a **type predicate**, so `if (!isNullOrUndef(x))` narrows `x` to a non-nullish type.

**Signature**

```typescript
export function isNullOrUndef(value: unknown): value is null | undefined
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `value` | `unknown` | Yes | — | The value to test. |

**Returns**

`value is null | undefined` — a type predicate. `true` only for `null` and `undefined`; `false` for every other value, including `""`, `0`, `false`, `NaN`, and the string `"undefined"`.

**Example**

```typescript
import { isNullOrUndef } from 'blendsdk/stdlib';

const level: string | undefined = process.env.LOG_LEVEL;

if (!isNullOrUndef(level)) {
    console.log(level.toUpperCase()); // level is narrowed to string here
}

console.log(isNullOrUndef(null));        // → true
console.log(isNullOrUndef(undefined));   // → true
console.log(isNullOrUndef(''));          // → false — empty string is defined
console.log(isNullOrUndef(0));           // → false
console.log(isNullOrUndef('undefined')); // → false — a valid string value
```

**Notes**

- The string `"undefined"` is a legitimate string value and is **not** treated as nullish.
- Use this instead of a truthiness check whenever `""`, `0` and `false` must be preserved.

---

### isNumeric

Validates that a value is a finite number or a string that **fully** represents one. Whitelist semantics: the whole value must be numeric — no partial parses, no silent coercion, no exceptions.

**Signature**

```typescript
export function isNumeric(value: unknown): boolean
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `value` | `unknown` | Yes | — | The value to test. |

**Returns**

`boolean` — `true` for finite number primitives and complete numeric strings; `false` otherwise. This is **not** a type predicate: a passing value may be a number *or* a numeric string, so TypeScript does not narrow the argument. Convert explicitly with `Number(value)` when you need the numeric value.

**Behavior**

- **Number primitives** — accepted only when `Number.isFinite` is true: `42`, `-3.14`, `0` pass; `NaN`, `Infinity` and `-Infinity` fail.
- **Strings** — trimmed, then the entire remainder must convert to a finite number via the unary `+` operator. This accepts every complete JavaScript numeric literal: `'42'`, `'-100'`, `' 3.14 '`, `'+42'`, `'.5'`, `'1e10'`, `'1.5e-10'`, `'0xFF'`, `'0o10'`, `'0b1010'`. It rejects anything with extra characters (`'42px'`, `'100%'`, `'1,000'`, `'3.14.15'`), empty or whitespace-only strings, and the strings `'NaN'` and `'Infinity'` (they convert to non-finite numbers).
- **Everything else** — booleans, `null`, `undefined`, arrays (even `[42]`), objects, functions, `Symbol`, `BigInt`, and `new Number(...)` wrappers all return `false`. Type checks run before conversion, so no input causes a `TypeError`.

**Example**

```typescript
import { isNumeric } from 'blendsdk/stdlib';

function parsePort(value: string | undefined): number | undefined {
    if (value !== undefined && isNumeric(value)) {
        return Number(value); // isNumeric does not narrow — convert explicitly
    }
    return undefined;
}

console.log(parsePort('8080'));   // → 8080
console.log(parsePort(' 3000 ')); // → 3000
console.log(parsePort('8080px')); // → undefined
console.log(parsePort('1,000'));  // → undefined

console.log(isNumeric('0xFF'));   // → true
console.log(isNumeric(Infinity)); // → false
console.log(isNumeric([42]));     // → false
```

**Representative Results**

| Input | Returns | Reason |
|-------|---------|--------|
| `42`, `-3.14`, `Number.MAX_SAFE_INTEGER` | `true` | Finite number primitive |
| `'42'`, `' 3.14 '`, `'-100'` | `true` | Complete numeric string (whitespace trimmed) |
| `'1e10'`, `'0xFF'`, `'0o10'`, `'0b1010'`, `'.5'`, `'+42'` | `true` | Valid JavaScript numeric literal |
| `NaN`, `Infinity`, `-Infinity`, `'NaN'`, `'Infinity'` | `false` | Not finite |
| `'42px'`, `'100%'`, `'1,000'`, `'3.14.15'`, `''`, `'   '` | `false` | Not a complete number |
| `true`, `false`, `null`, `undefined` | `false` | Neither number nor string |
| `[42]`, `{ value: 42 }`, `() => 42` | `false` | Non-primitive; no coercion |
| `BigInt(123)`, `Symbol('42')`, `new Number(42)` | `false` | Unsupported type; no throw |

---

### isString

Tests whether a value is a string primitive. The return type is a **type predicate**, so a single call both validates at runtime and narrows the argument's compile-time type.

**Signature**

```typescript
export function isString(value: unknown): value is string
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `value` | `unknown` | Yes | — | The value to test. |

**Returns**

`value is string` — a type predicate. `true` when the value is a string primitive (including `""`); `false` for everything else. Inside `if (isString(x))`, `x` is narrowed to `string`.

**Example**

```typescript
import { isString } from 'blendsdk/stdlib';

const input: unknown = 'hello';

if (isString(input)) {
    console.log(input.toUpperCase()); // → HELLO
}

console.log(isString(''));              // → true — empty string is a string
console.log(isString(String(42)));      // → true — String() returns a primitive
console.log(isString(42));              // → false
console.log(isString(new String('a'))); // → false — object wrapper
```

**Notes**

- Calling `String(x)` as a function returns a primitive and passes the check; `new String(x)` creates an object wrapper and fails it.
- The `String` constructor itself is not a string value: `isString(String)` returns `false`.

---

## Nullish Fallback

### isNullOrUndefDefault

Returns `defaultValue` when `value` is `null` or `undefined`, and `value` itself in every other case — the `??` operator exposed as a function so it can be used in callbacks, pipelines, and argument positions.

**Signature**

```typescript
export function isNullOrUndefDefault<ReturnType>(value: ReturnType, defaultValue: ReturnType): ReturnType
```

**Type Parameters**

| Type Parameter | Constraint | Description |
|----------------|------------|-------------|
| `ReturnType` | none | The shared type of `value`, `defaultValue`, and the return value. Inferred from the arguments; may be supplied explicitly: `isNullOrUndefDefault<string>(value, 'fallback')`. |

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `value` | `ReturnType` | Yes | — | The value to test. |
| `defaultValue` | `ReturnType` | Yes | — | The fallback returned when `value` is `null` or `undefined`. |

**Returns**

`ReturnType` — the original value when it is not nullish, otherwise the default value.

**Resolution Rules**

| Input `value` | Result |
|---------------|--------|
| `undefined` | `defaultValue` |
| `null` | `defaultValue` |
| `""`, `0`, `false`, `NaN`, any other value | The value itself (kept) |

**Example**

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

// Indexed lookups can be typed `string` yet yield `undefined` at runtime
const settings: Record<string, string> = { theme: 'dark' };

const theme: string = isNullOrUndefDefault(settings.theme, 'light');   // → 'dark'
const locale: string = isNullOrUndefDefault(settings.locale, 'en-US'); // → 'en-US'

// Only null/undefined trigger the fallback — all other values survive
console.log(isNullOrUndefDefault('', 'untitled')); // → '' (kept)
console.log(isNullOrUndefDefault(0, 5));           // → 0  (kept)
console.log(isNullOrUndefDefault(false, true));    // → false (kept)

console.log(theme, locale); // → dark en-US
```

**Notes**

- Only two values trigger substitution; unlike truthiness-based fallbacks (`value || fallback`), the falsy values `""`, `0`, `false` and `NaN` are preserved.
- Behavior matches the `??` operator exactly.
- Contrast with `formatString`, which treats `""` as missing for display purposes — the difference is intentional: formatting substitutes display text, this helper preserves data.

---

## Template Functions

### isTemplateString

Detects whether a string contains at least one well-formed `${...}` placeholder — the cheap pre-check to run before calling `formatString`.

**Signature**

```typescript
export function isTemplateString(value: string): boolean
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `value` | `string` | Yes | — | The string to check. |

**Returns**

`boolean` — `true` if at least one placeholder matching the `${key}`, `${key|default}`, `${path.to.key}` or `${path.to.key|default}` grammar is present; otherwise `false`. The check stops at the first match.

**Recognized Forms**

| Input | Returns | Why |
|-------|---------|-----|
| `'Hello ${name}'` | `true` | Simple placeholder |
| `'Hello ${name\|World}'` | `true` | Placeholder with default |
| `'${user.name}'` | `true` | Dot-notation path |
| `'${user.name\|Anonymous}'` | `true` | Path with default |
| `'${ name }'` | `true` | Whitespace around the key is tolerated |
| `'${name\|}'` | `true` | Empty default is valid |
| `'${}'`, `'${   }'` | `false` | A key path is required |
| `'Hello ${'` | `false` | Unclosed placeholder |
| `'$100'`, `'$name'`, `'$ {name}'` | `false` | No `${` sequence |
| `'{name}'`, `'Hello }'` | `false` | Braces without a preceding `$` |
| `'Hello world'`, `''` | `false` | No placeholder |

**Example**

```typescript
import { formatString, isTemplateString } from 'blendsdk/stdlib';

function render(template: string, params: Record<string, unknown>): string {
    return isTemplateString(template) ? formatString(template, params) : template;
}

console.log(render('Hello ${user.name|Guest}', { user: { name: 'Alice' } }));
// → Hello Alice

console.log(isTemplateString('${user.name}')); // → true
console.log(isTemplateString('${name|}'));     // → true — empty default is valid
console.log(isTemplateString('Hello world'));  // → false
console.log(isTemplateString('${}'));          // → false — key path required
console.log(isTemplateString('Broken ${ '));   // → false — unclosed
```

**Notes**

- **Syntactic check only** — it does not inspect params or verify that keys can be resolved. `'Hello ${missing}'` is `true`; whether the key resolves is `formatString`'s concern.
- **Input must be a `string`** — unlike the type predicates, the parameter is not typed `unknown`. Narrow untrusted values with `isString` first.

---

### formatString

Formats a template string by replacing every `${...}` placeholder with a value resolved from `params`. Supports simple keys, default values, and dot-notation lookups into nested objects. Unresolvable placeholders are kept visible in the output instead of throwing or collapsing to empty strings.

**Signature**

```typescript
export function formatString(template: string, params?: Record<string, unknown>): string
```

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `template` | `string` | Yes | — | Template text containing `${...}` placeholders. |
| `params` | `Record<string, unknown>` | No | `{}` | Values to substitute. Nested objects are resolved through dot-notation key paths. |

**Returns**

`string` — the template with every resolvable placeholder substituted; unresolvable placeholders appear unchanged.

**Placeholder Syntax**

| Form | Meaning | Example → Result |
|------|---------|------------------|
| `${key}` | Simple substitution | `formatString('${name}', { name: 'Alice' })` → `'Alice'` |
| `${key\|default}` | Substitution with a fallback | `formatString('${name\|Guest}', {})` → `'Guest'` |
| `${path.to.key}` | Nested lookup via dot-notation | `formatString('${user.name}', { user: { name: 'Alice' } })` → `'Alice'` |
| `${path.to.key\|default}` | Nested lookup with a fallback | `formatString('${user.name\|Guest}', { user: {} })` → `'Guest'` |
| `${ key }` | Whitespace around the key is tolerated | `formatString('${ name }', { name: 'Alice' })` → `'Alice'` |

**Resolution Rules**

| Situation | Result |
|-----------|--------|
| Value present — including `0` and `false` | Inserted as `String(value)` |
| Value is `""` and a default is provided | Default inserted |
| Value is `""` and no default is provided | Raw placeholder kept |
| Key missing, `null`, or `undefined` with a default (even an empty one, `${name\|}`) | Default inserted verbatim |
| Key missing, `null`, or `undefined` without a default | Raw placeholder kept, e.g. `${unknown}` |
| Dot path hits a `null`/`undefined` intermediate | Treated as missing — the rules above apply |
| `params` omitted entirely | Defaults still resolve; placeholders without defaults are kept |
| Template contains no `${` | Returned unchanged; `params` is ignored (fast path) |

**Example — Essentials**

```typescript
import { formatString } from 'blendsdk/stdlib';

// Simple substitution
console.log(formatString('Hello ${name}', { name: 'John' }));
// → Hello John

// Defaults work without any params object
console.log(formatString('Hello ${name|Guest}'));
// → Hello Guest

// A provided value overrides the default
console.log(formatString('Hello ${name|Guest}', { name: 'John' }));
// → Hello John

// Dot-notation resolves nested paths, with fallback support
console.log(
    formatString('${user.name} lives in ${user.address.city|Amsterdam}', {
        user: { name: 'Alice' }
    })
);
// → Alice lives in Amsterdam
```

**Example — Value Semantics and Edge Cases**

```typescript
import { formatString } from 'blendsdk/stdlib';

// Numbers and booleans are stringified — 0 and false are real values
console.log(formatString('${count} items, paid: ${paid}', { count: 0, paid: false }));
// → 0 items, paid: false

// "" is treated as missing — the default applies
console.log(formatString('Hello ${name|Guest}', { name: '' }));
// → Hello Guest

// "" without a default — the raw placeholder is kept
console.log(formatString('Hello ${name}', { name: '' }));
// → Hello ${name}

// Missing keys without a default keep their raw placeholder
console.log(formatString('Hello ${unknown}', { name: 'John' }));
// → Hello ${unknown}

// A nullish intermediate abandons the dot path
console.log(formatString('${user.address.city}', { user: null }));
// → ${user.address.city}

// An empty default resolves to an empty string
console.log(formatString('Hello${name|}!', { name: '' }));
// → Hello!

// Default text may contain special characters (but never "}")
console.log(formatString('Contact: ${email|no-reply@example.com}'));
// → Contact: no-reply@example.com
```

**Behavior Notes**

- **First pipe splits.** The expression inside `${...}` splits at the **first** `|`: the part before is the key (whitespace-trimmed), the part after is the default. The default is inserted verbatim — whitespace preserved — and may contain further `|` characters.
- **Key grammar.** Keys match `[\w.]+` — ASCII letters, digits, underscores, and dots. Hyphenated keys such as `${full-name}` do not match the placeholder grammar and are left in the text as-is.
- **No escaping.** There is no escape sequence for a literal `${...}`. A backslash is an ordinary character: at runtime, the string `\${name}` (written `'\\${name}'` in TypeScript source) becomes a backslash followed by the resolved value.
- **Fast path.** If the template does not contain `${` at all, it is returned unchanged and `params` is ignored entirely.
- **Params are optional.** Defaults still resolve without a params object; placeholders without defaults are preserved.
- **Fail-safe by design.** Unresolvable placeholders stay visible (`${unknown}`) instead of collapsing to empty strings — a missing binding shows up in the output instead of silently disappearing.
- **Stringification, not formatting.** Whatever resolves is passed through `String(value)`: numbers and booleans render naturally. For `Date` or object values, pass pre-formatted strings when presentation matters.
- **Different `""` semantics from `isNullOrUndefDefault`.** `formatString` treats `""` as missing, while `isNullOrUndefDefault` preserves `""`. This is intentional: formatting substitutes display text, fallback preserves data.

---

## Array Normalization

### wrapInArray

Normalizes a "single value, an array, or nothing" input into a guaranteed array. Returns a new empty array for `null`/`undefined`, the input array itself when it is already an array, and a single-element array for any other value.

**Signature**

```typescript
export function wrapInArray<T>(obj: unknown): T[]
```

**Type Parameters**

| Type Parameter | Constraint | Description |
|----------------|------------|-------------|
| `T` | none | The element type of the resulting array. Because `obj` is typed `unknown`, TypeScript cannot verify `T` against the runtime value — the assertion is made by the caller, intended for inputs whose element type is already established by the surrounding domain. |

**Parameters**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `obj` | `unknown` | Yes | — | The value to wrap. |

**Returns**

`T[]` — `[]` for nullish input, the same array reference for array input, `[obj]` otherwise.

**Normalization Rules**

| Input | Result |
|-------|--------|
| `undefined`, `null` | A new empty array `[]` |
| An array — empty, populated, nested, mixed | The same array reference, unchanged |
| Anything else — string, number, boolean, object, function, `Date`, `Map`, `Set`, array-like object | A new single-element array `[value]` |

**Example**

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
const tags: string[] = ['a', 'b'];
console.log(wrapInArray<string>(tags) === tags); // → true
```

**Notes**

- Arrays are returned **by reference** (`wrapInArray(arr) === arr`), so normalization is free for callers that already pass arrays. Spread the result yourself (`[...wrapInArray(value)]`) if you need a defensive copy.
- `Set`, `Map`, `arguments`-style objects and other array-likes are treated as single values and wrapped — not spread.
- The generic `T` is a declaration, not a runtime check: the parameter is `unknown`, so no validation is performed on the element type.

---

## Type Predicate Reference

Three of the package's functions return TypeScript type predicates: one call performs the runtime check and narrows the argument's compile-time type for the remainder of the scope.

| Function | Narrows argument to | Runtime test |
|----------|--------------------|--------------|
| `isString` | `string` | `typeof value === "string"` |
| `isBoolean` | `boolean` | `typeof value === "boolean"` |
| `isNullOrUndef` | `null \| undefined` | `value === null \|\| value === undefined` |

Narrowing applies in both directions: inside `if (isString(value))` the value is `string`, and after an early return for `if (isNullOrUndef(value)) return;` it is non-nullish.

The remaining functions do not narrow:

| Function | Return type | Why no narrowing |
|----------|-------------|------------------|
| `isNumeric` | `boolean` | A passing value may be a `number` or a numeric `string` — no single narrower type applies; convert explicitly with `Number(value)` |
| `isTemplateString` | `boolean` | Takes `string` directly; combine with `isString` for `unknown` input |
| `formatString` | `string` | Transformation, not a check |
| `isNullOrUndefDefault` | `ReturnType` | Passes a concrete value through or substitutes one |
| `wrapInArray` | `T[]` | The generic `T` is a caller-declared assertion over `unknown` input |

**Example — Narrowing in a Dispatch Function**

```typescript
import { isBoolean, isNullOrUndef, isString } from 'blendsdk/stdlib';

function stringify(value: unknown): string {
    if (isString(value)) {
        return value; // narrowed to string
    }
    if (isBoolean(value)) {
        return value ? 'yes' : 'no'; // narrowed to boolean
    }
    if (isNullOrUndef(value)) {
        return '(empty)'; // narrowed to null | undefined
    }
    return String(value);
}

console.log(stringify('hello')); // → hello
console.log(stringify(false));   // → no
console.log(stringify(null));    // → (empty)
console.log(stringify([1, 2]));  // → 1,2
```

---

## Source Modules

| Module | Public exports |
|--------|----------------|
| `src/formatString.ts` | `formatString` |
| `src/isBoolean.ts` | `isBoolean` |
| `src/isNullOrUndef.ts` | `isNullOrUndef`, `isNullOrUndefDefault` |
| `src/isNumeric.ts` | `isNumeric` |
| `src/isString.ts` | `isString` |
| `src/isTemplateString.ts` | `isTemplateString` |
| `src/wrapInArray.ts` | `wrapInArray` |
| `src/index.ts` | Barrel entry point — re-exports every module above |

`wrapInArray` is the only module with an internal dependency — it imports `isNullOrUndef` from `./isNullOrUndef.js`; every other module is self-contained. All symbols above are the package's complete public API: there are no exported classes, interfaces, enums, or constants.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
