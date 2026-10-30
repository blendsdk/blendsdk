> **Package**: `blendsdk/stdlib`

# stdlib Advanced Patterns

This document is the third layer of the stdlib documentation. The Overview introduces the package and Core Concepts explains each primitive in isolation; this document shows what happens when the primitives are **composed** into complete, real-world solutions. Every pattern names the problem it solves, provides a complete strict-mode TypeScript program, explains why the composition is valuable, and lists its caveats — including performance considerations.

Because stdlib sits at the bottom of the BlendSDK dependency graph, these patterns are also the shared vocabulary of the rest of the monorepo: other `blendsdk/*` packages and applications build on exactly these primitives, so code that follows these patterns validates, defaults, and renders consistently wherever it runs.

The five patterns, at a glance:

| # | Pattern | Combines | Solves |
| --- | --- | --- | --- |
| 1 | [Typed configuration](#pattern-1-typed-configuration-from-untrusted-sources) | `isNumeric`, `isBoolean`, `isString`, `wrapInArray` | Loading env vars and JSON through one strict loader with safe defaults |
| 2 | [Boundary normalization](#pattern-2-boundary-normalization-for-api-payloads) | `isString`, `isBoolean`, `isNullOrUndef`, `isNumeric`, `wrapInArray` | Turning untrusted payloads into validated, normalized, fully typed input |
| 3 | [Template fallback chains](#pattern-3-template-fallback-chains) | `formatString`, `isTemplateString` | Sending the most specific template that fully resolves — never a half-rendered one |
| 4 | [Batch personalization](#pattern-4-batch-personalization-with-correct-falsy-semantics) | `formatString`, `isTemplateString`, `wrapInArray` | Rendering many messages without confusing `0`/`false` with "missing" |
| 5 | [Loose idiom migration](#pattern-5-migrating-loose-javascript-idioms) | all eight primitives | Replacing unsafe JavaScript idioms with strict, self-documenting equivalents |

---

## Pattern 1: Typed Configuration from Untrusted Sources

**Combines**: `isNumeric`, `isBoolean`, `isString`, `wrapInArray`

### When to Use

- Your application is configured through `process.env` (every value is a `string`), JSON configuration files (values are typed), or both — often in the same deployment.
- Configuration values may be absent, empty, or malformed, and the application must still start with safe defaults.
- You want a single loader with one documented behavior instead of per-variable ad-hoc parsing spread through the codebase.

### Complete Example

```typescript
import {
    isBoolean,
    isNumeric,
    isString,
    wrapInArray
} from 'blendsdk/stdlib';

type RawConfig = Record<string, unknown>;

// Numbers arrive as strings from env vars and as numbers from JSON.
// isNumeric accepts both — and rejects '8080px', NaN and Infinity.
function readNumber(raw: RawConfig, key: string, fallback: number): number {
    const value = raw[key];
    return isNumeric(value) ? Number(value) : fallback;
}

// Booleans arrive as real booleans from JSON or as strings from env vars.
function readBoolean(raw: RawConfig, key: string, fallback: boolean): boolean {
    const value = raw[key];
    if (isBoolean(value)) {
        return value;
    }
    if (isString(value)) {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') {
            return true;
        }
        if (normalized === 'false' || normalized === '0') {
            return false;
        }
    }
    return fallback;
}

// Lists arrive as a comma-separated string, a real array — or not at all.
function readList(raw: RawConfig, key: string): string[] {
    const value = raw[key];
    const items: unknown[] = isString(value) ? value.split(',') : wrapInArray<unknown>(value);
    return items
        .filter((item): item is string => isString(item))
        .map((item) => item.trim())
        .filter((item) => item !== '');
}

type ServerConfig = {
    port: number;
    debug: boolean;
    allowedOrigins: string[];
};

function loadServerConfig(raw: RawConfig): ServerConfig {
    return {
        port: readNumber(raw, 'PORT', 3000),
        debug: readBoolean(raw, 'DEBUG', false),
        allowedOrigins: readList(raw, 'ALLOWED_ORIGINS')
    };
}

// One loader, two sources — no branching at the call site.
const fromEnv = loadServerConfig({
    PORT: '8080',
    DEBUG: 'true',
    ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com'
});

const fromJson = loadServerConfig({
    PORT: 8080,
    DEBUG: false,
    ALLOWED_ORIGINS: ['https://a.example.com']
});

console.log(fromEnv);
// → { port: 8080, debug: true, allowedOrigins: [ 'https://a.example.com', 'https://b.example.com' ] }

console.log(fromJson);
// → { port: 8080, debug: false, allowedOrigins: [ 'https://a.example.com' ] }

// Before/after: the loose idiom silently truncates, the strict loader rejects
const loose = parseInt('8080px', 10);                     // → 8080 — garbage accepted
const strict = loadServerConfig({ PORT: '8080px' }).port; // → 3000 — garbage rejected
console.log({ loose, strict });
// → { loose: 8080, strict: 3000 }
```

### Why This Pattern Is Valuable

- **One behavior for two worlds.** The same loader serves env vars (strings) and JSON files (typed values) without the call site knowing which source it has. The strict core — `isNumeric` — eliminates the partial-parse class of bugs: `'8080px'` becomes the documented default `3000`, not `8080` and not `NaN`.
- **Explicit failure mode.** Bad values degrade to declared defaults rather than leaking `NaN` into arithmetic or `undefined` into URLs later in the program.
- **Type predicates narrow inside the loaders.** `isString(value)` inside `readBoolean` makes the string branch fully typed without casts, so the parsing logic itself is checked by the compiler.
- **Nullish lists just work.** `wrapInArray` maps "not configured" (`undefined`) to `[]`, so list consumers never branch on whether configuration was provided.

### Caveats and Performance

- `readNumber` uses `Number(value)` after `isNumeric` approves it, so every JavaScript numeric literal is honored — `'0xFF'` becomes `255` and `'1e3'` becomes `1000`. If your configuration contract is decimal-only, add an explicit `^\d+$` check on top.
- `readList` silently drops non-string entries and empty items. If silently dropping is unacceptable, collect the rejected items and fail the load instead.
- `readList` always returns a fresh array (the `filter`/`map` chain), so the raw configuration object is never mutated — even though `wrapInArray` itself passes arrays through by reference.
- Every check is a `typeof` call or a trim-and-parse — constant work per key. A full load of a dozen keys costs far less than the file or process I/O that surrounds it.

---

## Pattern 2: Boundary Normalization for API Payloads

**Combines**: `isString`, `isBoolean`, `isNullOrUndef`, `isNumeric`, `wrapInArray`

### When to Use

- Your service receives `unknown` data at a boundary: an HTTP request body, a queue message, a parsed form.
- Invalid input must be rejected loudly and early, while valid input should be normalized once (trimmed, cased, defaulted) so no downstream code repeats the work.
- Fields may arrive as a single value or a list, and the rest of the codebase should never see the difference.

Unlike Pattern 1 — where bad values silently degrade to defaults so the process can start — a request boundary must **throw** on invalid input. The guards make that distinction explicit.

### Complete Example

```typescript
import {
    isBoolean,
    isNumeric,
    isNullOrUndef,
    isString,
    wrapInArray
} from 'blendsdk/stdlib';

type CreateUserInput = {
    name: string;
    email: string;
    age: number | null;
    newsletter: boolean;
    roles: string[];
};

class ValidationError extends Error {
    constructor(field: string) {
        super(`Invalid or missing value for field: ${field}`);
        this.name = 'ValidationError';
    }
}

// stdlib validates values, not shapes — the one structural check stays local.
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Every guarantee of CreateUserInput is established here, exactly once.
function normalizeCreateUser(body: unknown): CreateUserInput {
    if (!isRecord(body)) {
        throw new ValidationError('body');
    }

    const name = body.name;
    if (!isString(name) || name.trim() === '') {
        throw new ValidationError('name');
    }

    const email = body.email;
    if (!isString(email) || !email.includes('@')) {
        throw new ValidationError('email');
    }

    const age = body.age;
    if (!isNullOrUndef(age) && !isNumeric(age)) {
        throw new ValidationError('age');
    }

    const newsletter = body.newsletter;
    const roles = body.roles;

    return {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        age: isNullOrUndef(age) ? null : Number(age),
        newsletter: isBoolean(newsletter) ? newsletter : false,
        roles: wrapInArray<unknown>(roles)
            .filter((role): role is string => isString(role))
            .map((role) => role.trim().toLowerCase())
            .filter((role) => role !== '')
    };
}

const rawBody = '{"name":"  Alice  ","email":"ALICE@EXAMPLE.COM","age":30,"roles":["ADMIN"," editor "]}';
const parsed: unknown = JSON.parse(rawBody);

console.log(normalizeCreateUser(parsed));
// → { name: 'Alice', email: 'alice@example.com', age: 30, newsletter: false, roles: [ 'admin', 'editor' ] }

// A single role arrives as a plain string — wrapInArray removes the branch
console.log(normalizeCreateUser({ name: 'Bob', email: 'bob@example.com', roles: 'viewer' }));
// → { name: 'Bob', email: 'bob@example.com', age: null, newsletter: false, roles: [ 'viewer' ] }

// Strict guards reject ambiguous values instead of coercing them
try {
    normalizeCreateUser({ name: 'Eve', email: 'eve@example.com', age: '42px' });
} catch (error) {
    if (error instanceof ValidationError) {
        console.log(error.message);
        // → Invalid or missing value for field: age
    }
}
```

### Why This Pattern Is Valuable

- **The boundary owns all uncertainty.** Downstream code receives a fully typed `CreateUserInput` with no nullish handling, no trimming, and no casing concerns — every consumer is simpler and safer.
- **`isNullOrUndef` + `isNumeric` preserve the difference between "absent" and "falsy".** The common shortcut, `body.age ? Number(body.age) : null`, silently turns a legitimate `0` (and `''`) into `null`. The explicit pair keeps `null` meaning *not provided*, while `0` stays `0` and `'42px'` is rejected.
- **`wrapInArray` collapses the single-vs-list branch.** Clients may send `"roles": "viewer"` or `"roles": ["viewer"]`; the normalizer ends with `string[]` either way.
- **Errors are actionable.** Throwing `ValidationError` with the field name lets the transport layer translate it into a precise `400` response instead of a generic failure.

### Caveats and Performance

- The normalizer accepts numeric strings for `age` (`isNumeric('30')` passes), because form encodings frequently produce them. Decide whether your API allows that and document it; tighten with `typeof age === 'number'` if it must be strictly typed JSON.
- `roles` silently drops non-string elements and empty strings. If drop-versus-reject matters for your contract, count the dropped items and throw instead.
- `isRecord` is application code. stdlib deliberately checks individual values, not object shapes — structural validation is your domain (pair stdlib's primitives with a schema validator if shapes grow complex).
- A handful of `typeof` checks and trims per request is negligible next to the `JSON.parse` that preceded it. Resist replacing these primitives with regex-based validators in hot paths.

---

## Pattern 3: Template Fallback Chains

**Combines**: `formatString`, `isTemplateString`

### When to Use

- Users or tenants can supply their own message templates that override built-in defaults (notifications, emails, log lines).
- A partially resolvable template must never reach a recipient — `Hey Alice! Order A-1024 is ${order.status}.` must fall back, not ship.
- You need deterministic precedence: the most specific template that *fully resolves* wins, and which tier fired should be observable.

The pattern builds on two documented behaviors: `formatString` preserves unresolved placeholders verbatim (never inserts `undefined`), and `isTemplateString` detects the exact same placeholder grammar — so "contains a placeholder after rendering" means "this template was incomplete for these params".

### Complete Example

```typescript
import { formatString, isTemplateString } from 'blendsdk/stdlib';

type TemplateSource = 'user' | 'tenant' | 'default';

type TemplateCandidate = {
    source: TemplateSource;
    template: string;
};

type NotificationParams = {
    user: { firstName?: string };
    order: { id?: string; total?: number; status?: string };
};

const DEFAULT_TEMPLATE =
    'Hi ${user.firstName|customer}, your order ${order.id|#unknown} is confirmed (total: ${order.total|0}).';

function renderNotification(
    candidates: TemplateCandidate[],
    params: NotificationParams
): { source: TemplateSource; text: string } {
    for (const candidate of candidates) {
        const rendered = formatString(candidate.template, params);
        // formatString preserves unresolved placeholders — if none remain,
        // this template covered every placeholder for these params.
        if (!isTemplateString(rendered)) {
            return { source: candidate.source, text: rendered };
        }
    }
    return { source: 'default', text: formatString(DEFAULT_TEMPLATE, params) };
}

const params: NotificationParams = {
    user: { firstName: 'Alice' },
    order: { id: 'A-1024', total: 49.5 }
};

const userTemplate: TemplateCandidate = {
    source: 'user',
    // References ${order.status}, which is not present in params
    template: 'Hey ${user.firstName}! Order ${order.id} is ${order.status}.'
};

const tenantTemplate: TemplateCandidate = {
    source: 'tenant',
    template: 'Dear ${user.firstName}, order ${order.id} (${order.total} EUR) is confirmed.'
};

// The user template leaves ${order.status} unresolved → the tenant template wins
console.log(renderNotification([userTemplate, tenantTemplate], params));
// → { source: 'tenant', text: 'Dear Alice, order A-1024 (49.5 EUR) is confirmed.' }

// A fully provisioned user template wins the chain
const completeUserTemplate: TemplateCandidate = {
    source: 'user',
    template: 'Hey ${user.firstName}! Order ${order.id} is confirmed.'
};

console.log(renderNotification([completeUserTemplate, tenantTemplate], params));
// → { source: 'user', text: 'Hey Alice! Order A-1024 is confirmed.' }

// Plain text has no placeholders and always resolves
console.log(renderNotification([{ source: 'tenant', template: 'Service maintenance tonight.' }], params));
// → { source: 'tenant', text: 'Service maintenance tonight.' }

// Even when every candidate fails, the last-resort template degrades gracefully
console.log(renderNotification([userTemplate], { user: {}, order: {} }));
// → { source: 'default', text: 'Hi customer, your order #unknown is confirmed (total: 0).' }
```

### Why This Pattern Is Valuable

- **A half-rendered message can never ship.** The "fully resolved" test is decided by the same grammar that produced the output, so the check cannot drift from the formatter's behavior.
- **Precedence is data, not code.** Candidates are an ordered array; adding a new tier (team template, campaign template) is adding an object — the rendering function never changes.
- **Observability is built in.** The returned `source` lets you monitor how often the default tier fires. A rising default rate is an early signal that tenant templates reference keys their data no longer provides.
- **BlendSDK integration.** The pipeline ends at a plain `string`, which is what any delivery layer ultimately carries (email, pub/sub messaging). Template selection, fallbacks, and detection stay in your application layer where stdlib runs — no adapters required.

### Caveats and Performance

- **Grammar boundary.** Keys must match the placeholder grammar (`[\w.]` — word characters and dots). A template like `${full-name}` is literal text to *both* `formatString` and `isTemplateString`; it will be delivered as-is while the chain reports success. Validate authored templates against the same grammar your key set can cover.
- **Values that look like placeholders.** If a resolved *value* itself contains a placeholder-shaped substring (for example a note field containing the literal text `${x}`), the rendered output looks unresolved and triggers an unnecessary fallback. Sanitize such values if they can occur, or check for the specific placeholders you expect.
- **Give the last-resort template defaults on every placeholder** (as `DEFAULT_TEMPLATE` does), so the chain always terminates in a fully resolved string.
- **Performance:** per candidate, one `formatString` pass (a single global-regex pass) plus one regex test on the output — linear in template length and negligible beside the network I/O of delivering the message. For very high throughput with stable tenants, memoize the winning candidate per tenant.

---

## Pattern 4: Batch Personalization with Correct Falsy Semantics

**Combines**: `formatString`, `isTemplateString`, `wrapInArray`

### When to Use

- You render one template across many recipients: digests, notification batches, export headers, audit summaries.
- Zeros and `false` values are meaningful data (item counts, balances, flags) and must not collapse into "missing".
- The batch input may be a single item or a list, and a template may occasionally be fixed text with no placeholders.

### Complete Example

```typescript
import { formatString, isTemplateString, wrapInArray } from 'blendsdk/stdlib';

type DigestEntry = {
    recipient: { name?: string };
    itemCount: number;  // 0 is a meaningful value, not "empty"
    promoCode?: string; // undefined means "no personal code"
};

const DIGEST_TEMPLATE =
    'Hi ${recipient.name|valued customer}, you have ${itemCount} new items. ' +
    'Use code ${promoCode|WELCOME10} for free shipping.';

function renderDigests(
    entries: DigestEntry | DigestEntry[],
    template: string = DIGEST_TEMPLATE
): string[] {
    // One syntactic check per batch — not once per message.
    const personalizable = isTemplateString(template);

    return wrapInArray<DigestEntry>(entries).map((entry) => {
        if (!personalizable) {
            return template;
        }
        return formatString(template, {
            recipient: entry.recipient,
            itemCount: entry.itemCount,
            promoCode: entry.promoCode
        });
    });
}

const messages = renderDigests([
    { recipient: { name: 'Alice' }, itemCount: 3, promoCode: 'ALICE5' },
    { recipient: {}, itemCount: 0 } // no name, no promo code — but a very real zero
]);

console.log(messages);
// → [
//     'Hi Alice, you have 3 new items. Use code ALICE5 for free shipping.',
//     'Hi valued customer, you have 0 new items. Use code WELCOME10 for free shipping.'
//   ]

// A single entry — wrapInArray normalizes it, no branching at the call site
console.log(renderDigests({ recipient: { name: 'Bob' }, itemCount: 12 }));
// → [ 'Hi Bob, you have 12 new items. Use code WELCOME10 for free shipping.' ]

// Before — `||` cannot distinguish "missing" from "a real zero"
const sample: DigestEntry = { recipient: {}, itemCount: 0 };
console.log(`Hi ${sample.recipient.name || 'valued customer'}, you have ${sample.itemCount || 'no'} new items.`);
// → Hi valued customer, you have no new items.   ← the count is 0, not missing

// After — only undefined/null/"" fall back; 0 and false are stringified and kept
console.log(formatString(DIGEST_TEMPLATE, sample));
// → Hi valued customer, you have 0 new items. Use code WELCOME10 for free shipping.
```

### Why This Pattern Is Valuable

- **`0` and `false` survive rendering.** `formatString` falls back only for `undefined`, `null`, and `""` — the exact semantics a data pipeline needs, where `||` would silently rewrite a real zero into placeholder text.
- **One template, N recipients.** `wrapInArray` makes a single entry and a list behave identically, and the per-entry params object documents precisely which fields templates may reference.
- **The hoisted check pays for itself in clarity.** Testing `isTemplateString` once per batch gives you a `personalizable` boolean for logging while avoiding repeated classification of an unchanging template.
- **Deterministic and testable.** The rendering functions are pure: same template plus same data equals the same message, which makes snapshot tests meaningful.

### Caveats and Performance

- Only `undefined`, `null`, and `""` trigger fallback — `NaN` would render as `'NaN'`. If counts can be dirty, validate them upstream with `isNumeric` (see Patterns 1 and 2) before they enter the batch.
- `itemCount` is stringified with `String()`. Locale-specific formatting (thousands separators, currency symbols) must happen before rendering; pass the pre-formatted string as the param value.
- Keep the explicit params object in sync when templates grow — it is intentional that the compiler cannot verify placeholder names against it.
- `wrapInArray` passes an array through by reference, but `map` builds a fresh output array; the caller's entries are never mutated.

---

## Pattern 5: Migrating Loose JavaScript Idioms

**Combines**: `isString`, `isBoolean`, `isNullOrUndef`, `isNullOrUndefDefault`, `isNumeric`, `formatString`, `isTemplateString`, `wrapInArray`

### When to Use

- You are introducing `blendsdk/stdlib` into an existing codebase and want to migrate file by file instead of rewriting validation wholesale.
- You are reviewing code for unsafe coercion: `parseFloat`, `||`-based defaults, inline `typeof` checks, template literals that interpolate nullable values.
- You want one shared vocabulary for runtime checks so every module validates and defaults the same way.

### Complete Example

```typescript
import { formatString, isNumeric, isNullOrUndefDefault } from 'blendsdk/stdlib';

const env: Record<string, unknown> = { PORT: '8080px', RETRIES: '0' };
const user: { name?: string } = {};
const settings: Record<string, string> = { theme: 'dark' };

// Before — loose idioms accept garbage and clobber valid values
console.log(parseInt(String(env.PORT), 10)); // → 8080 — '8080px' silently truncated
console.log(`Hello ${user.name}`);           // → Hello undefined
console.log(Number(env.RETRIES) || 3);       // → 3 — the real 0 is lost

// After — strict validation and explicit presence rules
console.log(isNumeric(env.PORT) ? Number(env.PORT) : 3000);
// → 3000 — '8080px' rejected instead of truncated

console.log(formatString('Hello ${name|Guest}', { name: user.name }));
// → Hello Guest — a missing key uses the declared fallback, never 'undefined'

console.log(isNumeric(env.RETRIES) ? Number(env.RETRIES) : 3);
// → 0 — a numeric zero is kept, not replaced

console.log(isNullOrUndefDefault(settings.locale, 'en-US'));
// → en-US — absent settings fall back without touching '', 0 or false
```

### The Replacement Table

| Loose idiom | Why it is unsafe | stdlib replacement |
| --- | --- | --- |
| `typeof value === 'string'` | Re-typed at every call site; the check cannot be reused as a single narrowing unit | `isString(value)` |
| `typeof value === 'boolean'` | Same duplication; `'true'` / `'false'` strings pass silently when the check is careless | `isBoolean(value)` |
| `value === null \|\| value === undefined` | Verbose, and the common shortcut `!value` is wrong for `""`, `0`, `false` and `NaN` | `isNullOrUndef(value)` |
| `value \|\| fallback` | Replaces `""`, `0`, `false` and `NaN` — valid data is silently clobbered | `isNullOrUndefDefault(value, fallback)` |
| `parseFloat(value)` / `parseInt(value, 10)` | Partial parses: `'42px'` becomes `42`; `Infinity` and `'Infinity'` need a separate `isFinite` check | `isNumeric(value)` + `Number(value)` |
| `isNaN(Number(value))` | Treats `''` as `0` and accepts `'Infinity'` as a number | `isNumeric(value)` |
| `Array.isArray(value) ? value : [value]` | Nullish input produces `[null]` / `[undefined]` instead of `[]` | `wrapInArray<T>(value)` |
| `` `Hi ${name}` `` with nullable `name` | Prints `'undefined'` / `'null'` straight into user-facing text | `formatString('Hi ${name\|Guest}', params)` |
| `value.includes('${')` | Every `${` counts — including malformed fragments that can never resolve | `isTemplateString(value)` |
| Hand-rolled `value.replace(/\$\{(\w+)\}/g, ...)` | Re-implements defaults, nesting and stringification inconsistently; commonly inserts `'undefined'` | `formatString(template, params)` |

### Why This Pattern Is Valuable

- **Migration is mechanical.** Each table row is a drop-in replacement with identical or stricter semantics, so you can convert call sites one at a time without redesigning them.
- **The improvements are behavioral, and they compound.** `'42px'` stops flowing into arithmetic; `0` and `''` stop being clobbered; user-facing text stops containing `'undefined'`. Every downstream module inherits the stricter behavior.
- **One vocabulary across the codebase.** When every module uses the same primitives, reviewers and new contributors recognize a correct check instantly — the subtle `!value` bug has a canonical replacement to point at.

### Caveats and Performance

- `isNullOrUndefDefault` is **not** a rename of `||` — swapping `value || fallback` for it is a deliberate semantic change for falsy values. Review each call site before converting.
- The helper's result type keeps the input's static union (e.g. `string | undefined`), whereas `??` narrows the result at compile time. Use `??` when you specifically want the narrowed type; use the helper when you want the shared, two-value runtime behavior reusable in expression and function positions. They agree on runtime semantics.
- `isNumeric` accepts every JavaScript numeric literal format (`'0xFF'`, `'1e3'`, `'.5'`). If your data contract is decimal-only, add an explicit shape check on top of it.
- Every replacement is constant-time; the function-call overhead versus an inline `typeof` is trivial and V8 inlines these primitives readily. Batch-level checks (as in Pattern 4) reduce the count further when you are in a loop.

---

# stdlib Common Scenarios

This document answers the most common "How do I…" questions about `blendsdk/stdlib` — a task-oriented companion to the Overview and Core Concepts. Every scenario is self-contained and follows the same shape: the question, a short solution, and a complete TypeScript example that runs as-is (ESM, Node.js >= 22). Scenarios are ordered from simple single-function checks to composed, real-world pipelines, and every example shows its expected output in comments.

---

## Scenario Index

| # | Scenario | Functions used |
| --- | --- | --- |
| 1 | [How do I check if a value is a string at runtime?](#how-do-i-check-if-a-value-is-a-string-at-runtime) | `isString` |
| 2 | [How do I check if a value is a boolean?](#how-do-i-check-if-a-value-is-a-boolean) | `isBoolean` |
| 3 | [How do I test whether a value is null or undefined?](#how-do-i-test-whether-a-value-is-null-or-undefined) | `isNullOrUndef` |
| 4 | [How do I fall back to a default for null or undefined values?](#how-do-i-fall-back-to-a-default-for-null-or-undefined-values) | `isNullOrUndefDefault` |
| 5 | [How do I validate numeric input strictly?](#how-do-i-validate-numeric-input-strictly) | `isNumeric` |
| 6 | [How do I normalize a single value or a list into an array?](#how-do-i-normalize-a-single-value-or-a-list-into-an-array) | `wrapInArray` |
| 7 | [How do I detect whether a string contains template placeholders?](#how-do-i-detect-whether-a-string-contains-template-placeholders) | `isTemplateString` |
| 8 | [How do I substitute values into a template string?](#how-do-i-substitute-values-into-a-template-string) | `formatString` |
| 9 | [How do I provide default values inside a template?](#how-do-i-provide-default-values-inside-a-template) | `formatString` |
| 10 | [How do I read nested object values in a template?](#how-do-i-read-nested-object-values-in-a-template) | `formatString` |
| 11 | [How do I render numbers, booleans, zero and false in a template?](#how-do-i-render-numbers-booleans-zero-and-false-in-a-template) | `formatString` |
| 12 | [How do I safely process a value of unknown type?](#how-do-i-safely-process-a-value-of-unknown-type) | `isString`, `isBoolean`, `isNumeric`, `isTemplateString`, `formatString` |
| 13 | [How do I build a typed configuration reader from an untyped map?](#how-do-i-build-a-typed-configuration-reader-from-an-untyped-map) | `isNullOrUndefDefault`, `isNumeric`, `wrapInArray`, `formatString` |
| 14 | [How do I handle the most common edge cases?](#how-do-i-handle-the-most-common-edge-cases) | `isString`, `isBoolean`, `isNullOrUndef`, `isNullOrUndefDefault`, `isNumeric`, `formatString`, `wrapInArray` |

---

## How do I check if a value is a string at runtime?

**Solution** — Use `isString`. It is a type predicate: it returns `true` only for string primitives, and inside the successful branch TypeScript narrows the tested value from `unknown` to `string`. Object wrappers created with `new String("x")` are not primitives, so they return `false`.

```typescript
import { isString } from 'blendsdk/stdlib';

function describeValue(value: unknown): string {
    if (isString(value)) {
        // `value` is narrowed to `string` here
        return `"${value}" has ${value.length} character(s)`;
    }
    return `not a string (typeof is "${typeof value}")`;
}

console.log(describeValue('hello'));          // → "hello" has 5 character(s)
console.log(describeValue(42));               // → not a string (typeof is "number")
console.log(describeValue(new String('hi'))); // → not a string (typeof is "object")
```

---

## How do I check if a value is a boolean?

**Solution** — Use `isBoolean`. It returns `true` only for boolean primitives — the string `"true"`, the numbers `0` and `1`, and `new Boolean(true)` wrappers all return `false`. In the successful branch the value narrows to `boolean`, including when you check a property expression.

```typescript
import { isBoolean } from 'blendsdk/stdlib';

function toFlag(value: unknown): boolean {
    // Only real booleans pass — the string "true" does not
    return isBoolean(value) ? value : false;
}

console.log(toFlag(true));   // → true
console.log(toFlag(false));  // → false
console.log(toFlag('true')); // → false (string, not a boolean)
console.log(toFlag(1));      // → false (number, not a boolean)

// Property access narrows too
const config: { readonly debug?: unknown } = { debug: true };
if (isBoolean(config.debug)) {
    console.log(config.debug ? 'debugging on' : 'debugging off'); // → debugging on
}
```

---

## How do I test whether a value is null or undefined?

**Solution** — Use `isNullOrUndef`, a strict two-value test that narrows in both directions: after `if (!isNullOrUndef(value))`, TypeScript knows the value is neither `null` nor `undefined`. Everything else — including `""`, `0`, `false`, `NaN` and the string `"undefined"` — counts as a defined value.

```typescript
import { isNullOrUndef } from 'blendsdk/stdlib';

function normalizeName(value: string | null | undefined): string {
    if (isNullOrUndef(value)) {
        return 'anonymous';
    }
    // `value` is narrowed to `string` here
    return value.trim();
}

console.log(normalizeName('  Alice  ')); // → Alice
console.log(normalizeName(null));        // → anonymous
console.log(normalizeName(undefined));   // → anonymous

// Negated checks narrow as well
const level: string | undefined = process.env.LOG_LEVEL;
if (!isNullOrUndef(level)) {
    console.log(`log level: ${level.toUpperCase()}`);
}

// These are all *defined* values
console.log(isNullOrUndef(''));          // → false
console.log(isNullOrUndef(0));           // → false
console.log(isNullOrUndef('undefined')); // → false (it is a real string)
```

---

## How do I fall back to a default for null or undefined values?

**Solution** — Use `isNullOrUndefDefault(value, fallback)`. Only `null` and `undefined` trigger the fallback, so falsy-but-real values such as `""`, `0` and `false` pass through untouched — the semantics of `??`, wrapped as a reusable function. One typing note: a single type parameter is shared by both arguments, so the result type mirrors the input — a value typed `string | undefined` stays `string | undefined` to the compiler, even though the runtime result is always concrete.

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

// Lookups can be typed `string` yet be missing at runtime —
// exactly the gap this helper closes.
const settings: Record<string, string> = { theme: 'dark' };

const theme: string = isNullOrUndefDefault(settings.theme, 'light');   // → 'dark'
const locale: string = isNullOrUndefDefault(settings.locale, 'en-US'); // → 'en-US'

// Only null/undefined trigger the fallback — falsy values survive
const retries: number = isNullOrUndefDefault(0, 5);         // → 0
const label: string = isNullOrUndefDefault('', 'untitled'); // → ''
const verbose: boolean = isNullOrUndefDefault(false, true); // → false

console.log({ theme, locale, retries, label, verbose });
// → { theme: 'dark', locale: 'en-US', retries: 0, label: '', verbose: false }
```

---

## How do I validate numeric input strictly?

**Solution** — Use `isNumeric`, which accepts finite number primitives and strings that fully represent one (`"42"`, `" 3.14 "`, `"0xFF"`, `"1e10"`). It rejects what coercing APIs would accept: `"42px"` and `"100%"` (no partial parses), `"1,000"` and `"3.14.15"` (not valid literals), and `NaN`/`Infinity` (not finite). Because success may mean a number *or* a numeric string, `isNumeric` is not a type predicate — convert explicitly with `Number(value)` once validation passes.

```typescript
import { isNumeric } from 'blendsdk/stdlib';

function parsePort(value: unknown): number | undefined {
    if (isNumeric(value)) {
        return Number(value);
    }
    return undefined;
}

console.log(parsePort('8080'));          // → 8080
console.log(parsePort(' 3000 '));        // → 3000 (whitespace is trimmed)
console.log(parsePort(5432));            // → 5432
console.log(parsePort('0xFF'));          // → 255 (any JS numeric literal works)
console.log(parsePort('8080px'));        // → undefined (parseFloat would return 8080)
console.log(parsePort('1,000'));         // → undefined
console.log(parsePort(''));              // → undefined
console.log(parsePort(NaN));             // → undefined
console.log(parsePort(Infinity));        // → undefined
console.log(parsePort(Symbol('42')));    // → undefined (never throws)
```

---

## How do I normalize a single value or a list into an array?

**Solution** — Use `wrapInArray<T>(value)`: `null`/`undefined` become `[]`, an array is returned unchanged (same reference, no copy), and anything else is wrapped as a single element — ideal for `value | value[] | undefined` configuration shapes. The generic `T` is your declaration about the element type, so validate raw external data with the type guards first.

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
const wrapped: string[] = wrapInArray<string>(tags);
console.log(wrapped === tags); // → true

// Only real arrays pass through — a Set is wrapped as a single element
console.log(wrapInArray(new Set(['a', 'b'])).length); // → 1
```

---

## How do I detect whether a string contains template placeholders?

**Solution** — Use `isTemplateString` for a cheap syntactic pre-check. It returns `true` as soon as one well-formed `${...}` placeholder is found, and `false` for plain text and malformed fragments (such as an unclosed `${`). It is syntax-only: whether a placeholder's key can actually be resolved is decided later by `formatString`.

```typescript
import { isTemplateString } from 'blendsdk/stdlib';

function classify(value: string): 'template' | 'plain text' {
    return isTemplateString(value) ? 'template' : 'plain text';
}

console.log(classify('Hello ${name}'));        // → template
console.log(classify('Hello ${name|World}'));  // → template
console.log(classify('${user.address.city}')); // → template
console.log(classify('Hello world'));          // → plain text
console.log(classify('Hello ${'));             // → plain text (unclosed)
console.log(classify('Hello ${}'));            // → plain text (no key)
```

---

## How do I substitute values into a template string?

**Solution** — Call `formatString(template, params?)`. Every `${key}` placeholder is replaced with `String(value)` from `params`; placeholders that cannot be resolved are kept verbatim rather than silently dropped, and the function never throws. Omitting `params` entirely is valid — defaults inside the placeholders still resolve.

```typescript
import { formatString } from 'blendsdk/stdlib';

const template = 'Order ${id} shipped to ${city} on ${date}';

const message: string = formatString(template, {
    id: 'A-1024',
    city: 'Amsterdam',
    date: '2025-01-15'
});

console.log(message);
// → Order A-1024 shipped to Amsterdam on 2025-01-15

// Unresolvable placeholders are kept visible — never silently emptied
console.log(formatString('Hello ${unknown}', { id: 'A-1024' }));
// → Hello ${unknown}

// Plain text is returned unchanged (fast path)
console.log(formatString('No placeholders here'));
// → No placeholders here
```

---

## How do I provide default values inside a template?

**Solution** — Append a default after a pipe: `${name|Guest}`. The default applies when the key is missing or its value is `null`, `undefined` or `""`; a present value always wins. Only the first `|` splits key from default, and the default text is inserted verbatim — spaces and special characters included (only `}` cannot appear in it).

```typescript
import { formatString } from 'blendsdk/stdlib';

// The default applies when the key is missing, null, undefined or ""
console.log(formatString('Hello ${name|Guest}'));                      // → Hello Guest
console.log(formatString('Hello ${name|Guest}', { name: undefined })); // → Hello Guest
console.log(formatString('Hello ${name|Guest}', { name: null }));      // → Hello Guest
console.log(formatString('Hello ${name|Guest}', { name: '' }));        // → Hello Guest

// A present value always wins over its default
console.log(formatString('Hello ${name|Guest}', { name: 'Alice' }));   // → Hello Alice

// Defaults are inserted verbatim — spaces and special characters included
console.log(formatString('Contact: ${email|no-reply@example.com}'));
// → Contact: no-reply@example.com

// An empty default is valid — useful for optional text
console.log(formatString('Hello${suffix|}', { suffix: '' }));
// → Hello
```

---

## How do I read nested object values in a template?

**Solution** — Use dot-notation paths inside placeholders — `${customer.name}`, `${a.b.c.d}`. Each segment is walked through the params object, and a missing or nullish intermediate makes the value "missing", so the usual fallback rules apply: use the default if one was given, otherwise keep the placeholder.

```typescript
import { formatString } from 'blendsdk/stdlib';

const params: Record<string, unknown> = {
    customer: {
        name: 'Alice',
        address: { city: 'Amsterdam' }
    },
    total: 99.5
};

console.log(formatString('${customer.name} (${customer.address.city}) — total: $${total}', params));
// → Alice (Amsterdam) — total: $99.5

// Missing nested value: the default applies when given…
console.log(formatString('${customer.name} from ${customer.address.zip|unknown}', params));
// → Alice from unknown

// …and the placeholder is kept verbatim when there is no default
console.log(formatString('${customer.phone}', params));
// → ${customer.phone}

// Nullish intermediates abandon the path — fallback rules apply as usual
console.log(formatString('${account.id|none}', { account: null }));
// → none
```

---

## How do I render numbers, booleans, zero and false in a template?

**Solution** — Pass values as-is: `0`, `false` and negative or fractional numbers are present values, stringified with `String(value)`, and never trigger a placeholder default — only `undefined`, `null` and `""` count as missing. When you need zero-aware wording, decide it in code and format the resulting string.

```typescript
import { formatString } from 'blendsdk/stdlib';

const stats = { count: 0, active: false, delta: -5, price: 9.99 };

// 0 and false are real values — the defaults do NOT kick in
console.log(formatString(
    'count: ${count|1}, active: ${active|true}, delta: ${delta|0}, price: $${price|0}',
    stats
));
// → count: 0, active: false, delta: -5, price: $9.99

// For zero-aware wording, compute the text in code — defaults only cover missing values
const count: number = 0;
const label: string = count === 0 ? 'none' : String(count);
console.log(formatString('items: ${label}', { label }));
// → items: none
```

---

## How do I safely process a value of unknown type?

**Solution** — Validate first, then use. The guards are type predicates, so a short chain of checks turns `unknown` into fully typed values before any real work happens — and each step's narrowing carries into the next one. Order the checks from most specific to broadest, as in the `isString` → `isTemplateString` → `formatString` pipeline below.

```typescript
import {
    formatString,
    isBoolean,
    isNumeric,
    isString,
    isTemplateString
} from 'blendsdk/stdlib';

// A validate-then-use pipeline for untrusted input
function renderTemplate(template: unknown, params?: Record<string, unknown>): string {
    if (!isString(template)) {
        return '';
    }
    if (!isTemplateString(template)) {
        return template;
    }
    return formatString(template, params);
}

console.log(renderTemplate('Hello ${name}', { name: 'Alice' })); // → Hello Alice
console.log(renderTemplate('Plain text'));                       // → Plain text
console.log(renderTemplate(42));                                 // → ''

// Guards compose inside expressions as well
function describeInput(value: unknown): string {
    if (isBoolean(value)) {
        return `boolean: ${value}`;
    }
    if (isString(value) && isNumeric(value)) {
        return `numeric string: ${value}`;
    }
    return `other: ${typeof value}`;
}

console.log(describeInput(true)); // → boolean: true
console.log(describeInput('42')); // → numeric string: 42
console.log(describeInput({}));   // → other: object
```

---

## How do I build a typed configuration reader from an untyped map?

**Solution** — Compose the helpers into small accessors: `isNullOrUndefDefault` for fallbacks, `isNumeric` plus `Number()` for numeric values, `wrapInArray<T>` for single-or-list shapes, and `formatString` for the final composed message. Every lookup is validated at the point of use, so a single missing key degrades gracefully instead of crashing.

```typescript
import {
    formatString,
    isNumeric,
    isNullOrUndefDefault,
    wrapInArray
} from 'blendsdk/stdlib';

interface ServerConfig {
    host: string;
    port: number;
    featured: string[];
    banner: string;
}

// Values can be missing at runtime even though the map is typed as strings —
// treat every lookup as potentially nullish and validate before converting.
function readConfig(source: Record<string, string>): ServerConfig {
    const host: string = isNullOrUndefDefault(source.HOST, 'localhost');

    const port: number = isNumeric(source.PORT) ? Number(source.PORT) : 3000;

    const featured: string[] = wrapInArray<string>(source.FEATURED)
        .filter((name) => name.length > 0); // drop empty values such as FEATURED=''

    const banner: string = formatString('${host}:${port} serving ${count} plugin(s)', {
        host,
        port,
        count: featured.length
    });

    return { host, port, featured, banner };
}

console.log(readConfig({ HOST: 'api.example.com', PORT: '8080', FEATURED: 'search' }));
// → { host: 'api.example.com', port: 8080, featured: [ 'search' ],
//      banner: 'api.example.com:8080 serving 1 plugin(s)' }

console.log(readConfig({}));
// → { host: 'localhost', port: 3000, featured: [],
//      banner: 'localhost:3000 serving 0 plugin(s)' }
```

---

## How do I handle the most common edge cases?

**Solution** — Six behaviors explain nearly every surprise developers hit with these utilities: the string `"undefined"` is a real value, object wrappers like `new String(...)` are not primitives, `""` is "missing" inside templates but preserved by `isNullOrUndefDefault`, `NaN`/`Infinity` are rejected by `isNumeric` while `-0` passes, malformed placeholders are never half-processed, and there is no way to escape a `${`. The example demonstrates each one with its expected output.

```typescript
import {
    formatString,
    isBoolean,
    isNullOrUndef,
    isNullOrUndefDefault,
    isNumeric,
    isString,
    wrapInArray
} from 'blendsdk/stdlib';

// 1. "undefined" is a real string — not a nullish value
console.log(isNullOrUndef('undefined'));              // → false
console.log(wrapInArray('undefined'));                // → [ 'undefined' ]

// 2. Object wrappers are not primitives — the guards return false
console.log(isString(String('hi')));                  // → true  (primitive)
console.log(isString(new String('hi')));              // → false (wrapper object)
console.log(isBoolean(new Boolean(true)));            // → false (wrapper object)

// 3. "" means "missing" in a template, but is kept by isNullOrUndefDefault
console.log(formatString('${name|Guest}', { name: '' })); // → Guest
console.log(isNullOrUndefDefault('', 'Guest'));           // → ''

// 4. isNumeric rejects non-finite numbers but keeps zero variants
console.log(isNumeric(NaN));                          // → false
console.log(isNumeric(Infinity));                     // → false
console.log(isNumeric(-0));                           // → true

// 5. Malformed placeholders are never half-processed
console.log(formatString('Hello ${'));                // → Hello ${
console.log(formatString('Hello ${}'));               // → Hello ${}

// 6. There is no escaping for ${ — a backslash is just a character
console.log(formatString('\\${name}', { name: 'test' })); // → \test
```

---

# stdlib Examples Library

A categorized collection of complete, copy-paste ready examples for `blendsdk/stdlib`. Every example is a self-contained ESM program that follows the BlendSDK TypeScript standards: strict typing, named imports from the package root, and zero runtime dependencies. Examples are ordered from simple to complex within each category, and expected output is shown as comments inside the code blocks.

Run each example with a TypeScript-capable ESM runner or compile it with `tsc` first. Node.js >= 22.0.0 is required.

## Example Index

| # | Category | Covers | Examples |
| --- | --- | --- | --- |
| 1 | [Runtime Type Guards](#runtime-type-guards) | `isString`, `isBoolean`, `isNullOrUndef` | 4 |
| 2 | [Nullish Fallbacks](#nullish-fallbacks) | `isNullOrUndefDefault` | 3 |
| 3 | [Numeric Validation](#numeric-validation) | `isNumeric` | 3 |
| 4 | [Template Detection](#template-detection) | `isTemplateString` | 3 |
| 5 | [Template Formatting](#template-formatting) | `formatString` | 6 |
| 6 | [Array Normalization](#array-normalization) | `wrapInArray` | 3 |
| 7 | [Putting It Together](#putting-it-together) | Combined usage | 3 |

---

## Runtime Type Guards

The type predicates `isString`, `isBoolean` and `isNullOrUndef` validate values at runtime and narrow their TypeScript type at compile time — one call covers both concerns.

### Guard and Narrow Unknown Input with isString

Use `isString` to safely process values that arrive as `unknown`. After the check succeeds, TypeScript knows the value is a `string`.

```typescript
import { isString } from 'blendsdk/stdlib';

function wordCount(value: unknown): number {
    if (!isString(value)) {
        return 0;
    }
    // `value` is narrowed to `string` here
    const trimmed: string = value.trim();
    return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

console.log(wordCount('the quick brown fox')); // → 4
console.log(wordCount(''));                    // → 0
console.log(wordCount(42));                    // → 0
console.log(wordCount(null));                  // → 0
```

### Accept Only Real Booleans with isBoolean

`isBoolean` returns `true` only for boolean primitives — the strings `"true"`/`"false"`, numbers, and `new Boolean(...)` wrappers are rejected.

```typescript
import { isBoolean } from 'blendsdk/stdlib';

function resolveFeatureFlag(value: unknown, fallback: boolean): boolean {
    return isBoolean(value) ? value : fallback;
}

console.log(resolveFeatureFlag(true, false));     // → true
console.log(resolveFeatureFlag(false, true));     // → false
console.log(resolveFeatureFlag('true', false));   // → false — a string, not a boolean
console.log(resolveFeatureFlag(1, false));        // → false — a number, not a boolean
console.log(resolveFeatureFlag(undefined, true)); // → true
```

### Check for Nullish Values Before Use with isNullOrUndef

`isNullOrUndef` is `true` only for `null` and `undefined`. In the else branch of a negated check, TypeScript narrows the value to its non-nullable type.

```typescript
import { isNullOrUndef } from 'blendsdk/stdlib';

const level: string | undefined = process.env.LOG_LEVEL;

if (isNullOrUndef(level)) {
    console.log('LOG_LEVEL is not set — using "info"');
} else {
    // `level` is narrowed to `string` in this branch
    console.log(`log level: ${level.toUpperCase()}`);
}

// → LOG_LEVEL is not set — using "info"   (when the variable is unset)
```

### Distinguish Falsy-but-Defined Values

`isNullOrUndef` is a two-value test, not a truthiness test: `0`, `""`, `false`, `NaN` and even the string `"undefined"` all count as defined.

```typescript
import { isNullOrUndef } from 'blendsdk/stdlib';

function describe(value: unknown): string {
    if (isNullOrUndef(value)) {
        return 'nothing to render';
    }
    return `rendering: ${JSON.stringify(value)}`;
}

console.log(describe(0));           // → rendering: 0
console.log(describe(''));          // → rendering: ""
console.log(describe(false));       // → rendering: false
console.log(describe('undefined')); // → rendering: "undefined" — a real string value
console.log(describe(null));        // → nothing to render
console.log(describe(undefined));   // → nothing to render
```

---

## Nullish Fallbacks

`isNullOrUndefDefault` returns its default only when the value is `null` or `undefined` — every other value, including `""`, `0` and `false`, passes through unchanged.

### Fill In Missing Record Entries

Record lookups are typed as their value type even when a key is missing at runtime. Wrap the lookup in `isNullOrUndefDefault` to guarantee a concrete value.

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

const settings: Record<string, string> = {
    theme: 'dark'
};

const theme: string = isNullOrUndefDefault(settings.theme, 'light');
const locale: string = isNullOrUndefDefault(settings.locale, 'en-US');

console.log(theme);  // → dark
console.log(locale); // → en-US
```

### Keep Legitimate Falsy Values

Unlike `value || fallback`, the nullish fallback never replaces `0`, `""` or `false`. This example contrasts the two behaviors with a score of zero.

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

const scores: Record<string, number> = { level1: 0 };

const level1: number = isNullOrUndefDefault(scores.level1, 100);
const level2: number = isNullOrUndefDefault(scores.level2, 100);

console.log(level1); // → 0   (a `||` fallback would have produced 100)
console.log(level2); // → 100
```

### Normalize Optional Query Options

When the input is genuinely optional, the fallback applies at runtime while the static type keeps the optional union — the value is still guaranteed to be present when used.

```typescript
import { isNullOrUndefDefault } from 'blendsdk/stdlib';

interface QueryOptions {
    sortBy?: string;
    limit?: number;
}

function toQueryString(options: QueryOptions): string {
    const sortBy: string | undefined = isNullOrUndefDefault(options.sortBy, 'name');
    const limit: number | undefined = isNullOrUndefDefault(options.limit, 25);
    // At runtime both values are always present after the fallback
    return `sort=${sortBy}&limit=${limit}`;
}

console.log(toQueryString({}));                 // → sort=name&limit=25
console.log(toQueryString({ sortBy: 'date' })); // → sort=date&limit=25
```

---

## Numeric Validation

`isNumeric` accepts finite numbers and strings that fully represent one — no partial parses, no coercion, no surprises.

### Parse an Environment Variable into a Port Number

Combine `isNumeric` with an explicit conversion. Values like `"8080px"` and `""` are rejected, so `Number()` is only ever called on a valid numeric string.

```typescript
import { isNumeric } from 'blendsdk/stdlib';

function parsePort(value: string | undefined): number | undefined {
    if (value !== undefined && isNumeric(value)) {
        return Number(value);
    }
    return undefined;
}

console.log(parsePort('8080'));    // → 8080
console.log(parsePort(' 3000 '));  // → 3000
console.log(parsePort('8080px'));  // → undefined
console.log(parsePort(''));        // → undefined
console.log(parsePort(undefined)); // → undefined
```

### Strict Acceptance and Rejection Reference

A quick catalog of what passes and what fails — including formats `parseFloat` would have silently accepted.

```typescript
import { isNumeric } from 'blendsdk/stdlib';

// Accepted: finite numbers and complete numeric strings
console.log(isNumeric(42));         // → true
console.log(isNumeric(-3.14));      // → true
console.log(isNumeric('42'));       // → true
console.log(isNumeric(' 3.14 '));   // → true
console.log(isNumeric('1e10'));     // → true
console.log(isNumeric('0xFF'));     // → true
console.log(isNumeric('.5'));       // → true

// Rejected: non-finite, partial, or non-primitive values
console.log(isNumeric(NaN));        // → false
console.log(isNumeric(Infinity));   // → false
console.log(isNumeric('42px'));     // → false — parseFloat would return 42
console.log(isNumeric('1,000'));    // → false
console.log(isNumeric('Infinity')); // → false
console.log(isNumeric([42]));       // → false
console.log(isNumeric(null));       // → false
```

### Filter Mixed Values Down to Numbers

Filter a heterogeneous array down to its numeric members, then convert them with `Number()` — safe because each survivor passed the full-string check.

```typescript
import { isNumeric } from 'blendsdk/stdlib';

const rawValues: unknown[] = [42, '3.14', 'abc', '', null, 0, '0x10', NaN, true];

const numbers: number[] = rawValues
    .filter((value) => isNumeric(value))
    .map((value) => Number(value));

console.log(numbers); // → [ 42, 3.14, 0, 16 ]
```

---

## Template Detection

`isTemplateString` reports — cheaply and syntactically — whether a string contains at least one well-formed `${...}` placeholder.

### Skip Rendering for Plain Text

Branch on `isTemplateString` to avoid formatting work for strings that contain no placeholders.

```typescript
import { formatString, isTemplateString } from 'blendsdk/stdlib';

function render(template: string, params: Record<string, unknown>): string {
    if (!isTemplateString(template)) {
        return template;
    }
    return formatString(template, params);
}

console.log(render('Plain text needs no work', {}));
// → Plain text needs no work

console.log(render('Hello ${user.name|Guest}', { user: { name: 'Alice' } }));
// → Hello Alice
```

### Find Templated Messages in a List

Filter a message catalog down to the entries that actually need rendering.

```typescript
import { isTemplateString } from 'blendsdk/stdlib';

const messages: string[] = [
    'Welcome aboard!',
    'Hello ${user.name}',
    'Your order ${orderId|unknown} has shipped',
    '${}'
];

const templated: string[] = messages.filter((message) => isTemplateString(message));

console.log(templated);
// → [ 'Hello ${user.name}', 'Your order ${orderId|unknown} has shipped' ]
```

### Validate Untrusted Template Input

Combine the string guard with the template check to validate values that arrive from user input or configuration files.

```typescript
import { isString, isTemplateString } from 'blendsdk/stdlib';

type ValidationResult =
    | { valid: true; template: string }
    | { valid: false; reason: string };

function validateTemplate(input: unknown): ValidationResult {
    if (!isString(input)) {
        return { valid: false, reason: 'template must be a string' };
    }
    if (!isTemplateString(input)) {
        return { valid: false, reason: 'no ${...} placeholders found' };
    }
    return { valid: true, template: input };
}

console.log(validateTemplate('Hello ${name}'));
// → { valid: true, template: 'Hello ${name}' }

console.log(validateTemplate('Hello world'));
// → { valid: false, reason: 'no ${...} placeholders found' }

console.log(validateTemplate(42));
// → { valid: false, reason: 'template must be a string' }
```

---

## Template Formatting

`formatString` replaces `${...}` placeholders with values from a params object, supporting defaults and dot-notation paths.

### Simple Substitution

The core behavior: every `${key}` is replaced with `String(params[key])`.

```typescript
import { formatString } from 'blendsdk/stdlib';

const greeting: string = formatString('Hello ${name}, welcome to ${city}!', {
    name: 'Alice',
    city: 'Amsterdam'
});

console.log(greeting); // → Hello Alice, welcome to Amsterdam!
```

### Fall Back to Default Values

A `|` inside the placeholder separates the key from its default. The default kicks in when the key is missing, `null`, `undefined` or an empty string.

```typescript
import { formatString } from 'blendsdk/stdlib';

console.log(formatString('Hello ${name|Guest}'));                   // → Hello Guest
console.log(formatString('Hello ${name|Guest}', { name: 'John' })); // → Hello John
console.log(formatString('Hello ${name|Guest}', { name: '' }));     // → Hello Guest — "" counts as missing
console.log(formatString('Hello ${name|Guest}', { name: null }));   // → Hello Guest

console.log(formatString('Contact: ${email|no-reply@example.com}', {}));
// → Contact: no-reply@example.com
```

### Resolve Nested Values with Dot-Notation

Dots in a key walk into nested objects. A missing segment abandons the path — the placeholder is kept, or the default is used when one is available.

```typescript
import { formatString } from 'blendsdk/stdlib';

const user = {
    name: 'Alice',
    address: { city: 'Amsterdam', country: 'NL' }
};

console.log(formatString('${user.name} lives in ${user.address.city}, ${user.address.country}', { user }));
// → Alice lives in Amsterdam, NL

console.log(formatString('Company: ${user.company.name}', { user }));
// → Company: ${user.company.name} — kept because there is no default

console.log(formatString('Age: ${user.age|unknown}', { user }));
// → Age: unknown — the default applies
```

### Format Numbers and Booleans

Resolved values are stringified with `String(value)` — `0` and `false` are real values, never treated as missing.

```typescript
import { formatString } from 'blendsdk/stdlib';

const summary: string = formatString(
    'Found ${count} items, total $${total}, active: ${active}, retries: ${retries}',
    { count: 42, total: 9.99, active: false, retries: 0 }
);

console.log(summary);
// → Found 42 items, total $9.99, active: false, retries: 0
```

### Keep Unresolved Placeholders Visible

Without a value and without a default, the raw placeholder is preserved in the output — gaps stay visible instead of silently becoming empty strings.

```typescript
import { formatString } from 'blendsdk/stdlib';

console.log(formatString('Hello ${unknown}', { name: 'John' }));
// → Hello ${unknown}

console.log(formatString('${a} and ${b}', { a: 'X' }));
// → X and ${b}
```

### Build an Order Confirmation Message

A realistic composite: nested lookups, a fallback, and number formatting in a single template.

```typescript
import { formatString } from 'blendsdk/stdlib';

const order = {
    id: 'A-1024',
    total: 49.5,
    customer: { email: 'alice@example.com' }
};

const subject: string = formatString('Order ${order.id} confirmed', { order });

const body: string = formatString(
    'Hi ${order.customer.name|valued customer},\n\n' +
        'Your order ${order.id} (total: $${order.total}) has been confirmed.\n' +
        'A receipt was sent to ${order.customer.email|your email address}.\n\n' +
        'Thank you for shopping with us!',
    { order }
);

console.log(subject);
// → Order A-1024 confirmed

console.log(body);
// → Hi valued customer,
// →
// → Your order A-1024 (total: $49.5) has been confirmed.
// → A receipt was sent to alice@example.com.
// →
// → Thank you for shopping with us!
```

---

## Array Normalization

`wrapInArray` turns "one value, a list, or nothing" inputs into a guaranteed array — `[]` for nullish values, the same reference for arrays, a one-element array otherwise.

### Accept a Single Value or a List

The classic configuration pattern: an option that may be declared once or as an array. Normalize first, then loop without branching.

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
```

### Sum an Optional Value or Array

Aggregate helpers become trivial when their inputs are normalized first.

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

function sum(values: number | number[] | undefined): number {
    return wrapInArray<number>(values).reduce((total, value) => total + value, 0);
}

console.log(sum(undefined)); // → 0
console.log(sum(5));         // → 5
console.log(sum([1, 2, 3])); // → 6
```

### Reference Preservation and Non-Array Iterables

Arrays pass through by reference; everything else — including `Set` and `Map` — is wrapped as a single value, never spread.

```typescript
import { wrapInArray } from 'blendsdk/stdlib';

const existing: string[] = ['alpha', 'beta'];
const same: string[] = wrapInArray<string>(existing);

console.log(same === existing); // → true — already an array, returned as-is

const single: string[] = wrapInArray<string>('gamma');
console.log(single); // → [ 'gamma' ]

const tags = new Set(['a', 'b']);
const wrapped: Set<string>[] = wrapInArray<Set<string>>(tags);

console.log(wrapped.length);      // → 1
console.log(wrapped[0] === tags); // → true — wrapped as a single element
```

---

## Putting It Together

Realistic combinations of the utilities in a single flow.

### Read an Integer Environment Variable Safely

Nullish guard plus strict numeric validation: fall back when the variable is unset, and reject malformed values like `"3000px"` instead of parsing them partially.

```typescript
import { isNumeric, isNullOrUndef } from 'blendsdk/stdlib';

function readEnvInt(name: string, fallback: number): number {
    const raw: string | undefined = process.env[name];
    if (!isNullOrUndef(raw) && isNumeric(raw)) {
        return Number(raw);
    }
    return fallback;
}

const port: number = readEnvInt('PORT', 3000);
const workers: number = readEnvInt('WORKERS', 4);

console.log({ port, workers });
// → { port: 3000, workers: 4 }   (with PORT and WORKERS unset)
```

### Resolve Configuration with Defaults

Missing configuration entries are filled in with `isNullOrUndefDefault`, and the resulting string is validated and converted with `isNumeric`.

```typescript
import { isNumeric, isNullOrUndefDefault } from 'blendsdk/stdlib';

const env: Record<string, string> = {
    HOST: 'api.example.com',
    PORT: '8080'
};

const host: string = isNullOrUndefDefault(env.HOST, 'localhost');
const port: string = isNullOrUndefDefault(env.PORT, '3000');
const region: string = isNullOrUndefDefault(env.REGION, 'eu-west-1');

const resolvedPort: number = isNumeric(port) ? Number(port) : 3000;

console.log({ host, region, resolvedPort });
// → { host: 'api.example.com', region: 'eu-west-1', resolvedPort: 8080 }
```

### Validate, Format and Normalize in One Pipeline

A small notification renderer that validates a template, formats it with params, and normalizes single-or-multiple recipients — three utilities in one flow, with error handling for invalid templates.

```typescript
import { formatString, isString, isTemplateString, wrapInArray } from 'blendsdk/stdlib';

interface Notification {
    message: string;
    to: string[];
}

function renderNotification(
    template: unknown,
    recipients: string | string[] | undefined,
    params: Record<string, unknown>
): Notification {
    if (!isString(template) || !isTemplateString(template)) {
        throw new Error('A string with ${...} placeholders is required');
    }
    return {
        message: formatString(template, params),
        to: wrapInArray<string>(recipients)
    };
}

const bulk: Notification = renderNotification(
    'Hello ${user.name|there}, your invoice ${invoiceId} is ready',
    ['alice@example.com', 'bob@example.com'],
    { user: { name: 'Alice' }, invoiceId: 'INV-77' }
);

console.log(bulk);
// → { message: 'Hello Alice, your invoice INV-77 is ready', to: [ 'alice@example.com', 'bob@example.com' ] }

const single: Notification = renderNotification(
    'Hello ${user.name|there}, your invoice ${invoiceId} is ready',
    'carol@example.com',
    { invoiceId: 'INV-78' }
);

console.log(single);
// → { message: 'Hello there, your invoice INV-78 is ready', to: [ 'carol@example.com' ] }

try {
    renderNotification('No placeholders here', [], {});
} catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    // → A string with ${...} placeholders is required
}
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
