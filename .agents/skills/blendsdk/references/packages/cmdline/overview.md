> **Package**: `blendsdk/cmdline`

# cmdline Overview

---

## What It Is

`blendsdk/cmdline` is a command-line parser and options interpreter for TypeScript applications running on Node.js (>= 22, ESM). You declare commands and their options as plain configuration objects, attach asynchronous handlers, and hand the parser an argument list; the parser recognizes commands and options, converts and validates values, renders help, and reports every problem through typed errors.

The package ships two parsing modes behind one facade:

- **Strict mode** (`strict: true`, opt-in) — exact, case-sensitive, fail-closed recognition. Invalid input is collected as typed issues, rendered or handed to a custom `errorHandler` hook, and then rejected with `CommandLineValidationError`. A command handler is never invoked after invalid input.
- **Legacy mode** (`strict: false`) — the case-normalized, help-and-resolve compatibility path. Legacy mode remains the v5 default, so existing applications keep their historic behavior until they explicitly opt in.

Execution is invocation-local. `execute()` defaults to `process.argv` and the console, but callers can supply both the argument list and an output writer, so a single parser instance is reusable across invocations and fully testable in-process. The library never terminates the process — it rejects (or resolves for clean help) and leaves `process.exitCode` policy to the application.

---

## Key Features

- **Two parsing modes** — opt into `strict: true` for exact, fail-closed recognition, or keep legacy mode, which remains the v5 default for backward compatibility.
- **Declarative commands** — canonical names, aliases (exact in strict mode, case-normalized in legacy), descriptions, examples, categories, `hidden`, and default-command selection (effective only when exactly one command is registered).
- **Typed options** — `string`, `number`, `boolean`, `email`, and `domain` values with automatic conversion; `isValidEmail` / `isValidDomain` validators and human-readable error-message helpers are exported for reuse.
- **Rich option constraints** — `required`, `default`, `multiple` (order-preserving accumulation), `choices`, custom `validator` functions, `conflicts`, `depends`, and `hidden`.
- **Global options** — accepted before or after an explicit command; long/short collisions between global and command scopes are rejected at registration time.
- **Automatic help** — `--help` / `-h` are added to every command unless `skipHelp: true`; help lines can be routed through an injectable `write` function. In strict mode, `--help` with otherwise valid input is a clean help-and-resolve — but invalid input still wins and rejects.
- **Fail-closed diagnostics** — unknown commands, unknown options, malformed tokens, unexpected positional arguments, and missing option values are captured as ordered issue records and converted into typed errors.
- **Typed error hierarchy** — every error exposes `code`, `category` (`ErrorCategory`), and structured fields (`ErrorCode`, `isCommandLineError`); strict failures aggregate into `CommandLineValidationError.issues`, a frozen, ordered array.
- **"Did you mean" hints** — Damerau–Levenshtein similarity suggestions (for example, `Did you mean [--preserve-status]?`) computed under fixed lookup and comparison budgets, so a hint is only shown when a unique best match is provably available.
- **Invocation-local state** — `execute(context, { argv, write })` supplies arguments and captures output; no parsed values or help state cross invocation boundaries.
- **Defensive configuration** — parser config, commands, aliases, and options are cloned at registration; later mutation of caller-owned objects cannot change parser behavior.
- **No process termination** — the library rejects; the caller decides whether to set `process.exitCode`.

---

## When To Use

### Choose `blendsdk/cmdline` when

- You are building a Node.js (>= 22), ESM CLI with one or more commands and want declarative command/option definitions instead of hand-rolled `argv` scanning.
- You need fail-closed parsing for scripts and automation: a misspelled option or stray operand must never be silently ignored or absorbed into a normal command run.
- Options need real runtime types and cross-option rules — numbers, booleans, emails, domains, `choices`, custom validators, and `conflicts` / `depends` relationships.
- You want built-in help text with automatic `--help` / `-h` handling for every command.
- You need to unit-test CLI behavior in-process by injecting `argv` and a `write` collector, and by reusing one parser across many invocations.
- You maintain a v5 application that must keep its historic permissive behavior — legacy mode remains the v5 default, and strict mode can be adopted one parser at a time.

### Prefer another approach when

- You need positional operand grammars or Unix `--` passthrough semantics — a bare `-` or `--` is treated as a malformed argument in both modes.
- You need multi-level subcommand execution — `subcommands` exists in the type definitions, but execution currently reads only the top-level command registry.

---

## Architecture

`CommandLineParser` is a facade over two pipelines. Both share configuration validation, the help renderer, and the typed error hierarchy; they differ in recognition and failure behavior.

### Invocation pipeline (strict mode)

```text
┌──────────────────────────────────────────────────────────────────┐
│ 1 · Configuration   configuration.ts                             │
│     validate + clone parser config, commands, options, aliases   │
├──────────────────────────────────────────────────────────────────┤
│ 2 · Registry        argument-parser.ts → createArgumentRegistry  │
│     immutable lookup tables: strict/legacy × commands/options    │
├──────────────────────────────────────────────────────────────────┤
│ 3 · Recognition     argument-parser.ts → parseArguments (pure)   │
│     argv → IArgumentParseResult { command, options,              │
│     occurrences, issues } — no process or handler side effects   │
├──────────────────────────────────────────────────────────────────┤
│ 4 · Diagnostics     strict-diagnostics.ts · suggestions.ts       │
│     issues → typed errors with bounded "Did you mean" hints      │
├──────────────────────────────────────────────────────────────────┤
│ 5 · Validation      strict-validation.ts                         │
│     defaults, required, types, choices, validators,              │
│     conflicts/depends → typed CommandLineError[]                 │
├──────────────────────────────────────────────────────────────────┤
│ 6 · Outcome         cmdline.ts · help-renderer.ts                │
│     reject CommandLineValidationError, render help,              │
│     or run command.handler(options & { context })                │
└──────────────────────────────────────────────────────────────────┘
```

Key details per stage:

1. **Configuration** — The constructor and `addCommand()` validate and defensively clone parser configuration, commands, and options. Reserved names (`help`, `version`), duplicate or colliding spellings, global/command scope collisions, and a short `h` colliding with automatic help throw `InvalidConfigurationError` at registration time; bad configuration never reaches parsing.
2. **Registry** — `createArgumentRegistry()` builds immutable `Map` lookup tables keyed by declared spelling (`strict`) and by lower-cased spelling (`legacy`) for commands and global options, with deterministic first-owner precedence.
3. **Recognition** — `parseArguments()` walks the argument list, selects the command (an explicit spelling wins; a configured default applies only when the registry holds exactly one command), and consumes option values in attached (`--opt=value`), compact short (`-ovalue`), or separate-token form. Negative decimal values are consumed only by registered `number` options; every unconsumed or malformed token becomes an issue carrying its original index.
4. **Diagnostics** — `createStrictTokenErrors()` converts issue records into `UnknownCommandError`, `UnknownOptionError`, `MalformedArgumentError`, or `UnexpectedArgumentError`, attaching suggestions from the exact visibility scope the token would have been recognized in.
5. **Validation** — `validateStrictOptions()` applies defaults, enforces `required`, checks runtime types, `choices`, and custom `validator` results. `validateOptionRelationships()` evaluates `conflicts` / `depends` from explicit occurrences only: a default alone never activates a relationship, while an explicitly supplied `false` counts as present.
6. **Outcome** — If issues exist, the optional `errorHandler` hook is awaited (or built-in help is rendered), then execution rejects with a `CommandLineValidationError` whose `issues` are ordered (token issues in input order first, then validation issues in declaration order). A clean `--help` request renders help and resolves; otherwise the handler runs with option values merged with the caller's `context`.

The legacy path (`strict: false`) folds stages 3–6 into the historic `parseTokens()` → `validate()` pipeline: case-insensitive lookup, JSON-shaped value interpretation, help-and-resolve on errors or help requests, and a `showHelp()` helper passed to successful handlers.

### Design patterns

| Pattern | Where it appears |
| --- | --- |
| Fluent builder | `CommandLineParser.addCommand()` returns the parser instance for chaining. |
| Strategy | `ArgumentLookupMode` (`'strict'` \| `'legacy'`) selects exact or normalized lookup tables per invocation. |
| Registry / lookup tables | Immutable maps from `createArgumentRegistry()` make recognition deterministic and invocation-independent. |
| Pure-function core | `parseArguments()` and `findLegacyCommandIndex()` perform no I/O and return plain result objects. |
| Value/result objects | `IArgumentParseResult`, `IOptionOccurrence`, and `IArgumentIssue` capture a full invocation as data. |
| Aggregate + typed error hierarchy | `CommandLineError` base with `code` / `category` / `context`; `CommandLineValidationError` aggregates per-issue errors. |
| Factory functions | `createArgumentRegistry`, `createStrictTokenErrors`, `createHandlerOptions`, `createSuggestionSession`. |
| Dependency injection | `ICommandLineInvocation.write`, `errorHandler`, `context`, and per-option `validator` callbacks are caller-supplied boundaries. |
| Defensive copy | `cloneParserConfiguration()` / `cloneCommandConfiguration()` detach parser state from caller-owned objects. |

---

## Dependencies

### Runtime dependencies

| Dependency | Version | Role |
| --- | --- | --- |
| `blendsdk/stdlib` | `^5.x` | Type guards (`isString`, `isNumeric`, `isBoolean`) used by legacy and strict value validation. |
| `damerau-levenshtein` | `^1.0.8` | Edit-distance computation behind the bounded "Did you mean" suggestions. |

### Peer dependencies

None. The package targets Node.js >= 22 and ships ESM-only output (`"type": "module"`) with bundled type declarations; it does not require any framework, logger, or other runtime package to be supplied by the consumer.

### Downstream consumers

Within the BlendSDK monorepo, `blendsdk/cmdline` is an internal workspace package (declared `private`) that reaches consumers through the published `blendsdk` umbrella. It is consumed by BlendSDK command-line tooling and by any application package that needs argument parsing. It is a leaf-level utility: nothing in the BlendSDK stack depends on `blendsdk/cmdline` for parsing in return.

---

## Minimum Example

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'greet-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'greet',
  description: 'Greet someone by name',
  options: [{ name: 'name', short: 'n', type: 'string', required: true }],
  handler: async options => {
    console.log(`Hello, ${String(options['name'])}!`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  process.exitCode = 1;
}
```

```bash
# node greet-cli.js greet --name Ada
#   → Hello, Ada!
#
# node greet-cli.js greet --nmae Ada
#   → renders command help with: Did you mean [--name]?
#   → rejects with CommandLineValidationError; the caller sets process.exitCode = 1
```

The parser reads `process.argv` by default; pass `{ argv: [...] }` as the second argument to `execute()` to supply arguments explicitly (for tests or embedding), and `{ write: line => ... }` to capture help output instead of writing to the console.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
