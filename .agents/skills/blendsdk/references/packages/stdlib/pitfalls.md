> **Package**: `blendsdk/stdlib`

# stdlib Best Practices

`blendsdk/stdlib` is deliberately small: eight pure functions, no runtime dependencies, no configuration. Nearly every mistake made with it comes from asking a function to do something it was designed *not* to do — coerce a value, test truthiness, evaluate a template. Each function does one narrow thing exactly, and the rules below are pinned down by the package's own test suite.

| Intent | Reach for | Avoid |
| --- | --- | --- |
| Test whether data is missing | `isNullOrUndef` | truthiness (`if (value)`) |
| Substitute a fallback value | `isNullOrUndefDefault` | `\|\|` |
| Validate numeric input | `isNumeric` + `Number(...)` | `parseFloat`, raw `Number(...)` coercion |
| Detect `${...}` placeholders | `isTemplateString` | `includes('${')` |
| Render parameterized text | `formatString` with `\|default` | manual `replace` loops, template engines |
| Normalize value-or-array input | `wrapInArray` | manual `Array.isArray` branching |

**Sections**: [Do / Don't Pairs](#do--dont-pairs) · [Anti-Patterns](#anti-patterns) · [Performance Tips](#performance-tips) · [Security Considerations](#security-considerations)

Companion documents: Overview and Core Concepts.

---

## Do / Don't Pairs

Each pair states one rule, shows the mistake, shows the fix, and explains why. All snippets are ESM (`import`) because the package is ESM-only.

### 1. Test missing data with `isNullOrUndef`, never with truthiness

❌ Wrong:

```typescript
function renderCount(count: number | undefined): string {
    if (count) {
        return `${count} items`;
    }
    return 'no items';
}

console.log(renderCount(0)); // → 'no items' — 0 is a real count!
```

✅ Correct:

```typescript
import { isNullOrUndef } from 'blendsdk/stdlib';

function renderCount(count: number | undefined): string {
    if (!isNullOrUndef(count)) {
        return `${count} items`; // count: number — narrowed by the predicate
    }
    return 'no items';
}

console.log(renderCount(0));         // → '0 items'
console.log(renderCount(undefined)); // → 'no items'
```

**Why**: `0`, `""`, `false` and `NaN` are falsy but perfectly valid values, so `if (count)` silently discards them. `isNullOrUndef` tests exactly the two absent values, and because it is a type predicate it narrows `count` to `number` inside the branch — no cast or non-null assertion needed. `if (count)` answers "is this truthy?", not "did the caller supply a value?".

### 2. Fall back with `isNullOrUndefDefault`, not `||`

❌ Wrong:

```typescript
const settings: Record<string, number> = { retries: 0 };
const retries = settings['retries'] || 3;
console.log(retries); // → 3 — the configured 0 was silently replaced
```

✅ Correct:

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

const settings: Record<string, number> = { retries: 0 };

const retries: number = isNullOrUndefDefault(settings['retries'], 3);
const timeout: number = isNullOrUndefDefault(settings['timeout'], 3000);

console.log(retries); // → 0 — falsy but present, preserved
console.log(timeout); // → 3000 — typed `number`, missing at runtime, replaced
```

**Why**: `||` replaces every falsy value; the helper replaces only `null` and `undefined` — the same semantics as `??`, but callable as a function and typed to its input. It shines exactly where an index signature promises a value the runtime may not deliver (`settings['timeout']` is typed `number` yet is `undefined` when absent). One nuance: when the input's *static* type includes nullish (`string | undefined`), the returned type keeps that union — use an `isNullOrUndef` guard when you need the compiler to narrow.

### 3. Validate numerics with `isNumeric`, not `parseFloat` or `Number` coercion

❌ Wrong:

```typescript
function toQuantity(value: string): number {
    return Number(value); // '' → 0, '   ' → 0
}

console.log(toQuantity('')); // → 0 — blank input became a real quantity
```

The same class of bug shows up with `parseFloat('42px') // → 42` (silent prefix truncation) and with the global `isNaN('')`, which coerces `""` to `0` before testing.

✅ Correct:

```typescript
import { isNumeric } from 'blendsdk/stdlib';

function toQuantity(value: unknown): number {
    if (!isNumeric(value)) {
        throw new Error(`Not a numeric value: ${String(value)}`);
    }
    return Number(value); // explicit conversion after validation
}

console.log(toQuantity('42'));   // → 42
console.log(toQuantity(' 42 ')); // → 42
// toQuantity('') throws — blank input is not a number
```

**Why**: `isNumeric` requires the input to be a finite number or a trimmed string that is a *complete* JavaScript numeric literal — `'42px'`, `'1,000'`, `'3.14.15'`, `''`, `NaN`, `Infinity`, arrays and objects are all rejected, and nothing is ever coerced or thrown. Because it returns `boolean` (not `value is number`) — a valid value may be a number *or* a string — you always convert explicitly with `Number(...)` after the check.

### 4. Narrow with the guards, not with `as` or `!`

❌ Wrong:

```typescript
function normalizeLabel(input: string | null | undefined): string {
    return input!.trim(); // `!` changes what the compiler believes, not the runtime
}

normalizeLabel(null); // → TypeError: Cannot read properties of null (reading 'trim')
```

✅ Correct:

```typescript
import { isNullOrUndef } from 'blendsdk/stdlib';

function normalizeLabel(input: string | null | undefined): string {
    if (isNullOrUndef(input)) {
        return 'untitled';
    }
    return input.trim().toLowerCase(); // input: string — real narrowing
}

console.log(normalizeLabel(null));    // → 'untitled'
console.log(normalizeLabel('Alice')); // → 'alice'
```

**Why**: `as` and `!` are compile-time-only assertions — they suppress the error and trade it for a runtime crash on precisely the input a guard would have caught. The predicates perform a real runtime check and narrow the static type in the same expression. Because they are ordinary functions, they also compose with array methods: `values.filter(isString)` yields a genuinely narrow `string[]`.

### 5. Give every optional placeholder a default

❌ Wrong:

```typescript
import { formatString } from 'blendsdk/stdlib';

const greeting = 'Hello ${user.name}, welcome back!';
console.log(formatString(greeting, { user: {} }));
// → 'Hello ${user.name}, welcome back!' — the raw placeholder leaks into the output
```

✅ Correct:

```typescript
import { formatString } from 'blendsdk/stdlib';

const greeting = 'Hello ${user.name|Guest}, welcome back!';
console.log(formatString(greeting, { user: {} }));
// → 'Hello Guest, welcome back!'
```

**Why**: `formatString` never throws and never blanks an unresolved key — by design it leaves the raw `${...}` visible so gaps surface in development instead of shipping as empty text. In user-facing output that raw placeholder *is* the bug: recipients see `${user.name}`, and it reveals your internal key names. Every optional value rendered into a template should carry a `|default`. Conversely, do not try to catch missing params with `try`/`catch` — there is no error to catch.

### 6. Respect the template's `""`-is-missing rule (and its difference from `isNullOrUndefDefault`)

❌ Wrong:

```typescript
import { formatString } from 'blendsdk/stdlib';

const signature: string = '';
// With no default, an empty value echoes the placeholder instead of rendering nothing:
console.log(formatString('Signature: ${signature}', { signature }));
// → 'Signature: ${signature}'
```

✅ Correct:

```typescript
import { formatString, isNullOrUndefDefault } from 'blendsdk/stdlib';

const signature: string = '';

// Rendering: choose what "missing" looks like — a default…
console.log(formatString('Signature: ${signature|none}', { signature }));
// → 'Signature: none'

// …or nothing, via an intentionally empty default
console.log(formatString('Signature: ${signature|}', { signature }));
// → 'Signature: '

// Data: "" is a real value — isNullOrUndefDefault preserves it
const preserved: string = isNullOrUndefDefault(signature, 'none');
console.log(preserved); // → ''
```

**Why**: `formatString` is the *rendering* helper, so `""` counts as "nothing to display": the placeholder falls through to its default, or stays raw when there is no default — `${key|}` is the idiom for rendering nothing. `isNullOrUndefDefault` is the *data* helper: it substitutes only `null`/`undefined`, so `""`, `0` and `false` survive. Pick the helper that matches the intent. (Only `""` is special in templates — `0` and `false` render normally — and defaults are inserted verbatim, spaces included, so `${key| Guest }` adds literal padding.)

### 7. Detect placeholders with `isTemplateString`, not substring checks

❌ Wrong:

```typescript
function needsRendering(template: string): boolean {
    return template.includes('${'); // true for malformed fragments like '${}' or '${'
}
```

✅ Correct:

```typescript
import { isTemplateString } from 'blendsdk/stdlib';

function needsRendering(template: string): boolean {
    return isTemplateString(template);
}

console.log(needsRendering('Hello ${name}')); // → true
console.log(needsRendering('Hello ${name'));  // → false — unclosed brace
console.log(needsRendering('Hello ${}'));     // → false — no key path
```

**Why**: `isTemplateString` tests the same grammar `formatString` uses to *recognize* placeholders, so detection and formatting can never disagree about what a placeholder is; a substring search reports `true` for sequences the formatter would leave untouched. Keep in mind the check is syntactic, not semantic: `'${missing}'` returns `true` even though nothing may resolve at format time. For plain rendering you often don't need the check at all — `formatString` already fast-paths strings without `"${"` (see [Performance Tips](#performance-tips)).

### 8. Normalize with `wrapInArray`, but convert other iterables first

❌ Wrong:

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

const regions = wrapInArray<string>(new Set(['eu', 'us']));
console.log(regions); // → [ Set(2) { 'eu', 'us' } ] — one element, mistyped as string
```

✅ Correct:

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

function normalizeRegions(input: string | string[] | undefined): string[] {
    return wrapInArray<string>(input);
}

console.log(normalizeRegions(undefined));    // → []
console.log(normalizeRegions('eu'));         // → [ 'eu' ]
console.log(normalizeRegions(['eu', 'us'])); // → [ 'eu', 'us' ]

// For Sets, Maps and other iterables, convert to an array first
const regionSet: string[] = Array.from(new Set(['eu', 'us']));
console.log(regionSet); // → [ 'eu', 'us' ]
```

**Why**: `wrapInArray` recognizes exactly three cases — `null`/`undefined` → `[]`, array → that same array, anything else → `[value]`. Sets, array-like objects and class instances fall into "anything else" and are wrapped whole, not spread. And remember the `<T>` is an assertion you make, not a runtime check: the parameter is `unknown`, so only apply it to data whose element type the surrounding code already guarantees.

### 9. Import from the package root, not internal files

❌ Wrong:

```typescript
import { formatString } from 'blendsdk/stdlib/dist/formatString.js';
```

✅ Correct:

```typescript
import { formatString, isNumeric, wrapInArray } from 'blendsdk/stdlib';
```

**Why**: The package's `exports` map exposes a single entry — `"."`. Deep paths are not part of the published contract and fail to resolve in Node's ESM resolver and in bundlers. Root imports are also what makes tree-shaking work perfectly: the package has no side effects and named exports only, so only the functions you actually reference survive into your bundle.

---

## Anti-Patterns

These mistakes recur in integration code and in ports of older codebases; each one is grounded in behavior the test suite pins down.

### 1. Comparing against the *string* `"undefined"`

Since the 5.x line, `'undefined'` is a legitimate string value — a deliberate breaking change from earlier behavior. `isNullOrUndef('undefined')` is `false`, `wrapInArray('undefined')` is `['undefined']`, and `isNullOrUndefDefault('undefined', 'default')` returns `'undefined'`.

❌ Wrong:

```typescript
function present(value: unknown): boolean {
    return value !== 'undefined' && value !== 'null';
}

console.log(present(undefined));   // → true — the absent value slipped through
console.log(present('undefined')); // → false — a real string judged absent
```

✅ Correct:

```typescript
import { isNullOrUndef } from 'blendsdk/stdlib';

function present(value: unknown): boolean {
    return !isNullOrUndef(value);
}

console.log(present(undefined));   // → false
console.log(present(null));        // → false
console.log(present('undefined')); // → true — a real string, treated as such
```

**Why**: String sentinels conflate a value with its printed form: they misjudge the string `'undefined'`, mishandle `null`, and allocate a converted copy of every value they see (`String(value)`). Compare the value itself — never a stringified reproduction of it.

### 2. Expecting guards to convert — or to accept wrappers

❌ Wrong:

```typescript
import { isBoolean } from 'blendsdk/stdlib';

// process.env values are strings — this check can never succeed
const debug: unknown = process.env.DEBUG;
if (isBoolean(debug)) {
    console.log('verbose logging on'); // unreachable for 'true'
}

// Object wrappers are objects, not primitives
console.log(isBoolean(new Boolean(true))); // → false
```

✅ Correct:

```typescript
const raw: string | undefined = process.env.DEBUG;
const debug: boolean = raw === 'true'; // parse explicitly

console.log(`debug: ${debug}`); // → 'debug: false' (or 'debug: true')
```

**Why**: Every guard is a pure, non-coercing *kind* test: `isBoolean('true')` is `false`, `isString(42)` is `false`, and `new Boolean(true)`, `new String('x')`, `new Number(42)` all fail because `typeof` reports `'object'` for wrappers. Values from `process.env`, query strings, forms and JSON text arrive as strings — parse them into the target type yourself. Guards tell you what a value *is*, not how to make it what you want. Never construct object wrappers; in modern TypeScript they only create `typeof` mismatches.

### 3. Assuming `isNumeric` narrows the type

❌ Wrong:

```typescript
import { isNumeric } from 'blendsdk/stdlib';

function formatTax(value: unknown): string {
    if (isNumeric(value)) {
        // `as` hides the fact that value may still be a string
        return (value as number).toFixed(2);
    }
    return '0.00';
}

console.log(formatTax('100')); // → TypeError: value.toFixed is not a function
```

✅ Correct:

```typescript
import { isNumeric } from 'blendsdk/stdlib';

function formatTax(value: unknown): string {
    if (!isNumeric(value)) {
        return '0.00';
    }
    return Number(value).toFixed(2); // convert after validating
}

console.log(formatTax('100')); // → '100.00'
```

**Why**: Success can mean a number (`100`) or a string (`'100'`), so `isNumeric` returns `boolean`, not `value is number`, and TypeScript cannot narrow. Validating and converting are two steps: gate with `isNumeric`, then apply `Number(value)`. The runtime hazard is real — `'100'.toFixed` is `undefined`, so the asserted call throws.

### 4. Assuming `isNumeric` means "decimal digits only"

❌ Wrong:

```typescript
import { isNumeric } from 'blendsdk/stdlib';

function isUserId(value: string): boolean {
    return isNumeric(value);
}

console.log(isUserId('0x10')); // → true — hex
console.log(isUserId('1e3'));  // → true — scientific notation
console.log(Number('0x10'));   // → 16, not 10
```

✅ Correct:

```typescript
import { isNumeric } from 'blendsdk/stdlib';

const DIGITS_ONLY = /^\d+$/;

// For identifiers, the domain grammar alone is the right check
function isUserId(value: string): boolean {
    return DIGITS_ONLY.test(value);
}

// When the value must be a finite number AND match a stricter shape,
// layer both checks and convert explicitly afterwards
function toQuantity(value: unknown): number {
    if (!isNumeric(value) || !DIGITS_ONLY.test(String(value))) {
        throw new Error(`Invalid quantity: ${String(value)}`);
    }
    return Number(value);
}

console.log(isUserId('0x10'));  // → false
console.log(toQuantity('007')); // → 7
```

**Why**: `isNumeric` validates any *complete JavaScript numeric literal*: scientific notation, hex/octal/binary prefixes, leading `+`, leading zeros and leading-dot forms are deliberately accepted. When the domain needs a narrower grammar — identifiers, ports, PINs, counts — layer a digits/range check on top. See [Security Considerations](#security-considerations) for the validation recipe.

### 5. Treating `formatString` as a template engine

❌ Wrong:

```typescript
import { formatString } from 'blendsdk/stdlib';

// Expressions are not part of the grammar — this stays untouched:
console.log(formatString('Total: ${price * quantity}', { price: 2, quantity: 3 }));
// → 'Total: ${price * quantity}'
```

✅ Correct:

```typescript
import { formatString } from 'blendsdk/stdlib';

const price = 2;
const quantity = 3;

// Compute derived values in TypeScript and substitute simple keys
console.log(formatString('Total: ${total}', { total: price * quantity }));
// → 'Total: 6'
```

**Why**: The placeholder grammar is deliberately tiny — keys are word characters and dots (`[\w.]`), plus an optional default after the first `|`. No operators, function calls, conditionals or quoted literals exist, and there is no escape syntax: a backslash is ordinary text and the placeholder after it still resolves. That limitation is the feature — templates are data, never code — so anything computed belongs in TypeScript, passed in as a finished value.

### 6. Forgetting that placeholder lookups walk the prototype chain

❌ Wrong:

```typescript
import { formatString } from 'blendsdk/stdlib';

// The params object inherits from Object.prototype…
console.log(formatString('${constructor.name}', {})); // → 'Object'
console.log(formatString('${toString}', {}));
// → 'function toString() { [native code] }'
```

✅ Correct:

```typescript
import { formatString, isTemplateString } from 'blendsdk/stdlib';

const allowedKeys = new Set(['name', 'email']);

function renderUserTemplate(template: string, params: Record<string, string>): string {
    if (!isTemplateString(template)) {
        return template;
    }
    for (const match of template.matchAll(/\$\{\s*(?<key>[\w.]+)/g)) {
        const key = match.groups?.['key'];
        if (key === undefined || !allowedKeys.has(key)) {
            throw new Error('Template contains a disallowed key');
        }
    }
    return formatString(template, params);
}

console.log(renderUserTemplate('Hi ${name}!', { name: 'Alice' }));
// → 'Hi Alice!'

try {
    renderUserTemplate('${constructor.name}', { name: 'Alice' });
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    // → 'Template contains a disallowed key'
}
```

**Why**: `formatString` resolves keys with plain property access, so a key that is not an own property can still be found on the prototype chain — `${constructor}`, `${__proto__}` and `${toString}` render inherited members, and `${constructor}` renders native function source text. For developer-authored templates that is harmless noise; for user-supplied templates it is an exposure surface. Allowlist the keys a template may reference, and pass a params object containing only display-safe values.

### 7. Mutating — or trusting — the result of `wrapInArray`

❌ Wrong:

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

// It is the same array reference, not a copy:
const original: string[] = ['b'];
const normalized = wrapInArray<string>(original);
normalized.push('a');
console.log(original); // → [ 'b', 'a' ] — the caller's array was mutated

// And the generic is an assertion, not a validation:
const payload: unknown = JSON.parse('{"name":"Alice"}');
const items = wrapInArray<string>(payload);
console.log(items); // → [ { name: 'Alice' } ] typed as string[]
```

✅ Correct:

```typescript
import { isString, wrapInArray } from 'blendsdk/stdlib';

// Copy when you intend to mutate
const original: string[] = ['b'];
const copy: string[] = [...wrapInArray<string>(original)];
copy.push('a');

console.log(original); // → [ 'b' ]
console.log(copy);     // → [ 'b', 'a' ]

// Validate before trusting an element type
const payload: unknown = JSON.parse('{"name":"Alice"}');
const candidates: unknown[] = wrapInArray<unknown>(payload);
const names: string[] = candidates.filter(isString);

console.log(names); // → []
```

**Why**: For an array input, `wrapInArray` returns that very array (`wrapInArray(arr) === arr`) — normalization is intentionally zero-copy, so the result is not yours to mutate; spread it first when ownership is needed. And the generic parameter is an unchecked promise: it lets typed domain data flow without friction, but it cannot make raw external data safe. Validate external values first — for example by filtering with the guards.

---

## Performance Tips

The package is engineered around a few sharp fast paths; most performance work is about not defeating them.

### 1. Rely on `formatString`'s built-in fast path

Plain strings return immediately: `formatString` first checks `template.includes('${')` — a single, allocation-free scan — and only runs the regex replacement when a placeholder marker is present. You do not need to pre-filter with `isTemplateString` "for speed"; one call site stays correct for both plain and templated text:

```typescript
import { formatString } from 'blendsdk/stdlib';

const lines: string[] = ['Server started', 'Listening on ${host}:${port}'].map((line) =>
    formatString(line, { host: 'localhost', port: 3000 })
);

console.log(lines); // → [ 'Server started', 'Listening on localhost:3000' ]
```

Reserve `isTemplateString` for when code must make a *semantic* decision (validation, UI flags), not as a per-render guard.

### 2. Let `isNumeric` validate numbers — don't hand-roll number regexes

`isNumeric` is implemented with engine primitives: a `typeof` check plus `Number.isFinite` for numbers, and `trim` + unary `+` + `Number.isFinite` for strings. No regex compilation, no intermediate allocations, no throw paths. A regex that recognizes every JavaScript numeric literal is both slower per call and famously error-prone. Keep bespoke patterns for bespoke grammars (digits-only IDs) and delegate "is this a number?" entirely:

```typescript
import { isNumeric } from 'blendsdk/stdlib';

console.log(isNumeric(' 1.5e-10 ')); // → true — trimmed, converted, checked finite
console.log(isNumeric('42px'));      // → false — no partial parses
```

### 3. Use non-global regexes for `.test()`, and never share a stateful one

A global (`g`) regex keeps `lastIndex` between `.test()`/`.exec()` calls, so a module-level pattern alternates answers — a correctness bug that also restarts scans unpredictably. `isTemplateString` uses a deliberately non-global pattern because it only needs "does at least one match exist?":

```typescript
// ❌ Shared global regex + test(): lastIndex makes results alternate
const PLACEHOLDER = /\$\{[\w.]+\}/g;

console.log(PLACEHOLDER.test('${a}')); // → true
console.log(PLACEHOLDER.test('${b}')); // → false (second scan starts at lastIndex)
console.log(PLACEHOLDER.test('${c}')); // → true

// ✅ Stateless check — or use the package's own detector
import { isTemplateString } from 'blendsdk/stdlib';

console.log(isTemplateString('${a}')); // → true
console.log(isTemplateString('${b}')); // → true — stateless, compiled once at module load
```

The rule to mirror in your own code: `g` only for APIs that iterate all matches (`replace`, `matchAll`); boolean checks use a bare pattern compiled once at module scope.

### 4. Use the guards directly as array predicates

The guards are minimal `typeof`/equality tests — no allocation, no prototype walking (unlike `instanceof` or `Object.prototype.toString` checks). Passing the imported function straight into `filter`/`find`/`every` is both the fastest and the most type-friendly form:

```typescript
import { isString } from 'blendsdk/stdlib';

const values: unknown[] = ['a', 1, 'b', null, 'c', {}];
const strings: string[] = values.filter(isString); // narrowed to string[]

console.log(strings); // → [ 'a', 'b', 'c' ]
```

One `typeof` per element is about as cheap as validation gets; `Object.prototype.toString.call(value) === '[object String]'` allocates a string per element instead.

### 5. Validate once at the boundary, then trust the narrowed types

Guards are cheap, but running them repeatedly deep in hot paths — per render, per row, per request handler — multiplies work and scatters logic. Normalize incoming data once, right where it enters, so downstream code works with plain typed values:

```typescript
import { isNumeric, isString } from 'blendsdk/stdlib';

const rawRows: unknown[][] = [['A-1', '12.5'], ['A-2', 7]];

const rows: Array<{ id: string; qty: number }> = [];
for (const row of rawRows) {
    const [id, qty] = row;
    if (isString(id) && isNumeric(qty)) {
        rows.push({ id, qty: Number(qty) });
    }
}

console.log(rows); // → [ { id: 'A-1', qty: 12.5 }, { id: 'A-2', qty: 7 } ]
```

### 6. Don't copy what `wrapInArray` passes through

When the input is already an array, the function returns that reference — zero allocation. Defensive copying (`[...wrapInArray(input)]`, `Array.from(...)`) at normalization time defeats the fast path; copy only at the point where you actually intend to mutate:

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

const plugins: string[] = ['logger', 'cache'];
console.log(wrapInArray<string>(plugins) === plugins); // → true — no copy, no allocation
```

Otherwise the cost is one small array: `[]` for nullish input, `[value]` for a single value. That is the intended price of normalization.

### 7. Pass raw values to `formatString` — conversion happens per resolved placeholder

`formatString` calls `String(value)` only for placeholders that actually appear in the template; entries in the params object that are never referenced are never converted. Pre-stringifying a large params bag (or `JSON.stringify`-ing values) eagerly converts what may never be used:

```typescript
import { formatString } from 'blendsdk/stdlib';

const params: Record<string, unknown> = { count: 42, internalId: 'A-1', debug: false };

// Only ${count} exists in the template — the other params are never converted
console.log(formatString('${count} items', params)); // → '42 items'
```

Pass values raw, including numbers and booleans; pre-format only when presentation requires it (dates, currency, locale).

---

## Security Considerations

stdlib performs no I/O, executes no code, and ships no runtime dependencies — the security-relevant surface is what you build with its output and how you validate data before converting it.

### 1. Escape output for its destination

`formatString` inserts values verbatim: no HTML, URL, SQL or shell escaping, and template text is never evaluated (pure regex substitution plus `String(value)` — no `eval`, no dynamic compilation). Treat the result as *untrusted* whenever any value is untrusted, and encode for the destination at the point of use. Keep the template trusted (developer-authored) and escape the values — that preserves intentional markup while neutralizing payloads:

```typescript
import { formatString } from 'blendsdk/stdlib';

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

const userName = '<script>alert(1)</script>';
const html = formatString('<p>Hello ${name}</p>', { name: escapeHtml(userName) });

console.log(html);
// → '<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>'
```

### 2. Keep templates and params under your control

Two behaviors shape the exposure model: unresolved placeholders echo their key names back into the output, and lookups resolve inherited properties (see [Anti-Patterns #6](#6-forgetting-that-placeholder-lookups-walk-the-prototype-chain)). If end users can author templates, allowlist the keys they may reference, and build params as a fresh, dedicated object containing only display-safe values — never the same bag that holds tokens, secrets or internal identifiers. If end users cannot author templates, none of this is reachable: keys are fixed at development time.

### 3. Enforce the real grammar for security-relevant numbers

`isNumeric` is a strict *number* check, not an *identifier* check: `'0x50'` (hex), `'1e3'` (scientific), `'0b1010'`, `'.5'` and `'007'` all pass, and `Number()` converts them faithfully — `'0x50'` becomes 80, not the "50" a human expects from a port field. For security-sensitive numeric input, add the domain grammar and a range on top:

```typescript
import { isNumeric } from 'blendsdk/stdlib';

const DIGITS_ONLY = /^\d+$/;

function parsePort(value: unknown): number {
    if (!isNumeric(value) || !DIGITS_ONLY.test(String(value))) {
        throw new Error(`Invalid port: ${String(value)}`);
    }
    const port = Number(value);
    if (port < 1 || port > 65535) {
        throw new Error(`Port out of range: ${port}`);
    }
    return port;
}

console.log(parsePort('3000')); // → 3000
// parsePort('0x50') throws — hex is numeric, but not a decimal port
```

A positive property to note: `isNumeric` rejects `NaN` and `Infinity`, so arithmetic gated by it never receives a non-finite value.

### 4. Choose fail-closed defaults

Fallbacks are your safety net, so make them the restrictive choice for security-relevant settings — a missing role must degrade to `'guest'`, never to elevated access:

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

const account: Record<string, string> = {};

const role: string = isNullOrUndefDefault(account['role'], 'guest');
console.log(role); // → 'guest' — least privilege, not undefined leaking onward
```

### 5. Validate before you assert

`wrapInArray<T>`, `as` and `!` are compile-time promises; for data crossing a trust boundary (HTTP payloads, config files, IPC) assert nothing — confirm with the guards (`isString`, `isBoolean`, `isNullOrUndef`, `isNumeric`) and filter or convert. A wrong `T` is not a typing inconvenience; it is how type confusion becomes a runtime crash or bypassed check logic once property access and method calls start happening on values of an unexpected shape.

**Why the surface stays small**: zero runtime dependencies (nothing third-party enters your graph through this package), no dynamic evaluation (templates and values are data, never code), fail-safe formatting (unresolved placeholders stay visible instead of silently disappearing), and guards that never throw — even exotic values such as `Symbol` and `BigInt` are classified as `false` rather than raising.

---

---

# stdlib Testing Patterns

`blendsdk/stdlib` is a zero-dependency collection of synchronous, side-effect-free functions. Every export is a pure transformation from input to output, which makes testing delightfully simple: there is no environment to configure, no Docker container to start, no network to stub, and — in almost every case — nothing worth mocking.

This document shows how to test code that uses the package. All patterns are derived from the package's own Vitest suites in `tests/`, which are the source of truth for the behavioral contracts.

1. [Test Setup](#test-setup)
2. [Unit Testing](#unit-testing)
3. [Integration Testing](#integration-testing)
4. [Mocking & Stubbing](#mocking--stubbing)
5. [Test Patterns by Feature](#test-patterns-by-feature)

---

## Test Setup

### Requirements

| Requirement | Value | Notes |
| --- | --- | --- |
| Node.js | >= 22.0.0 | The package is ESM-only (`"type": "module"`) |
| Test runner | Vitest ^4.1.10 | The framework used by the package's own suites |
| Coverage | `@vitest/coverage-v8` ^4.1.10 | v8 provider, used by `test:coverage` |
| TypeScript | strict mode | Consumer tests should compile under `"strict": true` |
| Docker | **None** | No containers, no databases, no external services |
| Setup files | **None** | No global setup, no teardown, no DOM environment |

### Running the Package's Test Suites

The package defines its test scripts in `package.json`:

| Script | Command | Use |
| --- | --- | --- |
| `test` | `vitest run --reporter=verbose` | One-shot run of every suite |
| `test:watch` | `vitest watch --reporter=verbose` | Re-run affected tests on change |
| `test:coverage` | `vitest run --coverage` | One-shot run with v8 coverage |

```bash
cd packages/stdlib
npm test
npm run test:watch
npm run test:coverage
```

Vitest accepts filename filters as positional arguments, so a single suite can be run by extending the `test` script:

```bash
npm test -- tests/format-string.test.ts
```

No `vitest.config.ts` is required — there is no browser environment, no global setup file, and no path aliasing. Suites are discovered with Vitest's defaults (`**/*.test.ts`).

### Test Framework Configuration

A consumer project that wants explicit test and coverage settings can add a minimal configuration:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html']
        }
    }
});
```

The consumer project itself must be ESM-capable and compile in strict mode:

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

Add `"type": "module"` to `package.json` so test files are treated as ESM. The package's `exports` map exposes only `types` and `import` conditions, so `require()` cannot load it.

### Required Imports

Consumer tests import everything from the package root:

```typescript
import { describe, expect, it } from 'vitest';
import { formatString, isString } from 'blendsdk/stdlib';
```

The package's own tests import modules directly from source (`../src/formatString.js`) so coverage maps 1:1 to the implementation files. The `.js` extension is mandatory there because relative imports are resolved with Node's ESM (`NodeNext`) rules. Consumers never need it — the `exports` map resolves `blendsdk/stdlib` for them.

### Test File Layout

The package colocates one test file per source module in `tests/`:

| Test file | Module under test |
| --- | --- |
| `tests/format-string.test.ts` | `src/formatString.ts` |
| `tests/is-template-string.test.ts` | `src/isTemplateString.ts` |
| `tests/isBoolean.test.ts` | `src/isBoolean.ts` |
| `tests/isNullOrUndef.test.ts` | `src/isNullOrUndef.ts` |
| `tests/isNumeric.test.ts` | `src/isNumeric.ts` |
| `tests/isString.test.ts` | `src/isString.ts` |
| `tests/wrapInArray.test.ts` | `src/wrapInArray.ts` |

### Test Helpers

Because the functions are pure, helpers are small one-liners that remove repetition from consumer suites. The following module compiles under strict mode with no casts:

```typescript
// tests/helpers.ts
import { expect } from 'vitest';
import { formatString, isString } from 'blendsdk/stdlib';

/** Returns the value when it is a string; throws a TypeError otherwise. */
export function asString(value: unknown, label = 'value'): string {
    if (!isString(value)) {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

/** Asserts that a template renders to an exact expected string. */
export function expectFormatted(
    template: string,
    params: Record<string, unknown> | undefined,
    expected: string
): void {
    expect(formatString(template, params)).toBe(expected);
}

/** Asserts that a template renders unchanged — every placeholder is kept. */
export function expectKept(template: string, params?: Record<string, unknown>): void {
    expect(formatString(template, params)).toBe(template);
}
```

Usage in a suite:

```typescript
import { describe, it } from 'vitest';
import { asString, expectFormatted, expectKept } from './helpers.js';

describe('message rendering', () => {
    it('should render a default through the helper', () => {
        expectFormatted('Hello ${name|Guest}', {}, 'Hello Guest');
    });

    it('should keep an unresolved placeholder through the helper', () => {
        expectKept('Status: ${status}', { code: 200 });
    });

    it('should narrow unknown input through the helper', () => {
        const raw: unknown = 'Alice';
        expectFormatted('Hello ${name}', { name: asString(raw, 'name') }, 'Hello Alice');
    });
});
```

---

## Unit Testing

Every stdlib export is a synchronous pure function, so a unit test is just: build the input, call the function, assert the output. The package's suites follow one consistent shape — nested `describe` blocks per behavior category ("simple substitution", "default values", "edge cases") with one `it` per case. Mirror that structure in your own suites and failures will read like a specification.

### Testing Synchronous Code

Wrap the stdlib call in a small consumer function and test both the happy path and the value-preservation edge cases (here: that the number `0` is rendered, not treated as missing):

```typescript
import { describe, expect, it } from 'vitest';
import { formatString } from 'blendsdk/stdlib';

type LineItem = {
    sku: string;
    quantity: number;
    price: number;
};

function formatLineItem(item: LineItem): string {
    return formatString('${quantity} × ${sku} @ ${price}', item);
}

describe('formatLineItem', () => {
    it('should render quantity, sku and price', () => {
        expect(formatLineItem({ sku: 'A-100', quantity: 2, price: 9.5 })).toBe('2 × A-100 @ 9.5');
    });

    it('should keep a zero quantity visible instead of treating it as missing', () => {
        expect(formatLineItem({ sku: 'A-100', quantity: 0, price: 9.5 })).toBe('0 × A-100 @ 9.5');
    });
});
```

### Testing Type Narrowing

`isString`, `isBoolean` and `isNullOrUndef` are type predicates. A test that uses the narrowed value in a type-specific way doubles as a compile-time contract: if narrowing ever broke, the test file would fail to compile.

```typescript
import { describe, expect, it } from 'vitest';
import { isNullOrUndef, isString } from 'blendsdk/stdlib';

function trimToUpper(value: unknown): string {
    if (!isString(value)) {
        throw new TypeError('expected a string');
    }
    return value.trim().toUpperCase(); // `value` is `string` — narrowing holds
}

describe('type narrowing contracts', () => {
    it('should return the normalized string for string input', () => {
        expect(trimToUpper('  hello  ')).toBe('HELLO');
    });

    it('should throw for non-string input', () => {
        expect(() => trimToUpper(42)).toThrow(TypeError);
    });

    it('should narrow string | undefined with a negated nullish check', () => {
        const candidates: Array<string | undefined> = ['alpha', undefined, 'beta'];

        const defined = candidates.filter((value): value is string => !isNullOrUndef(value));

        expect(defined).toEqual(['alpha', 'beta']);
    });
});
```

For explicit type-level assertions, Vitest supports `expectTypeOf` in dedicated type-test files (`*.test-d.ts`). These are validated when type checking runs (`vitest --typecheck` or your project's `tsc`), not at runtime:

```typescript
// tests/guards.test-d.ts
import { expectTypeOf } from 'vitest';
import { isString } from 'blendsdk/stdlib';

const value: unknown = 'hello';
if (isString(value)) {
    expectTypeOf(value).toEqualTypeOf<string>();
}
```

### Asynchronous Patterns

stdlib itself is fully synchronous — it never returns a `Promise` and never needs `await`. Asynchronous tests appear only when *your* code awaits around the package: loading a payload, then formatting it. Use `resolves`/`rejects` matchers for the async boundary and plain assertions for the formatted result.

```typescript
import { describe, expect, it } from 'vitest';
import { formatString } from 'blendsdk/stdlib';

type UserPayload = {
    displayName?: string;
};

type PayloadSource = () => Promise<UserPayload>;

async function renderGreeting(loadPayload: PayloadSource): Promise<string> {
    const payload = await loadPayload();
    return formatString('Hello ${name|Guest}', { name: payload.displayName });
}

describe('renderGreeting (async boundary around stdlib)', () => {
    it('should greet a user with a display name', async () => {
        const result = await renderGreeting(async () => ({ displayName: 'Alice' }));
        expect(result).toBe('Hello Alice');
    });

    it('should fall back to the default when the payload has no display name', async () => {
        await expect(renderGreeting(async () => ({}))).resolves.toBe('Hello Guest');
    });

    it('should render many greetings concurrently', async () => {
        const greetings = await Promise.all([
            renderGreeting(async () => ({ displayName: 'Alice' })),
            renderGreeting(async () => ({}))
        ]);
        expect(greetings).toEqual(['Hello Alice', 'Hello Guest']);
    });

    it('should propagate errors thrown by the data source', async () => {
        const failingSource: PayloadSource = async () => {
            throw new Error('data source offline');
        };

        await expect(renderGreeting(failingSource)).rejects.toThrow('data source offline');
    });
});
```

Note that `formatString` itself never throws — error paths like the last test above only exist in *your* async code. stdlib never needs `rejects` assertions because no input makes it fail; malformed templates are handled by leaving placeholders untouched.

### Managing Consumer State with Hooks

stdlib holds no state, so `beforeEach`/`afterEach` are rarely needed. The exception is a consumer module that caches derived values — reset the cache between tests so cases stay isolated:

```typescript
import { beforeEach, describe, expect, it } from 'vitest';
import { formatString } from 'blendsdk/stdlib';

const greetingCache = new Map<string, string>();

function cachedGreeting(name?: string): string {
    const key = name ?? '';
    const cached = greetingCache.get(key);
    if (cached !== undefined) {
        return cached;
    }
    const rendered = formatString('Hello ${name|Guest}', { name });
    greetingCache.set(key, rendered);
    return rendered;
}

describe('cachedGreeting', () => {
    beforeEach(() => {
        greetingCache.clear();
    });

    it('should compute the greeting once per key', () => {
        expect(cachedGreeting('Alice')).toBe('Hello Alice');
        expect(cachedGreeting('Alice')).toBe('Hello Alice');
        expect(greetingCache.size).toBe(1);
    });

    it('should reuse one cache entry for all nullish names', () => {
        expect(cachedGreeting(undefined)).toBe('Hello Guest');
        expect(cachedGreeting()).toBe('Hello Guest');
        expect(greetingCache.size).toBe(1);
    });
});
```

### Choosing Assertions

- Use `toBe` for primitives, strings and **identity**. `toBe` is the right matcher for `wrapInArray`'s array passthrough (`expect(result).toBe(input)`), which asserts that no copy was made.
- Use `toEqual` for content comparison of arrays and objects (`expect(wrapInArray<string>(null)).toEqual([])`).
- Use `toThrow(TypeError)` for consumer validation built on the guards.
- Remember the two different `""` semantics: `formatString` treats `""` as *missing* (the default applies), while `isNullOrUndefDefault` *preserves* `""`. Test them separately and never copy expectations between the two.
- Templates written as TypeScript template literals must escape the dollar sign (`\${name}`); single-quoted strings need no escaping.

---

## Integration Testing

### No Docker or External Services

`blendsdk/stdlib` has **no Docker dependencies, no databases, and no network calls**. Its test suite is fully hermetic and runs in milliseconds. "Integration" for this package therefore means two things:

1. **Composing multiple stdlib functions** into a consumer-level pipeline (guards + numeric validation + normalization + formatting) and testing the pipeline end to end with real instances — never fakes.
2. **Importing through the public entry point** — `blendsdk/stdlib` (or the `blendsdk` umbrella) instead of deep source paths — so the package's `exports` map and build output are exercised. Ensure the package is built (`npm run build`) before running tests against the compiled `dist/` output.

### Composing a Real Pipeline

The example below combines `isString`, `isNumeric`, `wrapInArray`, `isTemplateString` and `formatString` in one config-reading function. Note how `tags.join(', ')` yielding `""` for an empty list deliberately triggers the `${tags|untagged}` default — the integration of two behaviors.

```typescript
import {
    formatString,
    isNumeric,
    isString,
    isTemplateString,
    wrapInArray
} from 'blendsdk/stdlib';

type ServerConfig = {
    host?: unknown;
    port?: unknown;
    tags?: unknown;
};

function buildServerSummary(config: ServerConfig): string {
    const host: string = isString(config.host) ? config.host : 'localhost';
    const port: number = isNumeric(config.port) ? Number(config.port) : 8080;
    const tags: string[] = wrapInArray<string>(config.tags);
    const template = 'listening on ${host}:${port} [${tags|untagged}]';

    if (!isTemplateString(template)) {
        return template;
    }

    return formatString(template, { host, port, tags: tags.join(', ') });
}
```

Integration tests exercise the full pipeline with realistic, loosely typed inputs:

```typescript
import { describe, expect, it } from 'vitest';
import {
    formatString,
    isNumeric,
    isString,
    isTemplateString,
    wrapInArray
} from 'blendsdk/stdlib';

type ServerConfig = {
    host?: unknown;
    port?: unknown;
    tags?: unknown;
};

function buildServerSummary(config: ServerConfig): string {
    const host: string = isString(config.host) ? config.host : 'localhost';
    const port: number = isNumeric(config.port) ? Number(config.port) : 8080;
    const tags: string[] = wrapInArray<string>(config.tags);
    const template = 'listening on ${host}:${port} [${tags|untagged}]';

    if (!isTemplateString(template)) {
        return template;
    }

    return formatString(template, { host, port, tags: tags.join(', ') });
}

describe('buildServerSummary', () => {
    it('should summarize fully specified config', () => {
        const summary = buildServerSummary({
            host: 'api.example.com',
            port: '3000',
            tags: ['prod', 'eu']
        });
        expect(summary).toBe('listening on api.example.com:3000 [prod, eu]');
    });

    it('should fall back to defaults for invalid and missing values', () => {
        expect(buildServerSummary({ host: 42, port: 'nope' })).toBe(
            'listening on localhost:8080 [untagged]'
        );
    });

    it('should treat a single tag as a one-element list', () => {
        expect(buildServerSummary({ tags: 'sandbox' })).toBe(
            'listening on localhost:8080 [sandbox]'
        );
    });
});
```

### Batch Rendering of a Message Catalog

A common integration scenario is rendering every entry of a message catalog and asserting the whole batch — detection first, formatting second:

```typescript
import { describe, expect, it } from 'vitest';
import { formatString, isTemplateString } from 'blendsdk/stdlib';

describe('message catalog rendering', () => {
    it('should render every template entry and keep plain entries as-is', () => {
        const catalog: Record<string, string> = {
            welcome: 'Welcome, ${user.name|guest}!',
            quota: '${used}/${total} used',
            footer: 'Sent by the platform'
        };

        const rendered = Object.values(catalog).map((template) =>
            isTemplateString(template)
                ? formatString(template, { user: { name: 'Alice' }, used: 3, total: 10 })
                : template
        );

        expect(rendered).toEqual(['Welcome, Alice!', '3/10 used', 'Sent by the platform']);
    });
});
```

---

## Mocking & Stubbing

### Why You Rarely Mock stdlib

Mocking `blendsdk/stdlib` is almost always the wrong move:

- **The functions are pure and deterministic** — same input, same output, no clocks, no randomness, no I/O. A mock cannot be "more predictable" than the real thing.
- **They are effectively free** — a `typeof` check or a regex substitution costs nothing; faking them buys no speed.
- **They never throw** — there is no failure mode to simulate, so failure-path tests belong at *your* boundaries (adapters, data sources), not inside stdlib.
- **Mocks drift from the contract** — the subtle rules (`0` and `false` are real values, `""` is missing for `formatString`, `'undefined'` is a valid string) are exactly what your tests should be pinning down, and a hand-written fake will get them wrong.

The practical rule: use the real functions in tests; put fakes at the async or external boundaries *around* them.

### Faking the Async Boundaries, Keeping stdlib Real

Fake the data source with `vi.fn()`; let stdlib format the result for real:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatString } from 'blendsdk/stdlib';

type UserRecord = {
    id: string;
    name: string;
};

const repository = {
    findUser: vi.fn(async (id: string): Promise<UserRecord | undefined> => {
        const users: UserRecord[] = [{ id: 'u-1', name: 'Alice' }];
        return users.find((user) => user.id === id);
    })
};

async function renderProfile(id: string): Promise<string> {
    const user = await repository.findUser(id);
    return formatString('Profile: ${name|unknown}', { name: user?.name });
}

describe('renderProfile', () => {
    beforeEach(() => {
        repository.findUser.mockClear();
    });

    it('should render the name for a known user', async () => {
        await expect(renderProfile('u-1')).resolves.toBe('Profile: Alice');
        expect(repository.findUser).toHaveBeenCalledWith('u-1');
    });

    it('should fall back to the default when the user does not exist', async () => {
        await expect(renderProfile('missing')).resolves.toBe('Profile: unknown');
    });
});
```

### Wrapping the Real Implementation with vi.mock

When you genuinely need to assert *the exact call* into stdlib — for example, to pin the template literal and params contract of your own module — mock the package with `importOriginal` and wrap the export in `vi.fn(actual.formatString)`. The real implementation stays in place, so behavior is unchanged; only call recording is added.

Given this module under test:

```typescript
// src/renderInvoice.ts
import { formatString } from 'blendsdk/stdlib';

export type Invoice = {
    id: string;
    customer?: string;
};

export function renderInvoice(invoice: Invoice): string {
    return formatString('Order ${id} for ${customer|guest}', invoice);
}
```

the test file looks like this:

```typescript
// tests/renderInvoice.test.ts
import { describe, expect, it, vi } from 'vitest';
import { formatString } from 'blendsdk/stdlib';
import { renderInvoice } from '../src/renderInvoice.js';

// vi.mock is hoisted above all imports by Vitest
vi.mock('blendsdk/stdlib', async (importOriginal) => {
    const actual = await importOriginal<typeof import('blendsdk/stdlib')>();
    return {
        ...actual,
        formatString: vi.fn(actual.formatString)
    };
});

describe('renderInvoice', () => {
    it('should delegate rendering to formatString with the invoice as params', () => {
        const rendered = renderInvoice({ id: 'A-1', customer: 'Alice' });

        // The wrapped implementation still produces the real output
        expect(rendered).toBe('Order A-1 for Alice');

        // ...and the call contract of the module is pinned down
        expect(vi.mocked(formatString)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(formatString)).toHaveBeenCalledWith(
            'Order ${id} for ${customer|guest}',
            { id: 'A-1', customer: 'Alice' }
        );
    });
});
```

Every other stdlib export (`isString`, `isNumeric`, and the rest) remains the real implementation because the factory spreads `actual` first. Reserve this pattern for contract-assertion tests; for everything else, assert the rendered *output*, not the call.

### Decision Table

| Situation | Recommended approach |
| --- | --- |
| Consumer logic calls stdlib directly | Use the real functions — nothing to mock |
| Async data source feeds values into stdlib | `vi.fn()` fake at the boundary; keep stdlib real |
| Need to assert the exact template/params a module passes | `vi.mock('blendsdk/stdlib', importOriginal)` with `vi.fn(actual.formatString)` |
| Need stdlib to fail for a failure-path test | Not applicable — stdlib never throws; inject the failure into your own adapter instead |

---

## Test Patterns by Feature

The tables and examples below organize the highest-value test cases per feature, mirroring the package's own suites (`tests/`).

| Feature | Functions | Module |
| --- | --- | --- |
| Runtime type guards | `isString`, `isBoolean`, `isNullOrUndef` | `src/isString.ts`, `src/isBoolean.ts`, `src/isNullOrUndef.ts` |
| Nullish fallback | `isNullOrUndefDefault` | `src/isNullOrUndef.ts` |
| Strict numeric validation | `isNumeric` | `src/isNumeric.ts` |
| Template detection | `isTemplateString` | `src/isTemplateString.ts` |
| Template formatting | `formatString` | `src/formatString.ts` |
| Array normalization | `wrapInArray` | `src/wrapInArray.ts` |

### Runtime Type Guards

Test the guards as truth tables: the values of the matching type are `true`; the high-value impostors are `false`. The object-wrapper cases (`new String(...)`, `new Boolean(...)`) and the string `'undefined'` are part of the contract — lock them down.

```typescript
import { describe, expect, it } from 'vitest';
import { isBoolean, isNullOrUndef, isString } from 'blendsdk/stdlib';

describe('runtime type guards', () => {
    it('should accept primitives of the matching type', () => {
        expect(isString('')).toBe(true);
        expect(isString('hello')).toBe(true);
        expect(isBoolean(true)).toBe(true);
        expect(isBoolean(1 === 1)).toBe(true);
        expect(isNullOrUndef(null)).toBe(true);
        expect(isNullOrUndef(undefined)).toBe(true);
    });

    it('should reject object wrappers, which are not primitives', () => {
        expect(isString(new String('hello'))).toBe(false);
        expect(isBoolean(new Boolean(true))).toBe(false);
        expect(isString(String('hello'))).toBe(true); // String() returns a primitive
        expect(isBoolean(Boolean('non-empty'))).toBe(true); // coercion also returns a primitive
    });

    it('should treat falsy values and the string "undefined" as defined', () => {
        expect(isNullOrUndef('')).toBe(false);
        expect(isNullOrUndef(0)).toBe(false);
        expect(isNullOrUndef(false)).toBe(false);
        expect(isNullOrUndef(NaN)).toBe(false);
        expect(isNullOrUndef('undefined')).toBe(false);
    });
});
```

| Guard | `true` for | `false` for (high-value cases) |
| --- | --- | --- |
| `isString` | String primitives, template literals, `String(x)` results | `new String('x')`, numbers, arrays, `null`, `undefined` |
| `isBoolean` | `true`, `false`, comparison and logical-operation results | `'true'`, `0`, `1`, `new Boolean(true)` |
| `isNullOrUndef` | `null`, `undefined` — and nothing else | `''`, `0`, `false`, `NaN`, the string `'undefined'` |

For narrowing-specific patterns, see [Testing Type Narrowing](#testing-type-narrowing).

### Nullish Fallback

`isNullOrUndefDefault` has exactly one rule: only `null` and `undefined` trigger the fallback. The tests that matter most are the negative ones — falsy-but-defined values must survive. Type the input variable as the union you actually have; no casts are needed.

```typescript
import { describe, expect, it } from 'vitest';
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

describe('isNullOrUndefDefault', () => {
    it('should replace null and undefined with the default', () => {
        const fromNull: string | null = null;
        const fromUndefined: string | undefined = undefined;

        expect(isNullOrUndefDefault(fromNull, 'fallback')).toBe('fallback');
        expect(isNullOrUndefDefault(fromUndefined, 'fallback')).toBe('fallback');
    });

    it('should preserve falsy but defined values', () => {
        expect(isNullOrUndefDefault('', 'fallback')).toBe('');
        expect(isNullOrUndefDefault(0, 100)).toBe(0);
        expect(isNullOrUndefDefault(false, true)).toBe(false);
    });

    it('should return the original reference for objects and arrays', () => {
        const value: number[] = [];
        const fallback: number[] = [1, 2, 3];

        expect(isNullOrUndefDefault(value, fallback)).toBe(value);
    });

    it('should resolve one level of an optional lookup', () => {
        const settings: Record<string, string> = { theme: 'dark' };

        expect(isNullOrUndefDefault(settings.theme, 'light')).toBe('dark');
        expect(isNullOrUndefDefault(settings.locale, 'en-US')).toBe('en-US');
    });
});
```

| Input | Expected result | Assert with |
| --- | --- | --- |
| `null`, `undefined` | The default value | `toBe(default)` |
| `''`, `0`, `false`, `NaN` | The original value | `toBe(input)` |
| Object or array reference | The same reference | `toBe(input)` (identity) |

### Strict Numeric Validation

`isNumeric` is a strict validator, not a coercer — the interesting cases are the rejections that `parseFloat` would have accepted. A data-driven `it.each` table keeps them readable, and a small `parsePort`-style wrapper shows how consumers combine validation with conversion.

```typescript
import { describe, expect, it } from 'vitest';
import { isNumeric } from 'blendsdk/stdlib';

function parsePort(value: string | undefined): number | undefined {
    if (value !== undefined && isNumeric(value)) {
        return Number(value);
    }
    return undefined;
}

describe('isNumeric', () => {
    const cases: Array<[unknown, boolean]> = [
        [42, true],
        [-3.14, true],
        ['42', true],
        [' 3.14 ', true],
        ['1e10', true],
        ['0xFF', true],
        ['42px', false],
        ['1,000', false],
        ['Infinity', false],
        [Infinity, false],
        [NaN, false],
        [[42], false],
        [new Number(42), false],
        [true, false]
    ];

    it.each(cases)('isNumeric(%s) should be %s', (input, expected) => {
        expect(isNumeric(input)).toBe(expected);
    });

    describe('parsePort', () => {
        it('should return the port for numeric strings', () => {
            expect(parsePort('8080')).toBe(8080);
            expect(parsePort(' 3000 ')).toBe(3000);
        });

        it('should return undefined for invalid input', () => {
            expect(parsePort(undefined)).toBeUndefined();
            expect(parsePort('8080px')).toBeUndefined();
            expect(parsePort('1,000')).toBeUndefined();
        });
    });
});
```

| Case | Expected | Why it matters |
| --- | --- | --- |
| `42`, `-3.14`, `Number.MAX_SAFE_INTEGER` | `true` | Finite number primitives |
| `'42'`, `' 3.14 '`, `'1e10'`, `'0xFF'`, `'.5'`, `'+42'` | `true` | Complete JavaScript numeric literals |
| `NaN`, `Infinity`, `'NaN'`, `'Infinity'` | `false` | Non-finite |
| `'42px'`, `'100%'`, `'1,000'`, `'3.14.15'` | `false` | Partial or ambiguous strings (the `parseFloat` trap) |
| `[42]`, `{ value: 42 }`, `new Number(42)`, `BigInt(1)` | `false` | No coercion of non-primitives |

### Template Detection

`isTemplateString` is a purely syntactic check — well-formed placeholders count, malformed ones do not, and resolvability against params is not its concern. Cover the full placeholder grammar in the `true` cases and the malformed shapes in the `false` cases.

```typescript
import { describe, expect, it } from 'vitest';
import { isTemplateString } from 'blendsdk/stdlib';

describe('isTemplateString', () => {
    it('should detect every supported placeholder form', () => {
        expect(isTemplateString('Hello ${name}')).toBe(true);
        expect(isTemplateString('Hello ${name|World}')).toBe(true);
        expect(isTemplateString('${user.name}')).toBe(true);
        expect(isTemplateString('${user.name|Anonymous}')).toBe(true);
        expect(isTemplateString('${ name }')).toBe(true);
        expect(isTemplateString('${name|}')).toBe(true);
    });

    it('should reject malformed or absent placeholders', () => {
        expect(isTemplateString('Hello world')).toBe(false);
        expect(isTemplateString('')).toBe(false);
        expect(isTemplateString('Hello ${')).toBe(false);
        expect(isTemplateString('Hello ${}')).toBe(false);
        expect(isTemplateString('${   }')).toBe(false);
        expect(isTemplateString('$name')).toBe(false);
        expect(isTemplateString('{name}')).toBe(false);
    });

    it('should report syntax only, not resolvability', () => {
        // The key cannot be resolved, but the placeholder is well formed
        expect(isTemplateString('Hello ${missing}')).toBe(true);
    });
});
```

### Template Formatting

`formatString` is the richest surface, so tests should be grouped by behavior category exactly as the package's own suite does: substitution, defaults, dot-notation, value stringification, fast paths, unresolved placeholders and whitespace tolerance.

```typescript
import { describe, expect, it } from 'vitest';
import { formatString } from 'blendsdk/stdlib';

describe('formatString', () => {
    it('should substitute simple and repeated placeholders', () => {
        expect(formatString('Hello ${name}', { name: 'John' })).toBe('Hello John');
        expect(formatString('${x} + ${x} = 2${x}', { x: 'A' })).toBe('A + A = 2A');
    });

    it('should fall back to the default for missing, null, undefined and empty values', () => {
        expect(formatString('Hello ${name|Guest}')).toBe('Hello Guest');
        expect(formatString('Hello ${name|Guest}', { name: undefined })).toBe('Hello Guest');
        expect(formatString('Hello ${name|Guest}', { name: null })).toBe('Hello Guest');
        expect(formatString('Hello ${name|Guest}', { name: '' })).toBe('Hello Guest');
    });

    it('should keep zero and false as real values', () => {
        expect(formatString('Count: ${n}', { n: 0 })).toBe('Count: 0');
        expect(formatString('Active: ${flag}', { flag: false })).toBe('Active: false');
    });

    it('should resolve dot-notation and stop at nullish intermediates', () => {
        expect(formatString('${user.name}', { user: { name: 'Alice' } })).toBe('Alice');
        expect(formatString('${user.address.city}', { user: {} })).toBe('${user.address.city}');
        expect(formatString('${user.address.city|unknown}', { user: null })).toBe('unknown');
    });

    it('should preserve unresolved placeholders when no default exists', () => {
        expect(formatString('Hello ${unknown}', { name: 'John' })).toBe('Hello ${unknown}');
        expect(formatString('${a} and ${b}', { a: 'X' })).toBe('X and ${b}');
    });

    it('should return plain strings unchanged (fast paths)', () => {
        expect(formatString('No placeholders here')).toBe('No placeholders here');
        expect(formatString('')).toBe('');
        expect(formatString('Hello ${name}')).toBe('Hello ${name}'); // params omitted
    });

    it('should tolerate whitespace and support an empty default', () => {
        expect(formatString('Hello ${ name }', { name: 'John' })).toBe('Hello John');
        expect(formatString('Hello ${ name | Guest }', {})).toBe('Hello  Guest ');
        expect(formatString('Hello ${name|}', { name: '' })).toBe('Hello ');
    });

    it('should render templates built with TypeScript template literals', () => {
        const userId = 'u-1';
        // Escape the dollar sign so the template literal keeps the placeholder
        const template = `User \${id}: \${role|viewer}`;
        expect(formatString(template, { id: userId })).toBe('User u-1: viewer');
    });

    it('should never throw, even for malformed templates', () => {
        expect(() => formatString('Hello ${')).not.toThrow();
        expect(() => formatString('Hello ${}')).not.toThrow();
    });
});
```

| Behavior to cover | Example assertion |
| --- | --- |
| Simple, repeated, adjacent substitution | `formatString('${a}${b}', { a: 'X', b: 'Y' })` → `'XY'` |
| Defaults for missing / `undefined` / `null` / `''` | `formatString('${name\|Guest}', { name: '' })` → `'Guest'` |
| `0` and `false` are present values | `formatString('${n}', { n: 0 })` → `'0'` |
| Dot-notation, incl. nullish intermediates | `formatString('${user.name}', { user: {} })` → `'${user.name}'` |
| Unresolved placeholder kept raw | `formatString('Hello ${unknown}')` → `'Hello ${unknown}'` |
| Fast paths (no `${`, empty string, no params) | `formatString('Plain')` → `'Plain'` |
| Whitespace tolerance and empty defaults | `formatString('${ name }', { name: 'X' })` → `'X'` |
| Never throws | `expect(() => formatString('Hello ${')).not.toThrow()` |

### Array Normalization

`wrapInArray` has three branches, each with a precise assertion style: `toEqual([])` for nullish input, `toBe(input)` (identity, not content) for arrays passing through, and `toEqual([value])` for wrapped values — including falsy ones.

```typescript
import { describe, expect, it } from 'vitest';
import { wrapInArray } from 'blendsdk/stdlib';

describe('wrapInArray', () => {
    it('should return an empty array for null and undefined', () => {
        expect(wrapInArray<string>(null)).toEqual([]);
        expect(wrapInArray<string>(undefined)).toEqual([]);
    });

    it('should return the same array reference when input is already an array', () => {
        const tags: string[] = ['a', 'b'];
        const result: string[] = wrapInArray<string>(tags);

        expect(result).toBe(tags); // identity — no copy is made
        expect(result).toEqual(['a', 'b']);
    });

    it('should wrap single values of every kind', () => {
        expect(wrapInArray('task')).toEqual(['task']);
        expect(wrapInArray(0)).toEqual([0]);
        expect(wrapInArray(false)).toEqual([false]);
        expect(wrapInArray('')).toEqual(['']);
    });

    it('should wrap array-like values instead of spreading them', () => {
        const arrayLike = { 0: 'a', 1: 'b', length: 2 };
        expect(wrapInArray(arrayLike)).toEqual([arrayLike]);
    });

    it('should return a typed array for generic call sites', () => {
        const result: number[] = wrapInArray<number>(42);
        expect(result).toEqual([42]);
    });
});
```

| Input | Output | Assert with |
| --- | --- | --- |
| `null`, `undefined` | New empty array | `toEqual([])` |
| An existing array | The same reference, unchanged | `toBe(input)` |
| A single value (including `0`, `''`, `false`) | One-element array | `toEqual([value])` |
| A `Set`, `Map` or array-like object | Wrapped as a single element, not spread | `toEqual([input])` |

---

# stdlib Troubleshooting

This document catalogs the errors and surprising behaviors you are most likely to hit with `blendsdk/stdlib`: module-resolution failures, TypeScript type errors around the type guards, runtime failures caused by untyped data reaching the API, and the subtle semantics of templates and array normalization. Each issue follows the pattern **error or symptom → cause → fix**, with a complete, runnable code example.

---

## Common Errors

Use the quick-reference table below to jump to the matching diagnosis. Every entry gives the exact error text (where available), why it happens, and a fix you can apply immediately.

| Error or symptom | Most likely cause |
| --- | --- |
| `TS2307: Cannot find module 'blendsdk/stdlib'` | Package not built or linked; legacy `moduleResolution` ignoring the `exports` map |
| `TS1479` — CommonJS file importing an ES module | Consumer project compiles to CJS; the package is ESM-only |
| `ERR_PACKAGE_PATH_NOT_EXPORTED` | `require()` of the package, or a deep import into `dist/` |
| `does not provide an export named ...` | Default import or misspelled named import |
| `TS18046: 'value' is of type 'unknown'` | Using an `isNumeric` result as if it narrowed the type |
| `TS2345 ... not assignable to parameter of type 'null'/'undefined'` | `isNullOrUndefDefault` called with a statically nullish value |
| `TS2345 ... parameter of type 'string'` | `isTemplateString` called with a possibly-undefined value |
| `TS2339 ... does not exist on type 'never'` | Type guard contradicts the declared type of the value |
| `TypeError: ... (reading 'includes')` | Non-string value passed to `formatString` at runtime |
| Output contains raw `${...}` | Unresolved or unrecognized placeholder |
| `TypeError: ... is not a function` after `wrapInArray<T>` | `T` is an unchecked type claim on unvalidated data |

### Module Resolution and Import Errors

#### TS2307 — Cannot find module

**Error**

```text
src/app.ts:1:26 - error TS2307: Cannot find module 'blendsdk/stdlib' or its corresponding type declarations.
```

**Cause**

- `blendsdk/stdlib` is marked `"private": true` and is not published to npm under its own name. Inside the BlendSDK monorepo it is consumed as a workspace package; outside it, you install the published `blendsdk` umbrella. A direct `npm install blendsdk/stdlib` never resolves.
- The package ships compiled output only (`files: ["dist"]`). If `dist/index.js` and `dist/index.d.ts` do not exist yet, even a correctly linked dependency has nothing to resolve.
- If the dependency is linked and built, the consumer's `tsconfig.json` is likely using legacy resolution (`"moduleResolution": "node10"` / `"node"`), which ignores the `exports` field — and `exports` is the only way this package declares its entry point.

**Fix**

1. Depend on the package the supported way: as a workspace dependency inside the monorepo, or through the `blendsdk` umbrella elsewhere.

```json
{
    "dependencies": {
        "blendsdk": "^5.x"
    }
}
```

2. Build the package so `dist/` exists.

```bash
cd packages/stdlib
npm run clean && npm run build
```

3. Point TypeScript at the `exports` map with modern resolution.

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "nodenext",
        "moduleResolution": "nodenext",
        "strict": true
    }
}
```

4. Verify with a minimal file.

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

const configured: number | undefined = undefined;
const port: number = isNullOrUndefDefault(configured, 8080) ?? 8080;

console.log(port); // → 8080
```

#### TS1479 — a CommonJS file imports the ECMAScript-only package

**Error**

```text
src/app.ts:1:1 - error TS1479: The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module and cannot be imported with 'require' calls.
```

**Cause**

`blendsdk/stdlib` is ESM-only: `"type": "module"` in its `package.json` and an `exports` map that declares only the `import` condition. A consumer project that compiles to CommonJS (`"module": "commonjs"`, or `.ts` files in a package without `"type": "module"` under `nodenext`) produces `require()` calls, which cannot load this package.

**Fix**

1. Migrate the importing project to ESM — add `"type": "module"` to its `package.json` and use Node.js module resolution.

```json
{
    "type": "module"
}
```

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "nodenext",
        "moduleResolution": "nodenext",
        "strict": true
    }
}
```

2. If the file must remain CommonJS, load the package asynchronously with a dynamic `import()`, which Node.js supports from CommonJS.

```typescript
// In a file that must stay CommonJS, load the package asynchronously
async function renderGreeting(): Promise<string> {
    const { formatString } = await import('blendsdk/stdlib');
    return formatString('Hello ${name}', { name: 'Alice' });
}

void renderGreeting().then((message: string) => console.log(message));
// → Hello Alice
```

#### ERR_PACKAGE_PATH_NOT_EXPORTED — require() finds no CommonJS entry

**Error**

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in /path/to/node_modules/blendsdk/stdlib/package.json
```

Reproduction:

```bash
node -e "require('blendsdk/stdlib')"
```

**Cause**

The `exports` map contains only `types` and `import` conditions — there is no `require` target. Node's CommonJS resolver evaluates the `require` condition set, finds no matching entry, and fails. Note that Node.js 22's `require(esm)` support does not help here: the failure is in the condition match, not in the module format.

**Fix**

Use an ESM import — the package is designed for ESM consumers only.

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

const items: string[] = wrapInArray<string>('a');
console.log(items); // → [ 'a' ]
```

#### ERR_PACKAGE_PATH_NOT_EXPORTED — deep imports into dist/

**Error**

```text
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './dist/formatString.js' is not defined by "exports" in /path/to/node_modules/blendsdk/stdlib/package.json
```

**Cause**

The `exports` map exposes exactly one subpath: `"."`. Internal file paths under `dist/` are deliberately private (the barrel/facade pattern), so deep imports fail even when the file physically exists.

**Fix**

Import from the package root; every public function is re-exported there.

```typescript
// ❌ Deep import — blocked by the exports map
// import { formatString } from 'blendsdk/stdlib/dist/formatString.js';

import { formatString } from 'blendsdk/stdlib';

console.log(formatString('Hello ${name}', { name: 'Alice' }));
// → Hello Alice
```

#### Does not provide an export named ... / has no exported member

**Error**

```text
SyntaxError: The requested module 'blendsdk/stdlib' does not provide an export named 'default'
```

or, for a misspelled named import:

```text
SyntaxError: The requested module 'blendsdk/stdlib' does not provide an export named 'isNullorUndef'
```

or at compile time:

```text
src/app.ts:2:10 - error TS2305: Module '"blendsdk/stdlib"' has no exported member 'isNullorUndef'.
```

**Cause**

The package uses named exports exclusively — there is no default export. The second and third errors are almost always typos or a guess at a name that does not exist.

**Fix**

Import the exact named exports; the full public surface is eight functions.

```typescript
import {
    formatString,
    isBoolean,
    isNullOrUndef,
    isNullOrUndefDefault,
    isNumeric,
    isString,
    isTemplateString,
    wrapInArray
} from 'blendsdk/stdlib';

console.log(typeof wrapInArray, typeof formatString);
// → function function
```

### TypeScript Type Errors

#### TS18046 — 'value' is of type 'unknown' after isNumeric

**Error**

```text
src/app.ts:5:16 - error TS18046: 'raw' is of type 'unknown'.
```

**Cause**

`isNumeric` returns plain `boolean`, not a type predicate. It cannot narrow the argument because success may mean a number *or* a numeric string — TypeScript would have no single type to narrow to. Using the value directly after the check therefore leaves it `unknown`.

**Fix**

Convert explicitly with `Number()` after the check, or combine with a narrowing guard first.

```typescript
import { isNumeric, isString } from 'blendsdk/stdlib';

function doubled(raw: unknown): number | undefined {
    if (isNumeric(raw)) {
        // ❌ return raw * 2;
        // TS18046: 'raw' is of type 'unknown'.
        return Number(raw) * 2; // ✅ convert explicitly after the check
    }
    return undefined;
}

function normalized(raw: unknown): string | undefined {
    if (isString(raw) && isNumeric(raw)) {
        return raw.trim(); // raw: string — narrowed by isString
    }
    return undefined;
}

console.log(doubled('21'));     // → 42
console.log(doubled('21px'));   // → undefined
console.log(normalized(' 42 ')); // → 42
```

#### TS2345 — string is not assignable to 'null' or 'undefined' (isNullOrUndefDefault)

**Error**

```text
src/app.ts:4:42 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'null'.
```

**Cause**

`isNullOrUndefDefault<ReturnType>(value, defaultValue)` shares one type parameter across both arguments. TypeScript infers `ReturnType` from the first argument — when that argument is statically only `null` (or only `undefined`), the default value no longer matches.

**Fix**

1. In real code, this error usually means the first argument's declared type is narrower than the actual runtime data — widen it.
2. When you genuinely have a nullish-only value, pin the type parameter explicitly instead of resorting to casts.

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

// The failing pattern:
// isNullOrUndefDefault(null, 'fallback');
// TS2345: Argument of type 'string' is not assignable to parameter of type 'null'.

// ✅ Widen the input to its true union type — inference then succeeds
const fromEnv: string | undefined = process.env.USER_NAME;
const name: string | undefined = isNullOrUndefDefault(fromEnv, 'Guest');

// ✅ Or pin the type parameter when the value is statically nullish
const fromCache: string | null = null;
const cached: string | null = isNullOrUndefDefault<string | null>(fromCache, 'fallback');

console.log(name, cached);
// → (value of USER_NAME or undefined) fallback
```

#### TS2345 — string | undefined is not assignable to 'string' (isTemplateString)

**Error**

```text
src/app.ts:6:25 - error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
```

**Cause**

`isTemplateString(value: string)` takes a plain `string` — not `unknown`. Values such as `process.env.*` or optional object properties are `string | undefined`, and TypeScript rejects them before the runtime check ever matters.

**Fix**

Narrow with `isString` first; the guard composes naturally with the template check.

```typescript
import { formatString, isString, isTemplateString } from 'blendsdk/stdlib';

const template: string | undefined = process.env.EMAIL_TEMPLATE;

// ❌ if (isTemplateString(template)) { ... }
// TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.

if (isString(template) && isTemplateString(template)) {
    console.log(formatString(template, { name: 'Alice' }));
}
// → Hello Alice (when EMAIL_TEMPLATE contains, for example, "Hello ${name}")
```

#### TS2339 — Property does not exist on type 'never'

**Error**

```text
src/app.ts:6:21 - error TS2339: Property 'trim' does not exist on type 'never'.
```

**Cause**

A type guard can never produce a value outside the declared type. If the parameter is declared `string`, then inside `if (isNullOrUndef(name))` there is no value left — TypeScript narrows the branch to `never`, and any property access on it fails. The declaration contradicts reality; the guard is telling you that.

**Fix**

Widen the declared type to match what actually arrives at runtime.

```typescript
import { isNullOrUndef } from 'blendsdk/stdlib';

// The failing pattern — the guard contradicts the declared type:
// function greetWrong(name: string): string {
//     if (isNullOrUndef(name)) {
//         return name.trim(); // TS2339: Property 'trim' does not exist on type 'never'.
//     }
//     return 'Hello ' + name;
// }

// ✅ Declare the true input type so the guard has something to narrow
function greet(name: string | undefined): string {
    if (isNullOrUndef(name)) {
        return 'Hello Guest'; // name: null | undefined
    }
    return 'Hello ' + name;   // name: string
}

console.log(greet(undefined)); // → Hello Guest
console.log(greet('Alice'));   // → Hello Alice
```

### Runtime Errors and Unexpected Output

#### TypeError — template.includes is not a function

**Error**

```text
TypeError: Cannot read properties of undefined (reading 'includes')
```

or its siblings:

```text
TypeError: Cannot read properties of null (reading 'includes')
TypeError: template.includes is not a function
```

**Cause**

`formatString(template: string, ...)` enforces the string type only at compile time. At runtime, untyped callers — plain JavaScript, values from JSON, environment variables, `any`-typed data — can pass `undefined`, `null` or a number. The function's fast path then calls `template.includes("${")` on a non-string and throws before any formatting happens.

**Fix**

Validate at the boundary where untyped data enters, with a `try`/`catch` wrapper around the render step.

```typescript
import { formatString, isString } from 'blendsdk/stdlib';

function safeRender(template: unknown, params: Record<string, unknown>): string {
    try {
        if (!isString(template)) {
            throw new TypeError('Template must be a string');
        }
        return formatString(template, params);
    } catch (error) {
        if (error instanceof Error) {
            return `[render error: ${error.message}]`;
        }
        return '[render error]';
    }
}

console.log(safeRender('Hello ${name}', { name: 'Alice' }));
// → Hello Alice
console.log(safeRender(null, {}));
// → [render error: Template must be a string]
```

#### Rendered output keeps literal ${...} placeholders

**Symptom**

`formatString('Hello ${user.name}', { user: {} })` returns `'Hello ${user.name}'`, and raw placeholders show up in log lines, emails or API responses.

**Cause**

`formatString` fails safe by design: it never throws and never inserts an empty string for a value it could not resolve. There are three reasons a placeholder survives:

1. **Missing value, no default** — the key is absent, `null`, `undefined` or `""`, and the placeholder has no `|default`.
2. **Key outside the placeholder grammar** — keys must consist of word characters and dots (`[\w.]`). `${user-name}` is never recognized as a placeholder, even if `params` contains the key `"user-name"`.
3. **Broken dot path** — a `null`/`undefined` intermediate aborts the traversal, and the placeholder is kept.

**Fix**

Give every optional value a default, keep keys within the grammar, and verify paths individually.

```typescript
import { formatString } from 'blendsdk/stdlib';

// 1. Provide a default for every placeholder that may not resolve
console.log(formatString('Hello ${user.name|Guest}', { user: {} }));
// → Hello Guest

// 2. Keep keys within [\w.] — hyphenated keys never match, with or without params
console.log(formatString('Hello ${user-name}', { user: {} }));
// → Hello ${user-name}

// 3. Guard the full path — a nullish intermediate is treated as missing
const user: { name?: string } | null = null;
console.log(formatString('Hello ${user.name|Guest}', { user }));
// → Hello Guest
```

#### TypeError — element method is not a function after wrapInArray<T>

**Error**

```text
TypeError: dates[0].getTime is not a function
```

**Cause**

`wrapInArray<T>(obj: unknown) => T[]` cannot verify that `T` matches the runtime data — the element type is a claim you make as the caller, not a check the compiler performs. Wrapping unvalidated data (environment variables, JSON) as `T[]` silently moves the type error from compile time to a distant call site.

**Fix**

Wrap external data as `unknown[]` and validate the elements with the package's runtime guards before treating them as `T`.

```typescript
import { isString, wrapInArray } from 'blendsdk/stdlib';

// ❌ T is a promise, not a check:
// const dates: Date[] = wrapInArray<Date>(process.env.BUILD_DATE);
// dates[0].getTime(); // TypeError: dates[0].getTime is not a function

// ✅ Wrap as unknown[], then validate with runtime guards:
const entries: unknown[] = wrapInArray<unknown>(process.env.BUILD_DATE);
const dates: Date[] = entries.filter(isString).map((value) => new Date(value));

console.log(dates.map((date) => date.toISOString()));
// → [] when BUILD_DATE is unset; otherwise e.g. [ '2024-05-01T00:00:00.000Z' ]
```

### Build and Monorepo Errors (Contributors)

#### New module not exported — does not provide an export named ...

**Symptom**

In another package or the published output you get:

```text
SyntaxError: The requested module 'blendsdk/stdlib' does not provide an export named 'isEmail'
```

Your new function exists in `src/` and its own tests pass — but `npm test` runs `src/` via Vitest, while every consumer resolves the compiled `dist/` output. Two things are missing: the barrel re-export and a rebuild.

**Cause**

`src/index.ts` is the single public entry point; a module that is not re-exported there is unreachable through the package. And `dist/` is only regenerated by `npm run build` — tests passing against `src/` says nothing about `dist/`.

**Fix**

1. Add one `export * from './<module>.js';` line for the new module to the barrel.

```typescript
// src/index.ts — the only public entry point; every public module is re-exported here
export * from './formatString.js';
export * from './isBoolean.js';
export * from './isNullOrUndef.js';
export * from './isNumeric.js';
export * from './isString.js';
export * from './isTemplateString.js';
export * from './wrapInArray.js';
```

2. Rebuild so `dist/` matches `src/`.

```bash
cd packages/stdlib
npm run clean && npm run build
```

3. While actively developing, keep `npm run dev` (`tsc --watch`) running so `dist/` never goes stale for the sibling packages that import it.

#### TS2835 / ERR_MODULE_NOT_FOUND — relative imports need a .js extension

**Error**

```text
src/isEmail.ts:1:28 - error TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean './isString.js'?
```

or, if the compiler is lenient and the emitted output runs under Node, at runtime:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/path/to/packages/stdlib/dist/isString' imported from /path/to/packages/stdlib/dist/isEmail.js
```

**Cause**

In Node ESM, relative imports require explicit file extensions. This repository follows the standard TypeScript convention: write the specifier with a `.js` extension even though the source file is `.ts` (the `src` files do this, e.g. `import { isNullOrUndef } from "./isNullOrUndef.js";`, and the tests follow suit with `../src/formatString.js`). An extensionless specifier may resolve in Vitest but fails in `tsc` and in `dist`.

**Fix**

Always write `.js` in relative import specifiers, and never `.ts` (TypeScript rejects `.ts`-suffixed imports unless `allowImportingTsExtensions` is enabled).

```typescript
// src/stringLength.ts — relative imports use the .js extension, mapped to .ts sources
import { isString } from './isString.js';

export function stringLength(value: unknown): number {
    return isString(value) ? value.length : 0;
}

console.log(stringLength('hello')); // → 5
console.log(stringLength(42));      // → 0
```

---

## Debugging Strategies

The procedures below are ordered from cheapest to most specific. Run them in sequence when a stdlib issue resists a quick fix.

### 1. Verify the package resolves and exposes the expected API

If any function is `undefined` (or the compiler rejects a member access), the build or the link is the problem — not your code.

```typescript
import * as stdlib from 'blendsdk/stdlib';

const expected = [
    'formatString',
    'isBoolean',
    'isNullOrUndef',
    'isNullOrUndefDefault',
    'isNumeric',
    'isString',
    'isTemplateString',
    'wrapInArray'
] as const;

for (const name of expected) {
    const member: unknown = stdlib[name];
    console.log(`${name}: ${typeof member}`);
}
// → formatString: function
// → isBoolean: function
// → (one "function" line per export; "undefined" reveals a stale or broken build)
```

From a consumer project, inspect how TypeScript resolved the package:

```bash
npx tsc --traceResolution --noEmit | grep "blendsdk/stdlib" | head -n 10
```

Look for a `was successfully resolved to .../dist/index.d.ts` line. If resolution lands on the wrong file, or fails entirely, fix the `moduleResolution` setting before debugging anything else.

### 2. Rule out a stale build before anything else

Vitest executes `src/`; every other consumer resolves `dist/`. A behavior that is "fixed in tests but not in the app" is almost always a stale `dist/`.

```bash
cd packages/stdlib
npm run clean
npm run build
npm test
```

Then re-run the failing scenario through the compiled output. During longer sessions, keep `npm run dev` (`tsc --watch`) running so `dist/` stays current.

### 3. Classify the value before it reaches a guard or formatter

Most "the guard behaves wrong" reports are actually reports about the value's runtime type. Classify it explicitly with the package's own guards.

```typescript
import { isBoolean, isNullOrUndef, isNumeric, isString } from 'blendsdk/stdlib';

function classify(value: unknown): string {
    if (isNullOrUndef(value)) {
        return 'nullish';
    }
    if (isString(value)) {
        return isNumeric(value) ? 'numeric string' : 'non-numeric string';
    }
    if (isBoolean(value)) {
        return value ? 'boolean true' : 'boolean false';
    }
    if (isNumeric(value)) {
        return 'finite number';
    }
    return `other (${typeof value})`;
}

const samples: unknown[] = [null, undefined, '42', 'abc', false, 3.14, NaN, Infinity];

for (const sample of samples) {
    console.log(`${String(sample)} → ${classify(sample)}`);
}

// null → nullish
// undefined → nullish
// 42 → numeric string
// abc → non-numeric string
// false → boolean false
// 3.14 → finite number
// NaN → other (number)
// Infinity → other (number)
```

### 4. Probe placeholder syntax and dot paths in isolation

First check whether a placeholder is even recognized by the grammar:

```typescript
import { isTemplateString } from 'blendsdk/stdlib';

const candidates: string[] = [
    '${user.name|Guest}',
    '${user-name|Guest}',
    '${user.name}',
    '${user name}'
];

for (const candidate of candidates) {
    console.log(`${candidate} recognized=${isTemplateString(candidate)}`);
}

// ${user.name|Guest} recognized=true
// ${user-name|Guest} recognized=false — hyphen not in the key grammar
// ${user.name} recognized=true
// ${user name} recognized=false — space inside the key is not allowed
```

Then test the exact path resolution semantics with a distinct sentinel default:

```typescript
import { formatString } from 'blendsdk/stdlib';

// Same resolution semantics as formatString — if the sentinel survives,
// the path did not resolve (missing segment, nullish intermediate, or "").
function resolveTo(params: Record<string, unknown>, path: string): string {
    return formatString('${' + path + '|__MISSING__}', params);
}

console.log(resolveTo({ user: { name: 'Alice' } }, 'user.name'));
// → Alice
console.log(resolveTo({ user: {} }, 'user.name'));
// → __MISSING__
console.log(resolveTo({ user: { address: null } }, 'user.address.city'));
// → __MISSING__
```

### 5. Run the relevant test file as an executable specification

The `tests/` directory is the definitive description of behavior — every edge case, including the documented breaking changes, has an assertion. When output surprises you, find the matching test before assuming a bug.

```bash
cd packages/stdlib
npx vitest run --reporter=verbose tests/format-string.test.ts
npx vitest run --reporter=verbose tests/isNumeric.test.ts
npx vitest run --coverage
```

Search the tests for the exact value or string that misbehaves (`grep -n "'42px'" tests/isNumeric.test.ts`) — comments such as `BREAKING CHANGE` mark intentional deviations from older semantics.

---

## Known Pitfalls

These pitfalls are deliberate semantics, not bugs — but each has surprised real consumers at least once.

### Empty string: missing in templates, real everywhere else

`formatString` treats `""` as "no value" and falls back to the default; `isNullOrUndefDefault` returns `""` untouched. Formatting substitutes display text (where an empty label is usually undesirable), while fallback preserves data (where `""` is legitimate).

| Value | `formatString('${name\|default}')` | `isNullOrUndefDefault(value, 'default')` |
| --- | --- | --- |
| `''` | falls back to `default` | returns `''` |
| `0` | inserts `0` | returns `0` |
| `false` | inserts `false` | returns `false` |
| `null` / `undefined` | falls back to `default` | falls back to `default` |

```typescript
import { formatString, isNullOrUndefDefault } from 'blendsdk/stdlib';

console.log(formatString('${name|Guest}', { name: '' })); // → Guest
console.log(isNullOrUndefDefault('', 'Guest'));           // → ''
```

### Keys must stay within [\w.] — hyphens, spaces and other characters break matching

A key outside the grammar is not a placeholder at all: it is left verbatim even when `params` contains the exact key text. Only the first `|` separates key from default, so defaults may contain further pipes (`${a|b|c}` falls back to `b|c`), and a `}` can never appear inside a default.

```typescript
import { formatString, isTemplateString } from 'blendsdk/stdlib';

console.log(isTemplateString('${user.name}'));  // → true
console.log(isTemplateString('${user-name}'));  // → false — hyphen not in grammar
console.log(isTemplateString('${user name}'));  // → false — space inside key not allowed

console.log(formatString('${user-name}', { 'user-name': 'Alice' }));
// → ${user-name} — kept verbatim; use ${user.name} or ${userName} instead
```

### Whitespace inside placeholders is preserved literally

Whitespace around the key is trimmed for the lookup, but whitespace in the default value is inserted exactly as written — including the space before the closing `}`. `${ name | Guest }` therefore produces double spaces and a trailing space.

```typescript
import { formatString } from 'blendsdk/stdlib';

console.log(formatString('Hello ${ name }', { name: 'Alice' }));
// → Hello Alice — whitespace around the key is trimmed for lookup

console.log(formatString('Hello ${ name | Guest }', {}));
// → "Hello  Guest " — the default is inserted verbatim, spaces included
```

### There is no escape sequence for `${`

A backslash is an ordinary character: it stays in the output and the placeholder still resolves. If you need to emit literal `${` text (for example, generating a template for later use), assemble it from parts so the sequence never exists in the input.

```typescript
import { formatString } from 'blendsdk/stdlib';

console.log(formatString('\\${name}', { name: 'Alice' }));
// → \Alice — backslash kept, placeholder still resolved

const opening = '$' + '{';
console.log(opening + 'user.name|Guest}');
// → ${user.name|Guest}
```

### Substituted values use plain String() conversion

`formatString` inserts `String(value)`. Objects become `[object Object]` and arrays become comma-joined text — useful for numbers and booleans, rarely what you want for structured data. Use a dot path or pre-format the value.

```typescript
import { formatString } from 'blendsdk/stdlib';

const user = { name: 'Alice', roles: ['admin', 'editor'] };

console.log(formatString('${user}', { user }));
// → [object Object]

console.log(formatString('${user.roles}', { user }));
// → admin,editor

console.log(formatString('${user.roles}', { user: { roles: JSON.stringify(user.roles) } }));
// → ["admin","editor"]
```

### isNumeric is stricter and looser than parseFloat / Number

`isNumeric` validates completeness (no partial parses) *and* accepts every valid JavaScript numeric literal — including hexadecimal, binary, octal and scientific notation. That is stricter than `parseFloat("42px")` and looser than a "decimal only" form validation.

| Input | `isNumeric` | Reason |
| --- | --- | --- |
| `'42'`, `' 3.14 '`, `'-100'` | `true` | Complete numeric string (trimmed) |
| `'42px'`, `'100%'`, `'1,000'`, `'3.14.15'` | `false` | Not a complete numeric literal |
| `'1e10'`, `'0xFF'`, `'0o10'`, `'0b1010'`, `'.5'`, `'+42'` | `true` | Valid JavaScript numeric literal |
| `'NaN'`, `'Infinity'`, `''`, `'   '` | `false` | Non-finite or empty |
| `Infinity`, `NaN`, `[42]`, `new Number(42)` | `false` | Not a finite primitive |

For plain decimal form input, layer a stricter check on top:

```typescript
import { isNumeric, isString } from 'blendsdk/stdlib';

// Plain decimal notation only — rejects hex, binary, octal and scientific
const DECIMAL_ONLY = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

function isPlainDecimal(value: unknown): boolean {
    if (isString(value)) {
        return DECIMAL_ONLY.test(value.trim());
    }
    return isNumeric(value); // number primitives: finite check still applies
}

console.log(isPlainDecimal('3.14'));  // → true
console.log(isPlainDecimal('0xFF'));  // → false — isNumeric alone would accept it
console.log(isPlainDecimal('42px'));  // → false
```

### isTemplateString checks syntax, not resolvability

A `true` from `isTemplateString` only means the text contains a well-formed placeholder — not that formatting will change anything. Use it to skip parsing work for plain text, never to promise substitution.

```typescript
import { formatString, isTemplateString } from 'blendsdk/stdlib';

const template = 'Hello ${missing}';
const rendered = formatString(template, {});

console.log(isTemplateString(template)); // → true — shape is valid
console.log(rendered === template);      // → true — nothing was substituted
```

### Boxed primitives fail all type guards

`new String("x")` and `new Boolean(true)` are objects, not primitives — `typeof` reports `"object"`, so the guards return `false`. Avoid the wrapper constructors; if a wrapper reaches you anyway, unwrap it deliberately.

```typescript
import { isBoolean, isString } from 'blendsdk/stdlib';

console.log(isString(new String('hello'))); // → false — object wrapper, not a primitive
console.log(isBoolean(new Boolean(true)));  // → false — object wrapper, not a primitive

const wrapped = new String('hello');
console.log(isString(wrapped.valueOf()));   // → true — unwrapped primitive
```

### The strings "undefined" and "null" are ordinary strings

`isNullOrUndef` is a strict two-value test. The string `'undefined'` is a defined value — it does not trigger fallbacks and is not discarded by `wrapInArray`. When you parse serialized data that uses these strings as markers, normalize them explicitly.

```typescript
import { isNullOrUndef, wrapInArray } from 'blendsdk/stdlib';

console.log(isNullOrUndef('undefined'));       // → false — a valid string
console.log(wrapInArray<string>('undefined')); // → [ 'undefined' ]

// Normalize textual nullish markers yourself when reading serialized data
function fromSerialized(value: string): string | null {
    return value === 'undefined' || value === 'null' ? null : value;
}

console.log(fromSerialized('undefined')); // → null
console.log(fromSerialized('Alice'));     // → Alice
```

### wrapInArray never spreads and never copies

Only real arrays pass through — and by reference, not as a copy. `Set`, `Map`, `arguments`-like objects and other array-likes are treated as single values and wrapped, which is correct for normalization but wrong for "expand this collection" intents.

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

const set = new Set<string>(['a', 'b']);
console.log(wrapInArray<string>(set));
// → [ Set(2) { 'a', 'b' } ] — wrapped as one element, not spread

const items: string[] = ['a'];
console.log(wrapInArray<string>(items) === items);
// → true — the same array reference is returned, no copy is made

// Spread first when expansion is the intent:
const flattened: string[] = wrapInArray<string>([...set]);
console.log(flattened); // → [ 'a', 'b' ]
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
