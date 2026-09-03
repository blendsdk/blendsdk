# BlendScript

BlendScript is a small expression language for business rules. Its formulas are intended to be
readable by people who are comfortable with spreadsheet formulas, while an application supplies the
available fields and data.

BlendScript validates and evaluates expressions without eval, Function, dynamic imports, network
access, file access, or host-defined functions. The package has no runtime dependencies.

New to BlendScript? Follow the
[BlendScript course](../blendsdk-docs/docs/guides/blendscript-v1.md) to learn formula authoring
and external application integration step by step.

## Installation

Inside the BlendSDK monorepo:

```bash
yarn add @blendsdk/blendscript
```

From the public umbrella package:

```bash
npm install blendsdk
```

```typescript
import { compileExpression, evaluateExpression, validateExpression } from 'blendsdk/blendscript';
```

## Formula examples

```text
Country == "NL" AND Enabled == TRUE

[Order Total] >= 1000 OR CustomerType IN ("Gold", "Platinum")

isBlank(CustomerName) OR equalsIgnoreCase(Status, "pending")

contains(lower(Description), "urgent")

tryNumber(Item) != NULL AND tryNumber(Item) > 1

text(Item) == "ABC-1"
```

Do not put an equals sign before an expression. Text uses double quotes. Field names containing spaces
or reserved words use brackets, as in [Order Total] or [AND].

## Three-function API

### Validate source

Use validateExpression while an author is editing a formula.

```typescript
const validation = validateExpression('Country == "NL" AND Enabled == TRUE', {
  schema: {
    Country: { type: 'string' },
    Enabled: { type: 'boolean' },
  },
  expectedResult: 'boolean',
});

if (!validation.ok) {
  console.log(validation.diagnostics);
}
```

### Compile once

Use compileExpression after validation. A successful result contains an opaque, reusable compiled
expression plus its inferred result type and referenced fields.

```typescript
const compilation = compileExpression('Amount >= 1000', {
  schema: { Amount: { type: 'number' } },
  expectedResult: 'boolean',
});
```

### Evaluate records

Evaluate the compiled expression for each complete record.

```typescript
if (compilation.ok) {
  const result = evaluateExpression(compilation.expression, { Amount: 1250 });
  // { ok: true, value: true }
}
```

Every schema field must be present in each record, including fields the formula does not reference.
The embedding application owns storage, transport, user interface, and what it does with the result.

## Language reference

### Values and fields

| Kind            | Syntax                                                              |
| --------------- | ------------------------------------------------------------------- |
| Text            | "Netherlands", with standard escapes such as \", \\, \n, and \uXXXX |
| Number          | 12, -12.5, .5, 1e3                                                  |
| Boolean         | TRUE or FALSE                                                       |
| Null            | NULL                                                                |
| Simple field    | Country, OrderTotal, _internalCode                                  |
| Bracketed field | [Order Total], [AND], [Closing]]Bracket]                            |

Keywords and built-in names are case-insensitive. Field names are exact and case-sensitive.

### Operators

| Purpose           | Syntax                        |
| ----------------- | ----------------------------- |
| Equal / not equal | ==, !=                        |
| Number comparison | <, <=, >, >=                  |
| Membership        | Country IN ("NL", "BE", "DE") |
| Logical and       | AND or &&                     |
| Logical or        | OR or \|\|                    |
| Logical not       | NOT or !                      |
| Grouping          | (expression)                  |

Precedence from strongest to weakest is: function/grouping, NOT, comparison or IN, AND, OR.
Comparisons cannot be chained. IN contains one or more literal values, not fields or expressions.
BlendScript never coerces values for operators. The explicit `tryNumber` and `text` built-ins convert
string-or-number scalar fields when a rule deliberately requests it.

Schema fields use `string`, `number`, `boolean`, or `scalar`. A `scalar` field accepts a string or a
finite number and retains the original runtime value. Use it for data sources such as spreadsheet
columns that can contain either representation.

### Built-in functions

| Function                          | Result                                                |
| --------------------------------- | ----------------------------------------------------- |
| isEmpty(value)                    | TRUE for NULL or empty text                           |
| isBlank(value)                    | TRUE for NULL, empty text, or whitespace-only text    |
| contains(value, search)           | Case-sensitive substring check                        |
| startsWith(value, prefix)         | Case-sensitive prefix check                           |
| endsWith(value, suffix)           | Case-sensitive suffix check                           |
| equalsIgnoreCase(value, expected) | Compare after locale-independent lowercase conversion |
| trim(value)                       | Remove leading and trailing whitespace                |
| lower(value)                      | Convert text to lowercase                             |
| upper(value)                      | Convert text to uppercase                             |
| length(value)                     | Count Unicode code points                             |
| tryNumber(value)                  | Convert scalar decimal text or a number; else NULL    |
| text(value)                       | Preserve scalar text or format a finite number        |

`tryNumber` accepts the same complete decimal forms as number literals, including `001`, `.5`, `5.`,
and `1e3`. It returns NULL for empty or whitespace-padded text, partial parses, unsupported numeric
syntax, non-finite results, and NULL. `text` preserves strings exactly and uses JavaScript's
locale-independent finite-number formatting. Only isEmpty, isBlank, and tryNumber accept null at
runtime. All functions are fixed, pure, and synchronous.

## Diagnostics and errors

Authored formula and record problems are returned as structured diagnostics. Source diagnostics include
an exact span and one-based line and column. Record diagnostics identify the schema field and never
include its value.

Invalid API use, such as an invalid schema or a forged compiled expression, throws
BlendScriptApiError. Applications should distinguish programmer errors from formula diagnostics.
The complete code catalog is in
[Troubleshooting](./ai-training/07-troubleshooting.md).

## Fixed limits

| Resource                         |                    Limit |
| -------------------------------- | -----------------------: |
| Source length                    | 16,384 UTF-16 code units |
| Tokens                           |                    4,096 |
| String literal or runtime string |  4,096 UTF-16 code units |
| Field name                       |    256 UTF-16 code units |
| Schema fields                    |                    1,024 |
| Nesting                          |                       64 |
| Evaluation work                  |             10,000 steps |
| Returned source diagnostics      |                       20 |

## Security boundary

BlendScript interprets a private AST and exposes no host capabilities. It does not execute JavaScript,
load modules, perform I/O, access object prototypes, call getters, or invoke custom functions.
Schemas and records must be ordinary caller-created objects with own data properties.

JavaScript proxies cannot be identified without potentially running their traps. The embedding
application must materialize proxy-backed options, schemas, descriptors, and records into ordinary
objects before calling BlendScript. The host also owns authentication, authorization, sensitive-data
handling, storage, transport, encryption, logging, and throughput controls. BlendScript persists and
logs nothing.

## Persistence and compatibility

Compiled expressions are opaque, package-instance-owned memory values. They are not serializable or a
persistence/interchange format. Store the source and schema, then compile again after loading or after
upgrading BlendSDK.

Compatible minor releases preserve parsing, binding, results, and diagnostics for previously valid
source/schema pairs. A change that alters existing valid input requires a semantic-version major
release and migration guidance.

BlendScript is unrelated to @blendsdk/expression, which is a SQL expression builder. BlendScript also
makes no compatibility or ancestry claim with Filtrex.

## Deliberate v1 exclusions

Version 1 has no assignments, arithmetic, variables, statements, loops, procedures, comments, regular
expressions, custom functions, date operations, or locale-specific operations. It is an expression
evaluator, not a general-purpose scripting runtime.

See [ai-training/README.md](./ai-training/README.md) for the complete documentation index.
