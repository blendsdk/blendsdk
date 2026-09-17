> **Package**: `blendsdk/cmdline`

# cmdline Core Concepts

This document is the deep dive into every major concept of `blendsdk/cmdline`. The Overview summarizes the feature set and architecture; here each mechanism gets its own section with a fully working example, so you can see exactly how declarations, recognition, validation, help, and error handling fit together.

Every public name is imported from the package root — `import { CommandLineParser } from 'blendsdk/cmdline'`. A few sections also describe internal building blocks (the argument registry, the pure recognition function, the bounded suggestion session) for completeness; only the names exported from the package root are part of the public API.

| # | Concept | What it covers |
| --- | --- | --- |
| 1 | `CommandLineParser` | The facade: configuration, command registration, `execute()`, and the two execution paths |
| 2 | Commands | `ICommand`: names, aliases, defaults, handlers, and selection rules |
| 3 | Command options | `ICommandOption`: types, defaults, constraints, scopes, and canonical keys |
| 4 | Option recognition & value conversion | Accepted spellings and how raw tokens become typed values |
| 5 | Strict vs. legacy mode | The fail-closed strict contract vs. the permissive default |
| 6 | Option validation & constraints | Required, defaults, types, choices, validators, conflicts, dependencies |
| 7 | Built-in validators | `isValidEmail`, `isValidDomain`, and their message helpers |
| 8 | Typed errors & error handling | The error hierarchy, aggregate rejection, and the `errorHandler` hook |
| 9 | Diagnostics & suggestions | Ordered issue conversion and bounded "Did you mean" hints |
| 10 | Help system & output routing | Automatic help, rendering, and injectable output |
| 11 | Invocation context & state isolation | `argv`, `write`, `context`, and per-invocation state |

---

## The `CommandLineParser` Facade

### What It Is

`CommandLineParser` is the only executable class the package exports. One instance owns the parser configuration (`name`, `version`, `strict`, `skipHelp`, `globalOptions`, `errorHandler`), the registered commands, and the invocation metadata used to render help headers. Everything else the package exports is a type, an error class, a validator helper, or a reserved-name constant.

### How It Works

1. **Construction** — `new CommandLineParser(config?)`. The config is optional (it defaults to a parser named `default` with version `1.0`), is defensively cloned so later caller mutation cannot change behavior, and its global options are validated immediately. Invalid configuration throws `InvalidConfigurationError` before any argument is ever parsed.
2. **Registration** — `addCommand()` clones and validates each command, rejects reserved or colliding spellings, appends the automatic help option (a boolean option spelled `--help`, short `-h`) unless `skipHelp: true`, and returns the parser so calls chain fluently.
3. **Execution** — `execute(context?, invocation?)` runs exactly one invocation:
   - Mutable option storage is reset first, so no value or help state survives from a previous run.
   - If `strict` is not `true`, the legacy pipeline runs: arguments are validated and tokenized, defaults, types, choices, validators, conflicts, and dependencies are checked, and any problem or help request renders help and resolves; otherwise the command handler runs with a `showHelp()` helper attached.
   - If `strict: true`, the strict pipeline runs: a lookup registry is built, arguments are recognized into a pure result object, issues are converted to typed errors with suggestions, semantic validation runs, and the invocation either renders clean help, rejects with `CommandLineValidationError`, or runs the handler.
4. **Process policy** — the class never terminates the process: it rejects on strict failure and resolves on help or legacy outcomes, leaving exit-code policy to the caller (`process.exitCode`).
5. **Protected surface** — `parseTokens`, `validate`, `help`, `setOptionValue`, `processQuotedArgument`, `validateArgument`, `prepare`, `executeStrict`, and `resetOptionValues` exist for subclasses and package tests; they are not part of the supported public API.

### Complete Example

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'notes-cli',
  version: '1.0.0',
  strict: true,
});

parser
  .addCommand({
    name: 'add',
    description: 'Add a note',
    options: [{ name: 'text', short: 't', type: 'string', required: true }],
    handler: options => {
      console.log(`added: ${String(options['text'])}`);
    },
  })
  .addCommand({
    name: 'list',
    description: 'List all notes',
    handler: () => {
      console.log('no notes yet');
    },
  });

try {
  await parser.execute(undefined, { argv: ['add', '--text', 'first note'] });
  // → added: first note

  await parser.execute(undefined, { argv: ['list'] });
  // → no notes yet

  await parser.execute(undefined, { argv: ['add'] });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  // Invalid input renders help and rejects; the caller owns the exit code.
  process.exitCode = 1;
}
```

### Key Methods & Properties

| Member | Signature | Description |
| --- | --- | --- |
| `constructor` | `constructor(config?: ICommandLineParser)` | Clones and validates the parser configuration and global options; throws `InvalidConfigurationError` on invalid input. |
| `addCommand` | `addCommand(config: ICommand): CommandLineParser` | Clones, validates, and registers a command; adds the automatic help option unless `skipHelp`; returns the parser for chaining. |
| `execute` | `execute(context?: unknown): Promise<unknown>` | Compatibility form: runs with `process.argv` and the console. |
| `execute` | `execute(context: unknown, invocation: ICommandLineInvocation): Promise<unknown>` | Invocation form: supplies `argv` and a `write` collector; returns the handler result, or `undefined` when help was rendered. |
| `parseTokens` *(protected)* | `parseTokens(args?: readonly string[]): IToken[]` | Legacy tokenizer used by the compatibility path. |
| `validate` *(protected)* | `validate(tokens: IToken[]): { errors: string[]; command?: ICommand }` | Legacy semantic validation with default application. |
| `executeStrict` *(protected)* | `executeStrict(context?: unknown, invocation?: ICommandLineInvocation): Promise<unknown>` | Strict, fail-closed execution path. |

For backward compatibility, the single-argument `execute` form is loosely declared so existing consumers can annotate the handler result themselves; prefer the two-argument invocation form in new code.

---

## Commands (`ICommand`)

### What It Is

A command is the unit of behavior in a CLI: an object with a canonical `name`, an optional `description`, option definitions, and a `handler` that runs when the command is selected. The parser selects at most one command per invocation and decides between an explicit token, a registered alias, and a default command.

### How It Works

1. **Registration is a trust boundary** — `addCommand()` defensively clones the command (aliases, examples, options, subcommands) and validates it before it can execute. Names must start with a letter and contain only letters, numbers, hyphens, and underscores; `help` and `version` are reserved; duplicate canonical names, duplicate aliases, and alias/command collisions (compared case-insensitively) throw `InvalidConfigurationError`.
2. **Selection** — the parser scans the argument list; the first token that is not option-shaped and not consumed as an option value is the command token. In strict mode the spelling must match exactly; in legacy mode the comparison is case-normalized.
3. **Aliases** — additional validated spellings that select the canonical command state (including its options and handler). Aliases are exact in strict mode and case-normalized in legacy mode, and they appear in "Did you mean" candidates for unknown commands.
4. **Default command** — `default: true` is honored only when exactly one command is registered. As soon as a second command exists the default is disabled, and a command-less invocation shows help instead.
5. **No positional operands** — commands receive only options (plus caller `context`). Any leftover plain token is a strict-mode `UnexpectedArgumentError`, or is tolerated in legacy mode.
6. **Handler contract** — `handler(options & { context })` may return a value or a promise; that result is what `execute()` resolves to. The handler is never called after a strict failure, and never called in legacy error or help paths.

### Complete Example

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'release-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  description: 'Deploy the current build',
  aliases: ['ship'],
  options: [{ name: 'output', short: 'o', type: 'string', default: 'dist' }],
  handler: options => {
    console.log(`deploying ${String(options['output'])}`);
  },
});

parser.addCommand({
  name: 'rollback',
  description: 'Roll back the last release',
  handler: () => {
    console.log('rolled back');
  },
});

await parser.execute(undefined, { argv: ['ship', '--output', 'release'] });
// → deploying release

await parser.execute(undefined, { argv: ['rollback'] });
// → rolled back

// A default command is honored only while exactly one command is registered.
const single = new CommandLineParser({ name: 'single-cli', strict: true });
single.addCommand({
  name: 'serve',
  default: true,
  handler: () => {
    console.log('serving');
  },
});

await single.execute(undefined, { argv: [] });
// → serving
```

### Key Methods & Properties

| Property | Type | Description |
| --- | --- | --- |
| `name` | `string` | Canonical spelling. Must start with a letter; letters/digits/hyphens/underscores only; `help` and `version` reserved; unique across commands and aliases (case-insensitive). |
| `handler` | `CommandHandler` | `(options: OptionsDict & { context?: unknown }) => Promise<unknown> \| unknown`. Receives validated option values plus the caller `context`. |
| `description` | `string?` | Shown in help listings. |
| `default` | `boolean?` | Marks the default command; effective only when exactly one command is registered. |
| `options` | `ICommandOption[]?` | Command-local option definitions. |
| `aliases` | `string[]?` | Additional spellings; exact in strict mode, case-normalized in legacy mode. |
| `examples` | `string[]?` | Documentation metadata, cloned at registration. |
| `category` | `string?` | Grouping metadata for organization. |
| `hidden` | `boolean?` | Visibility metadata carried through cloning. |
| `subcommands` | `ICommand[]?` | Recursively cloned; execution currently reads only the top-level command registry. |

The reserved spellings are also exported as `RESERVED_COMMAND_NAMES` (`['help', 'version']`).

---

## Command Options (`ICommandOption`)

### What It Is

An option definition maps a long name (`--output`), an optional single-letter short (`-o`), a runtime type, and behavior flags to a canonical key in the options object the handler receives. Options are declared per command (`command.options`) or globally on the parser configuration (`globalOptions`).

### How It Works

- **Definition rules** — names must start with a letter and may contain letters, numbers, hyphens, and underscores; `help` and `version` are reserved; long names and short letters must be unique within their scope; the short letter `h` is rejected while automatic help is enabled; `conflicts` and `depends` may not overlap; `choices` must be a non-empty array that also contains `default` when one is given. Violations throw `InvalidConfigurationError` at registration time.
- **Scope** — global options are accepted before or after an explicit command. Command-local options become visible once the command is selected (or for a default command). Long names and short letters must not collide across the two scopes; a collision throws at registration.
- **Resolution order** — an option token that appears before the explicit command token resolves against global options only; after the command token both scopes are visible, with globals consulted first.
- **Canonical keys** — values are stored under the long `name` regardless of which spelling was used, so handlers always read `options['output']`, never the short letter.
- **Multiple values** — `multiple: true` accumulates every occurrence in source order as an array; without it, the last occurrence wins.
- **Type defaults** — omitting `type` means `string`. `email` and `domain` are stored as strings and format-checked by the built-in validators (see [Built-in Validators](#built-in-validators-isvalidemail--isvaliddomain) below).
- **Hidden flag** — hidden options are excluded from "Did you mean" suggestion candidates; all other parsing behavior is unchanged.

### Complete Example

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'build-cli', strict: true });

parser.addCommand({
  name: 'build',
  description: 'Build the project',
  options: [
    { name: 'output', short: 'o', type: 'string', default: 'dist', description: 'Output directory' },
    { name: 'retries', short: 'r', type: 'number', default: 1, description: 'Retry attempts' },
    { name: 'verbose', short: 'v', type: 'boolean', description: 'Verbose logging' },
    { name: 'target', short: 't', type: 'string', multiple: true, description: 'Build targets' },
    { name: 'token', type: 'string', hidden: true, description: 'Internal access token' },
  ],
  handler: options => {
    const output = String(options['output']);
    const retries = Number(options['retries']);
    const verbose = options['verbose'] === true;
    const targets = Array.isArray(options['target']) ? options['target'].map(String) : [];
    console.log(JSON.stringify({ output, retries, verbose, targets }));
  },
});

await parser.execute(undefined, {
  argv: ['build', '--verbose', '--target=esm', '--target=cjs'],
});
// → {"output":"dist","retries":1,"verbose":true,"targets":["esm","cjs"]}
```

### Key Methods & Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Long spelling (`--name`) and the canonical options key; must be unique per scope. |
| `short` | `string?` | — | Single letter (`-n`); must be unique per scope; `h` is reserved for automatic help. |
| `description` | `string?` | — | Help text for the option. |
| `type` | `'string' \| 'number' \| 'boolean' \| 'email' \| 'domain'` | `'string'` | Runtime conversion and validation contract. |
| `default` | `T?` | — | Applied when the option is absent, then validated like a supplied value. |
| `required` | `boolean?` | `false` | A missing required option becomes `MissingRequiredOptionError` in strict mode. |
| `multiple` | `boolean?` | `false` | Accumulate repeated occurrences in source order. |
| `choices` | `T[]?` | — | Allowed values; must be non-empty and must contain `default` when one is given. |
| `validator` | `(value: T) => boolean \| string` | — | `true` passes, `false` produces a generic message, and a string is used verbatim as the message. |
| `conflicts` | `string[]?` | — | Canonical names that may not be explicitly supplied together with this option. |
| `depends` | `string[]?` | — | Canonical names required when this option is explicitly supplied. |
| `hidden` | `boolean?` | `false` | Excluded from "Did you mean" suggestion candidates. |

Parser-level option scope:

| Property | Type | Description |
| --- | --- | --- |
| `globalOptions` | `ICommandOption[]?` | Options accepted before and after every explicit command; long/short collisions with command-local options are rejected at registration. |

---

## Option Recognition & Value Conversion

### What It Is

Recognition is the token-level mechanism that decides what each argument is (command, option, or value), which registered option spelling it resolves to, and how raw text becomes a canonical typed value.

### How It Works

- **Accepted spellings** — long options: `--name`, `--name=value`; the name must start with a letter and contain only letters, digits, hyphens, and underscores. Short options: `-n`, `-nvalue`, `-n=value`; the first character after the dash is the option letter, and the remainder is an attached value (a leading `=` is stripped).
- **Malformed tokens** — `-` and `--` carry no option payload and are rejected as `Invalid option format` (a bare `--` is not an end-of-options or passthrough marker). Option-shaped text that fails the name pattern is malformed as well.
- **Value consumption** — attached values are used as-is, including `--output=`, which supplies an explicit empty string. Otherwise the next token is consumed as the value when it is not option-shaped. A non-boolean option with no available value produces a malformed-argument issue (`Option [name] requires a value`) and parsing continues with the following token.
- **Booleans** — a bare flag means `true`. A literal `true` or `false` in the next token is consumed as the value. Attached text is converted only when it is exactly `true` or `false`; anything else stays a string and fails validation (`--enabled=maybe`).
- **Numbers** — finite numeric text (after trimming) becomes a number; anything else is kept as raw text so validation can reject it with a precise message. Negative decimal tokens such as `-2.5` are never option tokens and can be consumed as values.
- **Unknown options** — they consume nothing, so a following plain token remains an independent `UnexpectedArgumentError` in strict mode rather than being absorbed.
- **Duplicates** — last value wins unless the option declares `multiple: true`, which accumulates all values in source order.
- **Internal record** — internally, every explicitly supplied option is recorded for the invocation as an occurrence carrying the canonical option, the converted value, the original argument index, and the original spelling. Relationships and diagnostics use this record; the recognition core itself is pure — no process, output, or handler side effects — and returns a fresh result per execution.
- **Legacy conversion** — the legacy tokenizer additionally attempts `JSON.parse` on each value, so `42` becomes the number `42` and `true`/`false` become booleans; unparseable text simply stays a string. A JSON number or object attached to a string-typed option then fails ordinary type validation.

### Complete Example

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'forms-cli', strict: true });

parser.addCommand({
  name: 'report',
  options: [
    { name: 'output', short: 'o', type: 'string' },
    { name: 'offset', type: 'number' },
    { name: 'enabled', short: 'e', type: 'boolean' },
  ],
  handler: options => {
    console.log(
      JSON.stringify({
        output: options['output'],
        offset: options['offset'],
        enabled: options['enabled'],
      })
    );
  },
});

// Attached long value
await parser.execute(undefined, { argv: ['report', '--output=release'] });
// → {"output":"release"}

// Compact short value and a negative decimal value
await parser.execute(undefined, { argv: ['report', '-orelease', '--offset', '-2.5'] });
// → {"output":"release","offset":-2.5}

// Boolean flag with a separate literal
await parser.execute(undefined, { argv: ['report', '-e', 'false'] });
// → {"enabled":false}
```

### Key Methods & Properties

Accepted spellings:

| Input form | Example | Effective value |
| --- | --- | --- |
| `--name value` | `--output release` | `'release'` (separate token) |
| `--name=value` | `--output=release` | `'release'` (attached) |
| `-n value` | `-o release` | `'release'` (separate token) |
| `-nvalue` | `-orelease` | `'release'` (compact) |
| `-n=value` | `-o=release` | `'release'` (attached, `=` stripped) |
| boolean flag | `--verbose` | `true` |
| boolean literal | `--verbose false` | `false` (literal consumed) |
| empty attachment | `--output=` | `''` (explicit empty string) |
| negative decimal | `--offset -2.5` | `-2.5` (value, not an option) |

Conversion and validation outcomes:

| Declared `type` | Raw input | Stored value | Validation result |
| --- | --- | --- | --- |
| `string` | `release` | `'release'` | valid |
| `number` | `42` | `42` | valid |
| `number` | `not-a-number` | `'not-a-number'` | `InvalidOptionValueError` |
| `boolean` | `--flag` | `true` | valid |
| `boolean` | `--flag=false` | `false` | valid |
| `boolean` | `--flag=maybe` | `'maybe'` | `InvalidOptionValueError` |
| `email` / `domain` | `user@example.com` | `'user@example.com'` | format-checked by the built-in validator |
| any non-boolean | missing value | — | `MalformedArgumentError` |

---

## Strict Mode vs. Legacy Mode

### What It Is

The `strict` flag selects between two complete parsing contracts. With `strict: true`, recognition is exact, case-sensitive, and fail-closed: invalid input is collected as typed issues and the invocation rejects. Without it, the historic permissive pipeline runs — case-normalized command lookup and help-and-resolve on every problem. Legacy mode remains the v5 default: existing applications keep their behavior until they explicitly opt in.

### How It Works

1. **Legacy pipeline** — `execute()` calls the tokenizer (`parseTokens()`), which validates, quote-normalizes, and tokenizes the arguments in three passes (classification, option/value splitting with JSON interpretation, and value peeking). Then `validate()` finds the command (case-normalized), matches options by their exact registered long name or short letter, applies defaults, and checks types, choices, validators, conflicts, and dependencies. If any error exists or help was requested, help is rendered and execution resolves with `undefined`; otherwise the handler runs with a `showHelp()` helper attached.
2. **Strict pipeline** — `execute()` dispatches to the strict path: a registry of immutable lookup tables is built from the cloned configuration; arguments are recognized by a pure function into `{ command, commandIndex, options, occurrences, issues }`; issues are converted to typed errors with optional suggestions; semantic validation adds typed issues for defaults, required, types, choices, validators, conflicts, and dependencies; and finally the invocation either rejects with `CommandLineValidationError`, renders clean help and resolves, or runs the handler.
3. **Precedence rules** — in strict mode invalid input wins over `--help`: a help request is honored only when the command line is otherwise valid. In legacy mode, help is rendered and resolved whenever errors exist or help was requested.
4. **Legacy command position** — a legacy command must be the first token that is not a valid leading global option or its value; an unknown or malformed leading token prevents a later command from running, and the invocation falls back to help.

### Complete Example

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const strictParser = new CommandLineParser({
  name: 'strict-cli',
  version: '1.0.0',
  strict: true,
});
strictParser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', type: 'string' }],
  handler: () => {
    console.log('strict: handler executed');
  },
});

try {
  await strictParser.execute(undefined, {
    argv: ['deploy', '--output'],
    write: () => undefined,
  });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.log(`strict: rejected with ${error.issues.length} issue(s)`);
  // → strict: rejected with 1 issue(s)
}

const legacyParser = new CommandLineParser({
  name: 'legacy-cli',
  version: '1.0.0',
  strict: false,
});
legacyParser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', type: 'string' }],
  handler: () => {
    console.log('legacy: handler executed');
  },
});

const helpLines: string[] = [];
await legacyParser.execute(undefined, {
  argv: ['deploy', '--output'],
  write: line => helpLines.push(line),
});
console.log(`legacy: resolved with help output: ${helpLines.length > 0}`);
// → legacy: resolved with help output: true
```

### Key Methods & Properties

| Aspect | Strict (`strict: true`) | Legacy (the v5 default) |
| --- | --- | --- |
| Command lookup | Exact, case-sensitive (names and aliases) | Case-normalized (names and aliases) |
| Option lookup | Exact registered spelling / short letter | Exact registered spelling / short letter |
| Unknown command | `UnknownCommandError` → rejection, never falls back to a default | Help-and-resolve (`No command provided!`) |
| Unknown option | `UnknownOptionError` → rejection | Ignored; execution continues |
| Extra positional token | `UnexpectedArgumentError` → rejection | Ignored; execution continues |
| Malformed `-` / `--` | `MalformedArgumentError` → rejection | Help-and-resolve |
| Invalid value, missing required, conflicts, dependencies | Typed issue → rejection | Help-and-resolve |
| `--help` with valid input | Renders clean help, resolves `undefined` | Renders help, resolves `undefined` |
| `--help` with invalid input | Invalid input wins → rejection | Renders help, resolves `undefined` |
| Failure delivery | `CommandLineValidationError` rejection | Resolved promise with help output |
| Value interpretation | Typed conversion (`true`/`false`, finite numbers) | `JSON.parse`-assisted interpretation |
| Suggestions | Bounded "Did you mean" hints | None |
| `errorHandler` hook | Invoked when configured | Never invoked |
| Handler on failure | Never called | Never called |

---

## Option Validation & Constraints

### What It Is

Validation is the semantic layer between recognition and execution: it enforces every declared constraint — required presence, defaults, runtime types, `choices`, custom validators, and `conflicts` / `depends` relationships — and produces typed issues instead of letting invalid data reach a handler.

### How It Works

- **Order** — effective options are processed in registration order: global options first, then the selected command's options. Values, including each element of a `multiple` option, are validated individually.
- **Defaults first** — when an option is absent and a `default` exists, the default is applied and then validated exactly like a supplied value. A valid default therefore satisfies `required`; a `false` default is a real value and is preserved.
- **Required** — an absent, undefined option that declares `required` produces `MissingRequiredOptionError` (strict mode). Absent-option checks are skipped when a clean help request is being evaluated, so `--help` stays clean.
- **Types** — `string`, `number`, and `boolean` are checked with the stdlib type guards; `email` and `domain` require string values that pass the built-in format validators, whose messages are embedded in the failure text.
- **Choices** — membership is checked case-sensitively, per element for `multiple` options.
- **Custom validators** — run only after type and choices checks pass: `true` means valid, `false` produces a generic expected-value description, and a returned string is used verbatim as the expected value in the error.
- **Conflicts and dependencies** — computed from explicit occurrences, never from values: a conflict fires when both sides are explicitly supplied (an explicit `false` counts as supplied), and a dependency fires when the owner is explicit while the dependency is neither explicitly supplied nor defaulted. Reciprocal conflicts are deduplicated, and ordering is deterministic: owner registration order, then declaration order.
- **Issue ordering** — token issues come first in input order, followed by validation issues in declaration order; the aggregate preserves that order.

### Complete Example

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deploy-cli',
  strict: true,
  // Replaces built-in help rendering for invalid input; the typed rejection still follows.
  errorHandler: () => undefined,
});

parser.addCommand({
  name: 'deploy',
  options: [
    {
      name: 'environment',
      type: 'string',
      required: true,
      choices: ['dev', 'staging', 'production'],
    },
    {
      name: 'tag',
      type: 'string',
      validator: value => String(value).length >= 3 || 'Tag must have at least 3 characters',
    },
  ],
  handler: options => {
    console.log(`deployed ${String(options['tag'])} to ${String(options['environment'])}`);
  },
});

await parser.execute(undefined, { argv: ['deploy', '--environment=staging', '--tag=v1.2'] });
// → deployed v1.2 to staging

try {
  await parser.execute(undefined, { argv: ['deploy', '--environment=qa', '--tag=ab'] });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  for (const issue of error.issues) {
    console.log(issue.message);
  }
  // → Invalid value provided for option [environment], required one of [dev], [staging], [production], provided [qa]
  // → Invalid value provided for option [tag], required Tag must have at least 3 characters, provided [ab]
  process.exitCode = 1;
}
```

### Key Methods & Properties

| Constraint | Enforced at | Failure (strict) | Notes |
| --- | --- | --- | --- |
| `required` | Option validation | `MissingRequiredOptionError` | Skipped for clean help requests; a valid default satisfies presence. |
| `default` | Option validation | — | Applied when absent, then validated like a supplied value. |
| `type` | Option validation | `InvalidOptionValueError` | `string`/`number`/`boolean` via stdlib guards; `email`/`domain` via built-in validators. |
| `choices` | Option validation | `InvalidOptionValueError` | Case-sensitive membership; checked per element for `multiple` options. |
| `validator` | Option validation | `InvalidOptionValueError` | `true` passes; `false` → generic text; string → custom text. Runs after type and choices pass. |
| `conflicts` | Relationship validation | `ConflictingOptionsError` | Fires when both sides are explicitly supplied; explicit `false` counts as supplied. |
| `depends` | Relationship validation | `MissingOptionDependencyError` | Satisfied by an explicit value (including `false`) or a configured default; defaults alone never activate the owner. |

---

## Built-in Validators (`isValidEmail` / `isValidDomain`)

### What It Is

The package exports four string helpers: two predicates (`isValidEmail`, `isValidDomain`) and two message builders (`getEmailValidationError`, `getDomainValidationError`). They power the `email` and `domain` option types and are available to consumers for custom validators or standalone checks.

### How It Works

- **`isValidEmail`** — combines a practical RFC-5322-style regex with structural checks: exactly one `@`; a local part of at most 64 characters that does not start or end with a dot; no consecutive dots anywhere; a domain part validated by `isValidDomain`; and, unique to emails, at least two domain labels with a TLD of at least two characters. Non-string input returns `false`.
- **`isValidDomain`** — trims the value, enforces the 253-character limit, and validates each dot-separated label: 1–63 characters, no leading or trailing hyphen, letters/digits plus hyphens and underscores (non-TLD labels). Multi-label domains require a letter in the final label; single-label domains such as `localhost` are valid for domains. Non-string input returns `false`.
- **Message builders** — each returns the first applicable, human-readable reason (for example `Email must have a domain part after @` or `Domain cannot start or end with a hyphen`). Option validation embeds these messages in the expected-value slot of `InvalidOptionValueError`, which is why the failure text reads naturally.
- **Where they run** — for `type: 'email'` and `type: 'domain'` options in both modes, including default values that are checked during legacy validation.

### Complete Example

```typescript
import {
  getDomainValidationError,
  getEmailValidationError,
  isValidDomain,
  isValidEmail,
} from 'blendsdk/cmdline';

console.log(isValidEmail('user@example.com')); // true
console.log(isValidEmail('user@localhost')); // false — emails need a dotted domain
console.log(isValidEmail('user..name@example.com')); // false — consecutive dots
console.log(getEmailValidationError('user@')); // Email must have a domain part after @

console.log(isValidDomain('api.example.com')); // true
console.log(isValidDomain('localhost')); // true — single-label domains are valid
console.log(isValidDomain('example.123')); // false — the TLD needs a letter
console.log(getDomainValidationError('-example.com')); // Domain cannot start or end with a hyphen
```

### Key Methods & Properties

| Function | Signature | Description |
| --- | --- | --- |
| `isValidEmail` | `(value: string) => boolean` | Full email check: exactly one `@`, local-part and dot rules, dotted domain with a 2+ character TLD. |
| `isValidDomain` | `(value: string) => boolean` | Domain/subdomain check: 253-character limit, per-label rules, single-label domains allowed. |
| `getEmailValidationError` | `(value: string) => string` | First applicable human-readable email failure reason. |
| `getDomainValidationError` | `(value: string) => string` | First applicable human-readable domain failure reason. |

---

## Typed Errors & Error Handling

### What It Is

Every parser failure is a typed error rooted in the abstract `CommandLineError` base, which carries a `code`, a `category` (`ErrorCategory`), and optional structured `context` in addition to the message. Strict failures are aggregated into a single `CommandLineValidationError` whose frozen `issues` array preserves per-problem detail, so one catch block can handle everything.

### How It Works

- **Base class** — `CommandLineError extends Error` with `code: string`, `category: ErrorCategory` (`PARSING`, `VALIDATION`, `CONFIGURATION`), and `context?: Record<string, unknown>`. `Error.captureStackTrace` keeps clean stack traces.
- **Discriminators** — the `ErrorCode` enum provides stable string codes: `VALIDATION_FAILED`, `UNEXPECTED_ARGUMENT`, `MISSING_OPTION_DEPENDENCY`, `ERROR_HANDLER_FAILED`, `MISSING_REQUIRED_OPTION`, `INVALID_OPTION_VALUE`, `NO_COMMAND_PROVIDED`, `UNKNOWN_COMMAND`, `UNKNOWN_OPTION`, `CONFLICTING_OPTIONS`, `MALFORMED_ARGUMENT`, `CIRCULAR_DEPENDENCY`, and `INVALID_CONFIGURATION`.
- **Aggregate rejection** — `CommandLineValidationError` requires at least one issue (an empty array throws `TypeError`), lists every issue message in its own message, and exposes `issues` as a copied, frozen array so later mutations cannot change the rejection.
- **Structured fields** — each issue class exposes named fields (`argument`, `optionName`, `commandName`, `providedValue`, `conflictingOptions`, and so on) for programmatic handling; `UnknownCommandError` and `UnknownOptionError` messages may include a "Did you mean" hint.
- **Error handler hook** — in strict mode, `errorHandler` replaces built-in invalid-input rendering. The parser awaits the hook with the aggregate and then rejects with the same aggregate; if the hook itself throws or rejects, execution rejects with `CommandLineErrorHandlerError`, which preserves both the original `parserError` and the `handlerError`.
- **Type guard** — `isCommandLineError(error: unknown): error is CommandLineError` narrows arbitrary caught values.
- **Process policy** — the library never terminates the process; it rejects, and the application decides whether to set `process.exitCode`.

### Complete Example

```typescript
import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
  isCommandLineError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'audit-cli', strict: true });
parser.addCommand({
  name: 'audit',
  options: [{ name: 'path', type: 'string', required: true }],
  handler: options => {
    console.log(`auditing ${String(options['path'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['audit', '--unknown'], write: () => undefined });
} catch (error) {
  if (!isCommandLineError(error)) {
    throw error;
  }

  if (error instanceof CommandLineValidationError) {
    for (const issue of error.issues) {
      console.error(`[${issue.code}] ${issue.message}`);
    }
    // → [UNKNOWN_OPTION] Unknown option [unknown] for command [audit]
    // → [MISSING_REQUIRED_OPTION] Missing required option [path] for command [audit]
  } else if (error instanceof CommandLineErrorHandlerError) {
    console.error(`error presentation failed after [${error.parserError.code}]`);
  } else {
    console.error(`[${error.code}] ${error.message}`);
  }

  process.exitCode = 1;
}
```

### Key Methods & Properties

| Class | `code` | Key fields | Raised when |
| --- | --- | --- | --- |
| `CommandLineValidationError` | `VALIDATION_FAILED` | `issues: readonly CommandLineError[]` (frozen) | A strict invocation produced one or more issues. |
| `UnknownCommandError` | `UNKNOWN_COMMAND` | `commandName`, `availableCommands` | No registered command or alias matches the explicit token. |
| `UnknownOptionError` | `UNKNOWN_OPTION` | `optionName`, `commandName` | An option spelling is not registered in the visible scope. |
| `MalformedArgumentError` | `MALFORMED_ARGUMENT` | `argument`, `reason` | `-`/`--`, invalid option shape, or a missing option value. |
| `UnexpectedArgumentError` | `UNEXPECTED_ARGUMENT` | `argument`, `commandName` | A plain token remains after recognition. |
| `MissingRequiredOptionError` | `MISSING_REQUIRED_OPTION` | `optionName`, `commandName` | A required option is absent during non-help validation. |
| `InvalidOptionValueError` | `INVALID_OPTION_VALUE` | `optionName`, `expectedType`, `providedValue` | A type, choices, or custom-validator check fails. |
| `ConflictingOptionsError` | `CONFLICTING_OPTIONS` | `conflictingOptions: string[]` | Both sides of a conflict are explicitly supplied. |
| `MissingOptionDependencyError` | `MISSING_OPTION_DEPENDENCY` | `optionName`, `dependencyName`, `commandName` | The owner is explicit and the dependency is missing. |
| `CommandLineErrorHandlerError` | `ERROR_HANDLER_FAILED` | `parserError`, `handlerError` | The `errorHandler` hook threw or rejected. |
| `InvalidConfigurationError` | `INVALID_CONFIGURATION` | `configurationItem`, `reason` | Registration-time configuration is invalid (thrown synchronously). |

The package also exports `NoCommandProvidedError` and `CircularDependencyError` with the same typed shape for consumers that classify parser errors programmatically; the parser itself surfaces missing commands through help rendering.

---

## Diagnostics & Suggestions ("Did you mean")

### What It Is

Diagnostics are the conversion stage that turns internal recognition issues into the public typed errors, and the suggestion engine is the bounded similarity matcher behind the human-friendly `Did you mean [...]?` hints attached to unknown commands and unknown long options.

### How It Works

- **Issue conversion** — each recognition issue is converted in order: `malformed-argument` → `MalformedArgumentError`, `unknown-command` → `UnknownCommandError` (with the registered command spellings as `availableCommands`), `unknown-option` → `UnknownOptionError`, and `unexpected-argument` → `UnexpectedArgumentError`. Suggestions are attached only to unknown commands and unknown long options.
- **Scope fidelity** — suggestion candidates mirror the exact recognition scope: before the explicit command token only global options are candidates; after it, global options plus command-local options are candidates; commands and aliases are candidates for unknown commands; hidden options are excluded.
- **Eligibility** — a hint is computed only for spellings of 4 to 128 characters. The metric is Damerau–Levenshtein (an adjacent transposition counts as one edit), compared case-insensitively; the registered presentation spelling is returned.
- **Threshold** — the maximum accepted distance is 1 edit, or 2 edits when both compared spellings are at least 8 characters long.
- **Unique winner or nothing** — a hint is returned only when exactly one candidate is uniquely closest; ties produce no hint at all.
- **Bounded work** — all matchers in one invocation share a deterministic budget: at most 16 distinct misspellings are evaluated, at most 256 candidates per misspelling, and at most 512 edit-distance comparisons in total. A hint is returned only when the complete relevant candidate set fits the remaining budget; repeated misspellings are cached, so a repeated lookup costs nothing extra.
- **Never corrects input** — a suggestion is purely diagnostic: the original spelling stays invalid and rejection semantics are unchanged.

### Complete Example

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'diag-cli', strict: true });
parser.addCommand({
  name: 'deploy',
  options: [{ name: 'preserve-status', type: 'boolean' }],
  handler: () => {
    console.log('deployed');
  },
});

async function attempt(argv: string[]): Promise<void> {
  try {
    await parser.execute(undefined, { argv, write: () => undefined });
  } catch (error) {
    if (!(error instanceof CommandLineValidationError)) {
      throw error;
    }
    for (const issue of error.issues) {
      console.log(issue.message);
    }
  }
}

await attempt(['deploy', '--preserve-stauts']);
// → Unknown option [preserve-stauts] for command [deploy]. Did you mean [--preserve-status]?

await attempt(['deply']);
// → Unknown command [deply]. Available commands: deploy. Did you mean [deploy]?
```

### Key Methods & Properties

| Rule | Value |
| --- | --- |
| Minimum spelling length | 4 characters (shorter names are never compared) |
| Maximum spelling length | 128 characters (longer names are skipped entirely) |
| Distance metric | Damerau–Levenshtein; adjacent transposition = 1 edit |
| Distance threshold | ≤ 1; ≤ 2 when both spellings are ≥ 8 characters |
| Tie handling | No hint unless exactly one best candidate exists |
| Case handling | Compared case-insensitively; the registered spelling is shown |
| Candidate scope | Mirrors recognition scope; commands include aliases; hidden options excluded |
| Work budgets | ≤ 16 misspellings, ≤ 256 candidates per lookup, ≤ 512 comparisons per invocation |
| Caching | Repeated misspellings reuse the previous result without extra comparisons |
| Hint formats | Options: `. Did you mean [--name]?` — commands: ` Did you mean [spelling]?` |

---

## Help System & Output Routing

### What It Is

The help system renders the parser's text output: a welcome header, an error section (when the invocation is not a clean help request), a command table for top-level help, or a command section plus an options table for command-scoped help. Output can be routed through an injectable writer instead of the console.

### How It Works

- **Automatic help** — unless `skipHelp: true`, every command registered through `addCommand()` receives an extra boolean option spelled `--help` with short `-h`; its presence renders command help. With `skipHelp: true`, those spellings disappear: strict mode rejects them as unknown options, while legacy mode ignores them permissively.
- **Rendering** — the welcome line combines the parser name (or the script basename when no name is configured) and the configured `version` (default `1.0`). Error output lists each validation message; top-level help lists commands with their descriptions and a `[default command]` marker; command help lists the same command row plus an options table showing `--name`, the short spelling, the description (or `No description!`), and the `[required]`, `[multiple]`, `[default:value]`, and `[type]` markers.
- **Precedence in strict mode** — a clean help request (a valid command line that includes `--help`) renders help and resolves with `undefined` without executing the handler. Absent-option checks (required, defaults) are skipped so help stays clean, but explicitly supplied options still receive full value validation: `--help --count=not-a-number` rejects. Invalid input always wins over help.
- **Precedence in legacy mode** — help renders and resolves whenever errors exist or help was requested; the handler never runs in that branch.
- **Output routing** — by default help goes to the console. `invocation.write` receives every rendered line instead, which is what makes help output testable and embeddable. In the legacy path the same writer is used through `execute`.
- **`showHelp()` helper** — in legacy mode, a successful handler additionally receives a callable `showHelp` function that re-renders command help on demand.

### Complete Example

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'help-cli', version: '2.1.0', strict: true });
parser.addCommand({
  name: 'serve',
  description: 'Start the development server',
  options: [
    { name: 'port', short: 'p', type: 'number', default: 3000, description: 'Port to listen on' },
    { name: 'watch', short: 'w', type: 'boolean', description: 'Watch for changes' },
  ],
  handler: () => {
    console.log('serving');
  },
});

const lines: string[] = [];
const result = await parser.execute(undefined, {
  argv: ['serve', '--help'],
  write: line => lines.push(line),
});

console.log(result === undefined);
// → true — a clean help request resolves without executing the handler

console.log(lines.some(line => line.includes('--port')));
// → true — the command-scoped help lists the registered option

console.log(lines.some(line => line.includes('serve')));
// → true — the command section carries the command name
```

### Key Methods & Properties

| Item | Type | Description |
| --- | --- | --- |
| `skipHelp` | `boolean?` | Removes the automatic `--help`/`-h` option entirely (strict: unknown option; legacy: ignored). |
| `version` | `string?` | Shown in the welcome line; defaults to `1.0`. |
| `name` | `string` | Parser/application name used in help headers; falls back to the script basename. |
| `invocation.write` | `(message: string) => void` | Receives every rendered help or error line instead of the console. |
| `showHelp` | `() => void` | Legacy-only helper attached to handler options for on-demand help re-rendering. |

| Situation | Strict mode | Legacy mode |
| --- | --- | --- |
| Clean `--help` request | Renders command help, resolves `undefined` | Renders help, resolves `undefined` |
| Invalid input plus `--help` | Invalid input wins → rejection | Renders help, resolves `undefined` |
| `--help` plus an invalid supplied value | Rejects (supplied values are still validated) | Renders help, resolves `undefined` |
| No command and no default | Renders top-level help, resolves `undefined` | Renders top-level help, resolves `undefined` |

---

## Invocation Context & State Isolation

### What It Is

The invocation boundary is `execute(context, invocation)`: `invocation.argv` supplies the argument list, `invocation.write` captures output, and `context` is forwarded to the handler as `options.context`. Parsed state is rebuilt for every invocation, so one parser instance can serve many runs without leakage.

### How It Works

- **Arguments** — without `invocation.argv`, the parser reads `process.argv.slice(2)`. When `argv` is supplied, the process argument list is not consulted at execution time.
- **Output** — without `invocation.write`, help and error output go to the console; with it, the parser calls the writer for every rendered line.
- **Context** — the caller-supplied `context` value is opaque (`unknown`); the handler receives it merged into a fresh options object as `context`. The handler argument is `options & { context?: unknown }`, so a user-defined type guard is the type-safe way to narrow it.
- **Fresh handler object** — `createHandlerOptions()` uses `Object.assign({}, options, { context })`, producing a new object per invocation; mutating it cannot affect another run or the parser's internal state.
- **State isolation** — strict execution builds a new lookup registry and result for every call; legacy execution resets its mutable option storage and re-seeds defaults and arrays before each run. Defaults reappear on every invocation, `multiple` arrays contain only values from the current run, and a prior help request never suppresses a later valid execution.
- **Return values** — the strict path resolves with the handler's result, or `undefined` when help was rendered; the legacy path resolves with the handler's result, or `undefined` on help and error outcomes.
- **Process policy** — nothing is written to `process.exitCode` by the library; applications translate rejections into exit codes themselves.

### Complete Example

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

interface RequestContext {
  readonly environment: string;
}

function isRequestContext(value: unknown): value is RequestContext {
  return typeof value === 'object' && value !== null && 'environment' in value;
}

const parser = new CommandLineParser({ name: 'report-cli', strict: true });
parser.addCommand({
  name: 'report',
  options: [
    { name: 'format', type: 'string', choices: ['json', 'text'], default: 'text' },
    { name: 'file', type: 'string', multiple: true },
  ],
  handler: options => {
    const context = isRequestContext(options.context) ? options.context : undefined;
    const files = Array.isArray(options['file']) ? options['file'].map(String) : [];
    console.log(
      JSON.stringify({
        environment: context?.environment ?? 'unknown',
        format: options['format'],
        files,
      })
    );
  },
});

const context: RequestContext = { environment: 'test' };

await parser.execute(context, { argv: ['report', '--file=a.txt', '--file=b.txt'] });
// → {"environment":"test","format":"text","files":["a.txt","b.txt"]}

// The second invocation starts clean: no values and no defaults leak from the first run.
await parser.execute(context, { argv: ['report'] });
// → {"environment":"test","format":"text","files":[]}
```

### Key Methods & Properties

| Member | Type | Description |
| --- | --- | --- |
| `argv` | `readonly string[]?` | Application arguments without interpreter and script entries; defaults to `process.argv.slice(2)`. |
| `write` | `(message: string) => void` | Receives each rendered help or error line instead of the console. |
| `context` | `unknown` | Opaque caller-owned value forwarded to the handler as `options.context`. |

| Behavior | Guarantee |
| --- | --- |
| Argument source | `invocation.argv` when supplied; `process.argv.slice(2)` otherwise |
| Output routing | `invocation.write` when supplied; the console otherwise |
| Handler argument | Fresh object: validated values plus `context` |
| Defaults and `multiple` arrays | Rebuilt on every invocation; nothing accumulates across runs |
| Help state | Belongs to one invocation only |
| Process arguments | Not read at execution time when `argv` is supplied, and never mutated |
| Exit-code policy | Owned by the caller (`process.exitCode`), never by the library |

> **Related**: see Testing Patterns

---

# cmdline Basic Usage

This guide takes you from a fresh installation to a working command-line application: create a parser, register commands with typed options, run it against real arguments, and handle failures safely. It starts with the smallest runnable script and adds one concept at a time.

---

## Installation

Install the package with npm:

```bash
npm install blendsdk/cmdline
```

Or with yarn:

```bash
yarn add blendsdk/cmdline
```

Or with pnpm:

```bash
pnpm add blendsdk/cmdline
```

### Requirements

| Requirement | Details |
| --- | --- |
| Node.js | `>= 22.0.0` |
| Module system | ESM — set `"type": "module"` in `package.json` or use `.mjs` entry files |
| TypeScript | 5.x recommended; the package ships bundled type declarations for strict-mode type checking |

`blendsdk/stdlib` and `damerau-levenshtein` are installed automatically as runtime dependencies — nothing else is required.

---

## Quick Start

Create a file `greet.ts` with the smallest complete parser:

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'greet' }).addCommand({
  name: 'greet',
  options: [{ name: 'name', short: 'n', type: 'string', required: true }],
  handler: async options => console.log(`Hello, ${String(options['name'])}!`),
});

await parser.execute();
```

Compile it and run it:

```bash
# node greet.js greet --name Ada
#   → Hello, Ada!
#
# node greet.js greet
#   → renders help ("Missing required option [name]") and resolves
#     without calling the handler
```

That is the whole lifecycle: one parser, one command, one typed option. The sections below build on it.

---

## Fundamentals

The parser is a small facade with four moving parts: a configuration object, registered commands, option definitions, and an async `execute()` call. Each subsection introduces one of them.

### 1. Create the parser

Every application starts with one `CommandLineParser` instance:

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'greet-cli',
  version: '1.0.0',
});
```

Key facts about the configuration:

- `name` is required. It appears in the help heading and is used as diagnostic context for top-level failures.
- `version` is optional and defaults to `'1.0'`.
- The constructor validates and defensively clones the configuration. An invalid definition — a reserved name, a malformed option spelling, a duplicate short name — throws `InvalidConfigurationError` synchronously, long before any argument is parsed.

### 2. Register commands

`addCommand()` registers a command and returns the same parser instance, so registrations chain:

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'greet-cli', version: '1.0.0' })
  .addCommand({
    name: 'greet',
    description: 'Greet someone by name',
    handler: async () => {
      console.log('Hello, world!');
    },
  })
  .addCommand({
    name: 'status',
    description: 'Print the current status',
    handler: async () => {
      console.log('All systems operational.');
    },
  });

await parser.execute();
```

- The handler runs only after the parser has selected the command and validated its options.
- Command names must start with a letter and may contain letters, digits, hyphens, and underscores. The names `help` and `version` are reserved.
- With multiple commands registered, running without a command name renders top-level help instead of executing anything.
- `default: true` marks a command to run when no command token is present. The default is honored only while exactly one command is registered.

### 3. Declare typed options

Options are declared per command, with a long name, an optional one-letter short name, and a runtime `type`:

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'greet-cli', version: '1.0.0' }).addCommand({
  name: 'greet',
  description: 'Greet someone by name',
  options: [
    {
      name: 'name',
      short: 'n',
      type: 'string',
      required: true,
      description: 'Name of the person to greet',
    },
    {
      name: 'greeting',
      short: 'g',
      type: 'string',
      default: 'Hello',
      description: 'Greeting to use',
    },
    {
      name: 'loud',
      short: 'l',
      type: 'boolean',
      description: 'Uppercase the output',
    },
  ],
  handler: async options => {
    const name = String(options['name']);
    const greeting = String(options['greeting']);
    const loud = options['loud'] === true;
    const message = `${greeting}, ${name}!`;
    console.log(loud ? message.toUpperCase() : message);
  },
});

await parser.execute();
```

Values reach the handler under the canonical long name, no matter which spelling was used on the command line:

| Input on the command line | Value inside the handler |
| --- | --- |
| `--name Ada`, `--name=Ada`, `-n Ada`, `-n=Ada`, `-nAda` | `options['name'] === 'Ada'` (string) |
| `--loud` | `options['loud'] === true` (boolean flag) |
| `--loud=false` | `options['loud'] === false` |
| `-g "Good morning"` | `options['greeting'] === 'Good morning'` (overrides the default) |
| `--greeting` omitted | `options['greeting'] === 'Hello'` (the declared default) |

```bash
# node greet-cli.js greet --name Ada
#   → Hello, Ada!
#
# node greet-cli.js greet -n Ada -g "Good morning" --loud
#   → GOOD MORNING, ADA!
```

For the next level of complexity, options can assert more about their values — numeric conversion, allowed choices, and format checks all run before your handler sees anything:

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'report-cli', version: '1.0.0' }).addCommand({
  name: 'report',
  description: 'Render a report',
  options: [
    { name: 'rows', short: 'r', type: 'number', default: 10, description: 'Row count' },
    { name: 'format', short: 'f', type: 'string', choices: ['table', 'json'], default: 'table' },
    { name: 'owner', short: 'o', type: 'email', description: 'Owner address' },
  ],
  handler: async options => {
    const rows = Number(options['rows']);
    const format = String(options['format']);
    console.log(`Rendering ${rows} rows as ${format}.`);
  },
});

await parser.execute();
```

Here `--rows=50` arrives as the number `50`, `--format=xml` is rejected because it is not in `choices`, and `--owner=not-an-email` fails email validation — in every case, the handler is not called.

### 4. Execute the parser

`execute()` reads `process.argv.slice(2)` by default, so a typical entry file ends with a single call:

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'greet-cli', version: '1.0.0' }).addCommand({
  name: 'greet',
  options: [{ name: 'name', short: 'n', type: 'string', required: true }],
  handler: async options => {
    const name = String(options['name']);
    console.log(`Hello, ${name}!`);
    return { greeted: name, hasContext: options.context !== undefined };
  },
});

const result: unknown = await parser.execute({ traceId: 'trace-001' });
console.log('Handler returned:', result);
```

- `execute()` returns a promise that resolves to the selected handler's return value (or `undefined` when help was rendered instead of executing).
- Pass an application value as the first argument; it arrives at the handler as `options.context`.
- Parsed values never persist between invocations — each call starts fresh from the declared defaults.

### 5. Supply arguments and capture output

For tests, embedding, or scripted retries, override the invocation boundary with `{ argv, write }`:

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'greet-cli', version: '1.0.0' }).addCommand({
  name: 'greet',
  options: [{ name: 'name', short: 'n', type: 'string', required: true }],
  handler: async options => {
    console.log(`Hello, ${String(options['name'])}!`);
  },
});

const helpLines: string[] = [];

await parser.execute(undefined, {
  argv: ['greet', '--name', 'Ada'],
  write: line => helpLines.push(line),
});

await parser.execute(undefined, {
  argv: ['greet', '--help'],
  write: line => helpLines.push(line),
});

console.log(helpLines.join('\n'));
```

- `argv` replaces `process.argv.slice(2)` for that invocation; pass the arguments exactly as they appear after the script name — no interpreter or script entries.
- `write` receives every rendered help line instead of the process console (it defaults to `console.log`). Normal handler output is unaffected.
- `process.argv` is neither read nor mutated when `argv` is supplied, and one parser instance can serve any number of independent invocations.

### 6. Opt into strict mode

By default the parser runs in legacy mode — the case-normalized, help-and-resolve behavior kept for v5 compatibility. Setting `strict: true` switches to exact, case-sensitive, fail-closed recognition:

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'greet-cli',
  version: '1.0.0',
  strict: true,
}).addCommand({
  name: 'greet',
  options: [{ name: 'name', short: 'n', type: 'string', required: true }],
  handler: async options => {
    console.log(`Hello, ${String(options['name'])}!`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    for (const issue of error.issues) {
      console.error(`[${issue.code}] ${issue.message}`);
    }
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

What changes in strict mode:

- Commands and long options must match their registered spelling exactly; nothing is silently ignored or case-folded.
- On any invalid input, the handler does not run and execution rejects with `CommandLineValidationError`.
- A clean help request — `--help` or `-h` on an otherwise valid invocation — renders help and resolves; it is not an error. Invalid input still rejects even when help is also requested.

The same invocations behave very differently in each mode:

| Invocation | Legacy (default) | Strict (`strict: true`) |
| --- | --- | --- |
| `greet --name Ada` | Handler runs with `name: 'Ada'`. | Same. |
| `greet` (missing required) | Renders help (`Missing required option [name]`), resolves. | Rejects with `CommandLineValidationError`; handler never runs. |
| `greet --nmae Ada` | `name` is missing → renders help, resolves. | Rejects; the issue message includes `Did you mean [--name]?`. |
| `greet --help` | Renders help, resolves. | Clean help: renders help, resolves. |
| `greet --unknown extra` | Unknown tokens are ignored; the handler still runs. | Rejects with one issue per leftover token. |

```bash
# node greet-cli.js greet --nmae Ada
#   → renders the command help; the issue message reads:
#     Unknown option [nmae] for command [greet]. Did you mean [--name]?
#   → then rejects with CommandLineValidationError; the caller sets process.exitCode = 1
```

---

## Configuration

All configuration is validated and defensively cloned when you construct the parser or register a command: later mutation of the objects you passed in cannot change parser behavior. The tables below cover the fields you will use most; every optional field defaults as shown.

### Parser configuration

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — (required) | Application name shown in the help heading and used as diagnostic context for top-level failures. |
| `version` | `string` | `'1.0'` | Version string shown beside the name in the help heading. |
| `strict` | `boolean` | `false` | Enables exact, case-sensitive, fail-closed recognition. Legacy mode remains the v5 default; set `strict: true` to opt in. |
| `skipHelp` | `boolean` | `false` | When `true`, no automatic `--help` / `-h` option is added to commands. |
| `globalOptions` | `ICommandOption[]` | `undefined` | Options accepted before or after every explicit command; their long and short spellings must not collide with command-local options. |
| `errorHandler` | `(error: CommandLineError) => void \| Promise<void>` | `undefined` | Strict-mode hook that replaces built-in invalid-input rendering; awaited before the parser rejects. |

### Command configuration

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — (required) | Canonical command spelling; must start with a letter and contain only letters, digits, hyphens, and underscores. `help` and `version` are reserved. |
| `description` | `string` | `undefined` | Help text shown for the command. |
| `options` | `ICommandOption[]` | `undefined` | Command-local options (see below). |
| `handler` | `(options) => Promise<unknown> \| unknown` | — (required) | Async (or sync) function invoked after successful recognition and validation. |
| `default` | `boolean` | `false` | Runs when no command token is present; honored only while exactly one command is registered. |
| `aliases` | `string[]` | `undefined` | Additional validated spellings that select the same command. Exact in strict mode, case-normalized in legacy mode. |
| `hidden` | `boolean` | `false` | Excluded from help output; still selectable. |

### Option configuration

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — (required) | Long name used as `--name` and as the key your handler reads. |
| `short` | `string` | `undefined` | Single-letter short name used as `-n`. The letter `h` is rejected while automatic help is enabled. |
| `description` | `string` | `undefined` | Help text shown by the built-in renderer. |
| `type` | `'string' \| 'number' \| 'boolean' \| 'email' \| 'domain'` | `'string'` | Runtime type; raw tokens are converted and then validated against it. |
| `required` | `boolean` | `false` | The invocation fails when the option is absent. |
| `default` | value matching `type` | `undefined` | Applied when the option is absent; validated exactly like a supplied value. |
| `multiple` | `boolean` | `false` | Accumulates repeated occurrences into an array in source order. |
| `choices` | value array | `undefined` | Allowed values; must be a non-empty array. |
| `validator` | `(value) => boolean \| string` | `undefined` | Custom check; return `true`, or a message that becomes the failure reason. |
| `conflicts` | `string[]` | `undefined` | Canonical names that cannot be explicitly supplied together with this option. |
| `depends` | `string[]` | `undefined` | Canonical names required when this option is explicitly supplied. |
| `hidden` | `boolean` | `false` | Excluded from help output; still recognized. |

Relationship semantics (`conflicts` / `depends`) are covered in depth in **Advanced Patterns**.

---

## Error Handling

The library never terminates your process on a parsing problem — it renders help or rejects with typed errors, and leaves the exit policy to you. Where a failure surfaces depends on when it happens.

### Configuration errors

The constructor and `addCommand()` validate eagerly and throw `InvalidConfigurationError` synchronously for reserved names, malformed spellings, duplicate commands, options, or aliases, scope collisions between global and command options, an empty `choices` array, or a short `h` that collides with automatic help. A misconfigured CLI fails at startup, before `execute()` is ever called.

### Invocation failures

- **Legacy mode (default).** Parser-recorded problems do not throw: help — including the error details — is rendered and `execute()` resolves with `undefined`. Your handler is not called. Errors thrown inside your own handler still propagate as a rejection.
- **Strict mode.** Any parser-owned problem rejects with `CommandLineValidationError`, whose `issues` array contains every specific issue for that invocation: token problems first, in input order, followed by option validation problems in declaration order. A clean help request renders help and resolves instead of rejecting.

### Catching and classifying failures

Every failure extends the abstract `CommandLineError` base class:

| Member | Type | Description |
| --- | --- | --- |
| `message` | `string` | Human-readable summary; for unknown commands and long options it can end with a `Did you mean [--x]?` hint. |
| `code` | `string` | One of the `ErrorCode` values (for example `VALIDATION_FAILED` or `UNKNOWN_OPTION`) for programmatic branching. |
| `category` | `ErrorCategory` | `PARSING`, `VALIDATION`, or `CONFIGURATION`. |
| `context` | `Record<string, unknown>` (optional) | Structured details such as `argument`, `optionName`, `commandName`, or `issueCount`. |

`isCommandLineError(error)` is an exported type guard for narrowing `unknown` catch values. The standard strict-mode entry point looks like this:

```typescript
import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
  isCommandLineError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'greet-cli',
  version: '1.0.0',
  strict: true,
}).addCommand({
  name: 'greet',
  options: [{ name: 'name', short: 'n', type: 'string', required: true }],
  handler: async options => {
    console.log(`Hello, ${String(options['name'])}!`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!isCommandLineError(error)) {
    throw error;
  }

  if (error instanceof CommandLineValidationError) {
    for (const issue of error.issues) {
      console.error(`[${issue.code}] ${issue.message}`);
    }
  } else if (error instanceof CommandLineErrorHandlerError) {
    console.error(`Could not present the parser error: ${String(error.handlerError)}`);
  } else {
    console.error(`[${error.code}] ${error.message}`);
  }

  process.exitCode = 1;
}
```

Notes on this pattern:

- `CommandLineValidationError.issues` is a copied, frozen array — it cannot change while you handle it.
- Handler errors are not wrapped: if your command handler throws, that error propagates unchanged and `isCommandLineError` returns `false` for it (the example rethrows).
- The library never terminates the process; the example translates a typed rejection into `process.exitCode = 1`.

### Custom error presentation

In strict mode, `errorHandler` replaces the built-in invalid-input rendering. The parser awaits the hook and then rejects with the same aggregate, so your `catch` block still receives the `CommandLineValidationError`:

```typescript
import { CommandLineError, CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'greet-cli',
  version: '1.0.0',
  strict: true,
  errorHandler: async (error: CommandLineError) => {
    console.error(`Command failed: ${error.message}`);
  },
});
```

If the hook itself throws or rejects, execution rejects with `CommandLineErrorHandlerError`, which carries both the original `parserError` and the thrown `handlerError`.

### Error reference

| Class | Code | Category | Meaning |
| --- | --- | --- | --- |
| `InvalidConfigurationError` | `INVALID_CONFIGURATION` | `CONFIGURATION` | Invalid parser, command, option, or alias definition; thrown synchronously at construction or `addCommand()`. |
| `MalformedArgumentError` | `MALFORMED_ARGUMENT` | `PARSING` | A token that cannot be interpreted — a bare `-` or `--`, a malformed option name, or a non-boolean option whose value is missing. |
| `UnknownCommandError` | `UNKNOWN_COMMAND` | `PARSING` | The first plain token matches no registered command spelling; may carry a `Did you mean` hint. |
| `UnknownOptionError` | `UNKNOWN_OPTION` | `PARSING` | An option spelling is not registered in the visible scope; may carry a `Did you mean` hint for long options. |
| `UnexpectedArgumentError` | `UNEXPECTED_ARGUMENT` | `PARSING` | A plain argument remained after the command and its options were consumed. |
| `MissingRequiredOptionError` | `MISSING_REQUIRED_OPTION` | `VALIDATION` | A `required` option was not supplied. |
| `InvalidOptionValueError` | `INVALID_OPTION_VALUE` | `VALIDATION` | A supplied or defaulted value failed type, `choices`, or custom `validator` checks. |
| `ConflictingOptionsError` | `CONFLICTING_OPTIONS` | `VALIDATION` | Two options declared to `conflicts` with each other were both explicitly supplied. |
| `MissingOptionDependencyError` | `MISSING_OPTION_DEPENDENCY` | `VALIDATION` | An explicitly supplied option is missing a declared `depends` companion. |
| `CommandLineValidationError` | `VALIDATION_FAILED` | `VALIDATION` | Strict-mode aggregate for one invocation; `issues` is frozen and ordered. |
| `CommandLineErrorHandlerError` | `ERROR_HANDLER_FAILED` | `VALIDATION` | The custom `errorHandler` failed; wraps `parserError` and `handlerError`. |
| `NoCommandProvidedError` | `NO_COMMAND_PROVIDED` | `PARSING` | Represents a missing command when no default command can run. |
| `CircularDependencyError` | `CIRCULAR_DEPENDENCY` | `CONFIGURATION` | Represents a cycle in a command dependency chain. |

All of these extend `CommandLineError`, and the `ErrorCode` / `ErrorCategory` enums are exported for exhaustive branching. With these building blocks — one parser, chained commands, typed options, and a single rejection handler — you have the complete basic surface; **Advanced Patterns** picks up from here with global options, option relationships, and deeper validation.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
