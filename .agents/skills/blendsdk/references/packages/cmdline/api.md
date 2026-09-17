> **Package**: `blendsdk/cmdline`

# cmdline API Reference

This document is the complete reference for every symbol exported from the package root. `blendsdk/cmdline` parses command-line arguments into validated, typed option objects and dispatches to command handlers. Legacy mode remains the v5 default; strict mode — enabled with `strict: true` — adds exact, case-sensitive, fail-closed recognition whose failures reject with a `CommandLineValidationError` aggregate. The library never terminates the process; the caller owns `process.exitCode` policy.

---

## Export Overview

All symbols below are importable from `'blendsdk/cmdline'` only. Source modules such as `argument-parser`, `configuration`, `help-renderer`, `strict-diagnostics`, `strict-validation`, and `suggestions` are internal and are not part of the public API.

### Classes

| Export | Description |
|--------|-------------|
| `CommandLineParser` | Facade for configuration, command registration, and invocation execution in legacy or strict mode. |

### Functions

| Export | Signature | Description |
|--------|-----------|-------------|
| `isCommandLineError` | `isCommandLineError(error: unknown): error is CommandLineError` | Type guard for parser-owned errors. |
| `isValidEmail` | `isValidEmail(value: string): boolean` | Validates practical email addresses. |
| `isValidDomain` | `isValidDomain(value: string): boolean` | Validates domain names, including subdomains. |
| `getEmailValidationError` | `getEmailValidationError(value: string): string` | Human-readable reason an email string is invalid. |
| `getDomainValidationError` | `getDomainValidationError(value: string): string` | Human-readable reason a domain string is invalid. |

### Enums

| Export | Description |
|--------|-------------|
| `ErrorCategory` | Coarse failure grouping: `PARSING`, `VALIDATION`, `CONFIGURATION`. |
| `ErrorCode` | Stable programmatic error codes for every failure class. |

### Constants

| Export | Type | Description |
|--------|------|-------------|
| `RESERVED_OPTION_NAMES` | `readonly ['help', 'version']` | Option names rejected during registration. |
| `RESERVED_COMMAND_NAMES` | `readonly ['help', 'version']` | Command spellings rejected during registration. |

### Error Classes

| Export | Error Code | Description |
|--------|------------|-------------|
| `CommandLineError` | — | Abstract base class carrying `code`, `category`, and `context`. |
| `CommandLineValidationError` | `VALIDATION_FAILED` | Aggregate of one failed strict invocation. |
| `CommandLineErrorHandlerError` | `ERROR_HANDLER_FAILED` | Parser failure combined with a failing `errorHandler` hook. |
| `UnexpectedArgumentError` | `UNEXPECTED_ARGUMENT` | A plain argument remained after supported tokens were consumed. |
| `UnknownCommandError` | `UNKNOWN_COMMAND` | Unrecognized command spelling. |
| `UnknownOptionError` | `UNKNOWN_OPTION` | Unrecognized option spelling. |
| `MalformedArgumentError` | `MALFORMED_ARGUMENT` | Malformed argument text. |
| `MissingRequiredOptionError` | `MISSING_REQUIRED_OPTION` | Required option absent. |
| `InvalidOptionValueError` | `INVALID_OPTION_VALUE` | Value failed type, choices, or validator validation. |
| `ConflictingOptionsError` | `CONFLICTING_OPTIONS` | Mutually exclusive options supplied together. |
| `MissingOptionDependencyError` | `MISSING_OPTION_DEPENDENCY` | Declared dependency not satisfied. |
| `NoCommandProvidedError` | `NO_COMMAND_PROVIDED` | No command and no default available. |
| `CircularDependencyError` | `CIRCULAR_DEPENDENCY` | Circular dependency chain detected. |
| `InvalidConfigurationError` | `INVALID_CONFIGURATION` | Registration-time configuration failure. |

### Interfaces

| Export | Description |
|--------|-------------|
| `ICommandLineParser` | Parser configuration. |
| `ICommandLineInvocation` | Invocation-local `argv` and help output writer. |
| `ICommand` | Command definition with handler. |
| `ICommandOption` | Option definition. |
| `IToken` | Legacy parsed token. |
| `IValidationResult` | Declared token-validation result shape. |
| `IParsingContext` | Declared internal parsing-context shape. |
| `IHelpOptions` | Declared help-formatting options. |

### Type Aliases

| Export | Definition | Description |
|--------|------------|-------------|
| `OptionValueType` | `string \| number \| boolean` | Supported option value types. |
| `OptionValue<T>` | `T \| T[]` | Single value or accumulated array. |
| `Dictionary<T>` | `Record<string, T>` | Generic string-keyed dictionary; `T` defaults to `unknown`. |
| `OptionsDict` | `Dictionary<OptionValue>` | Canonical option-value dictionary. |
| `CommandHandler<TOptions>` | `(options: TOptions & { context?: unknown }) => Promise<unknown> \| unknown` | Handler function type. |
| `OptionTypeString` | `'string' \| 'number' \| 'boolean' \| 'email' \| 'domain'` | Declarable option types. |
| `OptionTypeMap` | `{ string: string; number: number; boolean: boolean; email: string; domain: string }` | Maps each option type string to its runtime type. |
| `TypeFromOptionType<T>` | `OptionTypeMap[T]` | TypeScript type for one option type string. |
| `InferOptionsType<T>` | Mapped type | Strongly typed options object derived from an option array. |
| `ReservedOptionName` | `'help' \| 'version'` | Member type of `RESERVED_OPTION_NAMES`. |
| `ReservedCommandName` | `'help' \| 'version'` | Member type of `RESERVED_COMMAND_NAMES`. |

---

## CommandLineParser

`CommandLineParser` is the facade for configuring, populating, and executing a command-line application. One instance owns a validated configuration and a list of registered commands, and it can execute any number of invocations. Each invocation is independent: parsed values, help state, and validation results never cross an `execute()` boundary.

The parser never renders help to the console directly when a custom writer is supplied, never terminates the process, and never invokes a command handler after invalid input in strict mode.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deploy-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'deploy',
  description: 'Deploy the application to an environment',
  options: [
    {
      name: 'environment',
      short: 'e',
      type: 'string',
      required: true,
      choices: ['staging', 'production'],
    },
    { name: 'dry-run', type: 'boolean', default: false },
  ],
  handler: async options => {
    const environment = String(options['environment']);
    const dryRun = options['dry-run'] === true;
    console.log(`Deploying to ${environment}${dryRun ? ' (dry run)' : ''}`);
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

### Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `constructor` | `constructor(config?: ICommandLineParser)` | `CommandLineParser` | Creates a parser from a cloned, validated configuration. |
| `execute` | `execute(context?: any): Promise<any>` | `Promise<any>` | Legacy-compatible overload: runs one invocation and returns the handler result without narrowing its type, so existing v5 `Promise<T>` assignments keep compiling. |
| `execute` | `execute(context: unknown, invocation: ICommandLineInvocation): Promise<unknown>` | `Promise<unknown>` | Invocation-local overload: supplies `argv` and a help `write` sink for one execution. |
| `addCommand` | `addCommand(config: ICommand): CommandLineParser` | `CommandLineParser` | Clones, validates, and registers a command; returns the parser for chaining. |

---

### Constructor

```typescript
public constructor(config?: ICommandLineParser)
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `ICommandLineParser` | No | `{ name: 'default' }` | Parser configuration; deep-copied so later mutation of caller-owned objects has no effect. |

Behavior:

- The configuration (including `globalOptions` and `helpOption`) is cloned before use; registration is a trust boundary for caller-owned objects.
- `globalOptions` are validated immediately: reserved names, malformed names, duplicate spellings, empty `choices`, and a short `h` colliding with automatic help throw `InvalidConfigurationError` before any parsing can occur.
- `version` defaults to `'1.0'` when omitted.
- The constructor captures process invocation metadata used for help rendering: the interpreter (`process.argv[0]`), the resolved script path (`process.argv[1]`), and the display `scriptName` (configured name, or the script basename).

**Throws**: `InvalidConfigurationError`.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'tool-cli',
  version: '2.3.0',
  strict: true,
  globalOptions: [{ name: 'verbose', short: 'v', type: 'boolean' }],
});
```

---

### execute()

Signatures (overloads):

```typescript
public execute(context?: any): Promise<any>;
public execute(context: unknown, invocation: ICommandLineInvocation): Promise<unknown>;
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `context` | `unknown` | No | `undefined` | Caller-owned value forwarded to the selected command handler as `options.context`. |
| `invocation` | `ICommandLineInvocation` | No | `{}` | Invocation-local input and output overrides. |
| `invocation.argv` | `readonly string[]` | No | `process.argv.slice(2)` | Application arguments without interpreter and script entries. |
| `invocation.write` | `(message: string) => void` | No | `console.log` | Receives each rendered help line instead of the process console. |

**Returns**: `Promise<unknown>` — the selected command handler's result, or `undefined` when help was rendered (no command selected, a clean help request, or the legacy help-and-resolve path).

**Throws**:

| Error | When |
|-------|------|
| `CommandLineValidationError` | Strict mode: one or more parser-owned issues were collected. |
| `CommandLineErrorHandlerError` | Strict mode: the configured `errorHandler` threw or rejected while presenting the aggregate. |
| Handler errors | The selected command handler's own exceptions/rejections propagate unchanged in both modes. |

#### Strict execution steps (`strict: true`)

1. The argument registry is rebuilt for this invocation from the registered commands and global options.
2. `argv` is recognized exactly: the command is selected by exact (or alias) spelling, option values are consumed, and every unconsumed token becomes an issue carrying its original index.
3. Issues are converted into typed errors; a uniquely closest registered spelling produces a `Did you mean` hint where a safe suggestion is provable.
4. Unless the command token is unknown, supplied and default values are validated (types, `choices`, `validator`) together with `required` options and `conflicts` / `depends` relationships. For a help request, absent-option checks are skipped — but any value supplied alongside `--help` is still validated and can reject the invocation.
5. If issues remain, the configured `errorHandler` is awaited (otherwise the built-in path renders the collected messages as help first), and execution rejects with the aggregate. The command handler never runs.
6. If no command is selected, top-level help is rendered and execution resolves with `undefined`.
7. `--help` / `-h` with otherwise valid input is a clean help request: command help is rendered and execution resolves with `undefined`.
8. Otherwise the handler runs with the canonical option values merged with `context`, and its result is returned.

#### Legacy execution steps (default)

1. `argv` is tokenized with the historic rules: paired quotes and escaped characters are normalized, and JSON-shaped values are interpreted with `JSON.parse` when possible.
2. The command is selected case-insensitively at the first application position not consumed by a valid leading global option; a malformed or unknown leading token prevents command selection.
3. Values are validated: defaults, `required`, types, `choices`, custom `validator` results, and `conflicts` / `depends` relationships.
4. Missing command, validation errors, a help request, or malformed input render help and resolve with `undefined`; the handler never runs.
5. Otherwise the handler receives the option values plus a `showHelp()` helper, and its result is returned.

#### Example — invocation-local input and output

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const values: string[] = [];
const parser = new CommandLineParser({ name: 'echo-cli', strict: true }).addCommand({
  name: 'echo',
  options: [{ name: 'message', short: 'm', type: 'string', required: true }],
  handler: async options => {
    values.push(String(options['message']));
  },
});

const rendered: string[] = [];

// A clean help request renders help and resolves without running the handler.
await parser.execute(undefined, {
  argv: ['echo', '--help'],
  write: line => rendered.push(line),
});

// A second, independent invocation runs the handler with its own arguments.
await parser.execute(undefined, {
  argv: ['echo', '--message', 'hello'],
  write: line => rendered.push(line),
});

console.log(rendered.length > 0); // true — help lines were captured through the writer.
console.log(values); // ['hello']
```

---

### addCommand()

```typescript
public addCommand(config: ICommand): CommandLineParser
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `config` | `ICommand` | Yes | — | Command definition; deep-copied (aliases, examples, options, nested subcommands) before validation and storage. |

**Returns**: `CommandLineParser` — the same parser instance, enabling fluent chaining.

Behavior:

- The command is cloned and validated against the parser's existing commands and global options; see the registration rules below.
- Unless `skipHelp: true`, an automatic boolean help option is appended to the command with long spelling `--help` and short spelling `-h`, plus a command-specific description. Because of this:
  - Options named `help` or `version` are rejected during registration.
  - A short option `h` is rejected on both command and global scope while automatic help is enabled.
- Per-invocation option storage for the command is initialized, and the command is appended to the registry in presentation order.

**Throws**: `InvalidConfigurationError`.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tool-cli', version: '1.0.0', strict: true });

parser
  .addCommand({
    name: 'build',
    description: 'Build the project',
    options: [{ name: 'output', short: 'o', type: 'string', default: 'dist' }],
    handler: async options => {
      console.log(`Building into ${String(options['output'])}`);
    },
  })
  .addCommand({
    name: 'clean',
    description: 'Remove build artifacts',
    handler: async () => {
      console.log('Cleaned');
    },
  });
```

#### Registration rules enforced by the constructor and addCommand()

| Rule | Applies to | Error |
|------|------------|-------|
| Name is required, must start with a letter, and may contain only letters, numbers, hyphens, and underscores | Commands, aliases, options | `InvalidConfigurationError` |
| `help` and `version` are reserved (case-insensitive) | Command names, aliases, option names | `InvalidConfigurationError` |
| Aliases may not duplicate their own command name or each other (normalized comparison) | Aliases | `InvalidConfigurationError` |
| Every canonical or alias spelling is owned by exactly one command (normalized comparison) | Commands, aliases | `InvalidConfigurationError` |
| Short option must be exactly one letter (`a`–`z`, `A`–`Z`); duplicate short spellings are rejected per scope | Options | `InvalidConfigurationError` |
| A short `h` is rejected while automatic help is enabled | Command and global options | `InvalidConfigurationError` |
| `choices` must be a non-empty array, and `default` must be one of `choices` | Options | `InvalidConfigurationError` |
| An option may not both conflict with and depend upon the same option | Options | `InvalidConfigurationError` |
| Global and command options may not share a long or short spelling | Global vs. command scope | `InvalidConfigurationError` |
| Duplicate long or short spellings within one scope are rejected (comparison is case-sensitive) | Options | `InvalidConfigurationError` |

---

### Strict Recognition Rules

The strict pipeline applies these rules before any handler runs:

- **Commands** — matched by exact, case-sensitive name or alias. An explicit command token always wins over the default; a `default: true` command is effective only when exactly one command is registered.
- **Option spellings** — `--name`, `--name=value`, `-s`, `-s=value`, `-svalue`, and `-s value` are all recognized. An explicit `=` always supplies a value — `--output=` is a supplied empty string, not a missing value.
- **Visibility** — global options are accepted before or after the explicit command token; command-local options are recognized only after the command token (or anywhere for an effective default command).
- **Negative numbers** — `-2` and `-2.5` are consumed as values only by registered `number` options; a bare `-` or `--` is a malformed argument.
- **Booleans** — a bare occurrence supplies `true`; a following `true` / `false` token is consumed when present; attached `true` / `false` text converts.
- **Numbers** — finite numeric text converts to `number`; any other text stays raw and fails validation with `InvalidOptionValueError`.
- **Repetition** — the last value wins unless the option declares `multiple: true`, in which case values accumulate into an order-preserving array.
- **No silent absorption** — unknown options consume nothing, and every leftover token becomes an ordered issue; strict mode never interprets values as JSON.

---

### Strict vs Legacy Behavior

| Aspect | Strict (`strict: true`) | Legacy (`strict: false`, default) |
|--------|-------------------------|-----------------------------------|
| Command lookup | Exact, case-sensitive | Case-normalized |
| Option lookup | Exact spellings | Case-normalized legacy lookup |
| Value interpretation | Type-driven conversion only | JSON-shaped values interpreted when possible |
| Unknown option / extra positional | Typed issues; handler never runs | Ignored; parsing continues |
| Invalid value / missing required | Rejection after validation | Rendered in help; resolves without running the handler |
| `--help` / `-h` with valid input | Clean help; resolves with `undefined` | Help; resolves with `undefined` |
| Failure outcome | Rejects with `CommandLineValidationError` (after the optional `errorHandler`); never renders built-in output when a hook is configured | Renders help; resolves |
| Suggestions | `Did you mean` hints under fixed work budgets | None |

---

### Protected Members

Protected members form the subclass-extension surface (used by the package's own test doubles). They are documented for completeness and are not part of the recommended consumer API.

#### Protected Properties

| Property | Type | Description |
|----------|------|-------------|
| `config` | `ICommandLineParser` | Cloned parser configuration owned by this instance. |
| `interpreter` | `string` | Interpreter path captured from `process.argv[0]` during construction. |
| `script` | `string` | Resolved application script path from `process.argv[1]`. |
| `scriptName` | `string` | Display name used in help: the configured name, or the script basename. |
| `commands` | `ICommand[]` | Registered commands in presentation order (cloned, with automatic help applied). |
| `optionValues` | `Record<string, Record<string, any>>` | Mutable option storage used only by the legacy compatibility parser path. |
| `currentCommand` | `ICommand \| undefined` | Command selected by the most recent legacy execution. |

#### Protected Methods

| Method | Signature | Returns | Description |
|--------|-----------|---------|-------------|
| `processQuotedArgument` | `processQuotedArgument(arg: string): string` | `string` | Removes matching surrounding quotes and unescapes `\<char>` sequences (legacy path). |
| `validateArgument` | `validateArgument(arg: string): void` | `void` | Throws `MalformedArgumentError` for empty arguments, bare `-` / `--`, and option-shaped tokens with invalid names (negative numbers excluded). |
| `parseTokens` | `parseTokens(args?: readonly string[]): IToken[]` | `IToken[]` | Legacy tokenizer; defaults to the process arguments after interpreter and script. |
| `prepare` | `prepare(): void` | `void` | Captures interpreter/script metadata used for help rendering. |
| `setOptionValue` | `setOptionValue(command: string, option: ICommandOption, value: any): void` | `void` | Stores one legacy value, accumulating arrays for `multiple` options. |
| `validate` | `validate(options: IToken[]): { errors: string[]; command?: ICommand }` | `{ errors, command? }` | Legacy semantic validation: required options, defaults, types, `choices`, validators, and relationships. |
| `help` | `help(command: ICommand \| undefined, errors: string[], isHelp: boolean, write?: (message: string) => void): void` | `void` | Renders top-level, error, or command help through the writer or the process console. |
| `resetOptionValues` | `resetOptionValues(): void` | `void` | Recreates per-command mutable storage so values never cross invocation boundaries. |
| `executeStrict` | `executeStrict(context?: unknown, invocation?: ICommandLineInvocation): Promise<unknown>` | `Promise<unknown>` | The strict pipeline invoked by `execute()` when `strict: true`. |

---

## Configuration Interfaces

### ICommandLineParser

Configuration passed to the `CommandLineParser` constructor. The object is deep-copied at construction; later mutation of the caller's object has no effect on parser behavior.

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Name of the application/script. Used as diagnostic context (for example, for a top-level unknown option) and as the help display name when the script basename is unavailable. Required. |
| `version` | `string` | Version displayed in the help heading. Defaults to `'1.0'`. |
| `strict` | `boolean` | Enables exact, case-sensitive, fail-closed recognition. Invalid input rejects with `CommandLineValidationError` and a handler is never invoked after a failure. Defaults to `false` for v5 compatibility. |
| `skipHelp` | `boolean` | Skips the automatic help option on every command and disables the reserved short `h` rule. With `skipHelp: true`, `--help` / `-h` are ordinary (unknown) options. Defaults to `false`. |
| `helpOption` | `{ name?: string; short?: string; description?: string }` | Custom help option configuration, copied defensively at construction. Automatic help registration currently uses the canonical `--help` / `-h` spellings. |
| `globalOptions` | `ICommandOption[]` | Options accepted before or after every explicit command. Values reach handlers under canonical long names. Global long and short spellings must not collide with command-local options. |
| `errorHandler` | `(error: CommandLineError) => void \| Promise<void>` | Replaces built-in invalid-input rendering in strict mode. The parser awaits this hook and then rejects with the same aggregate. If the hook fails, execution rejects with `CommandLineErrorHandlerError`, preserving both failures. |

### ICommandLineInvocation

Invocation-local command input and output overrides passed to `execute()`.

| Property | Type | Description |
|----------|------|-------------|
| `argv` | `readonly string[]` | Application arguments without interpreter and script entries. Defaults to `process.argv.slice(2)`. |
| `write` | `(message: string) => void` | Receives each rendered help line instead of writing to the process console. Defaults to `console.log`. |

---

## Command and Option Interfaces

### ICommand

```typescript
interface ICommand<TOptions extends OptionsDict = OptionsDict>
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Name of the command, for example `"build"`, `"test"`, or `"deploy"`. Exact in strict mode; case-normalized in legacy mode. Required. |
| `description` | `string` | Help description for the command. |
| `default` | `boolean` | Whether this is the default command when no command is specified. Effective only when exactly one command is registered. Defaults to `false`. |
| `options` | `ICommandOption[]` | Options configuration for this command. |
| `handler` | `CommandHandler<TOptions>` | Handler function invoked when the command is selected. Required. |
| `examples` | `string[]` | Examples of how to use this command. |
| `aliases` | `string[]` | Additional validated spellings that select this command's canonical handler state. Aliases are exact in strict mode and case-normalized in legacy mode. |
| `category` | `string` | Category/group for organizing commands in help. |
| `hidden` | `boolean` | Whether this command is hidden from help. Defaults to `false`. |
| `subcommands` | `ICommand[]` | Subcommands of this command. Nested definitions are cloned recursively; current parser execution reads only the top-level registry. |

```typescript
import { CommandLineParser, type ICommand } from 'blendsdk/cmdline';

const greet: ICommand = {
  name: 'greet',
  description: 'Greet someone by name',
  aliases: ['hello'],
  examples: ['greet --name Ada'],
  options: [{ name: 'name', short: 'n', type: 'string', required: true }],
  handler: async options => {
    console.log(`Hello, ${String(options['name'])}!`);
  },
};

const parser = new CommandLineParser({ name: 'greet-cli', strict: true });
parser.addCommand(greet);
await parser.execute(undefined, { argv: ['greet', '--name', 'Ada'] });
```

### ICommandOption

```typescript
interface ICommandOption<T extends OptionValueType = OptionValueType>
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Name of the option (used with `--`), for example `"verbose"` or `"output-file"`. Required. |
| `short` | `string` | Single-character short name (used with `-`), for example `"v"` or `"o"`. |
| `description` | `string` | Help description for the option. |
| `type` | `OptionTypeString` | Data type of the option value. Defaults to `"string"`. |
| `default` | `T` | Default value applied when the option is absent. Validated like a supplied value; a default also satisfies `required`. |
| `required` | `boolean` | Whether this option is required. Defaults to `false`. |
| `multiple` | `boolean` | Whether this option may accept multiple values, accumulated into an order-preserving array. Defaults to `false`. |
| `choices` | `T[]` | Non-empty list of valid values. A configured `default` must be one of them. |
| `validator` | `(value: T) => boolean \| string` | Custom validation function. Return `true` to accept; return `false` or a message string to reject. |
| `conflicts` | `string[]` | Canonical option names that cannot be explicitly supplied with this option. An explicit `false` counts as supplied; defaults alone do not activate a conflict. |
| `depends` | `string[]` | Canonical option names required when this option is explicitly supplied. A dependency is satisfied by an explicit value or a configured default, including `false`. |
| `hidden` | `boolean` | Whether this option is hidden from help. Defaults to `false`. Hidden options are also excluded from `Did you mean` suggestion candidates. |

Option type conversion:

| `type` | Converted value | Notes |
|--------|-----------------|-------|
| `'string'` | `string` | Default type when `type` is omitted. |
| `'number'` | `number` | Finite numeric text converts; other text remains raw and fails validation. Negative decimal tokens are consumable as values. |
| `'boolean'` | `boolean` | Bare occurrence → `true`; a following or attached `true` / `false` converts. |
| `'email'` | `string` | Validated with `isValidEmail`. |
| `'domain'` | `string` | Validated with `isValidDomain`. |

```typescript
import { CommandLineParser, type ICommandOption } from 'blendsdk/cmdline';

const output: ICommandOption<string> = {
  name: 'output',
  short: 'o',
  type: 'string',
  default: 'dist',
  description: 'Output directory',
};

const files: ICommandOption<string> = {
  name: 'file',
  type: 'string',
  multiple: true,
  description: 'Files to include (repeatable)',
};

const parser = new CommandLineParser({ name: 'build-cli', strict: true }).addCommand({
  name: 'build',
  options: [output, files],
  handler: async options => {
    console.log(String(options['output']), options['file']);
  },
});
```

### CommandHandler

```typescript
type CommandHandler<TOptions extends OptionsDict = OptionsDict> = (
  options: TOptions & { context?: unknown }
) => Promise<unknown> | unknown;
```

A handler may be synchronous or asynchronous; the parser awaits the result. The `options` object is a fresh merge of the validated canonical option values (keyed by option `name`) and the caller-supplied `context` value passed to `execute()`.

---

## Option Value Types

### OptionValueType, OptionValue, Dictionary, OptionsDict

| Type | Definition | Description |
|------|------------|-------------|
| `OptionValueType` | `string \| number \| boolean` | Supported option value types. |
| `OptionValue<T extends OptionValueType = OptionValueType>` | `T \| T[]` | Union type for option values that can be single values or arrays. |
| `Dictionary<T = unknown>` | `Record<string, T>` | Generic string-keyed dictionary with better type safety. |
| `OptionsDict` | `Dictionary<OptionValue>` | Canonical options dictionary passed to handlers. |

```typescript
import type { Dictionary, OptionsDict, OptionValue } from 'blendsdk/cmdline';

const timeout: OptionValue<number> = 30;
const retries: OptionValue<number> = [1, 2, 3];
const counters: Dictionary<number> = { successes: 2, failures: 0 };
const canonical: OptionsDict = { output: 'dist', retries: 3, enabled: true };

console.log(timeout, retries, counters, canonical);
```

### OptionTypeString, OptionTypeMap, TypeFromOptionType

| Type | Definition | Description |
|------|------------|-------------|
| `OptionTypeString` | `'string' \| 'number' \| 'boolean' \| 'email' \| 'domain'` | Declarable option type strings. |
| `OptionTypeMap` | `{ string: string; number: number; boolean: boolean; email: string; domain: string }` | Runtime type for each option type string. |
| `TypeFromOptionType<T extends OptionTypeString>` | `OptionTypeMap[T]` | Extracts the TypeScript type for one option type string. |

```typescript
import type { TypeFromOptionType } from 'blendsdk/cmdline';

const name: TypeFromOptionType<'string'> = 'release';
const retries: TypeFromOptionType<'number'> = 3;
const subscribed: TypeFromOptionType<'boolean'> = true;

console.log(name, retries, subscribed);
```

### InferOptionsType

```typescript
type InferOptionsType<T extends readonly ICommandOption[]> = {
  [K in T[number] as K['name']]: K['multiple'] extends true
    ? Array<TypeFromOptionType<K['type'] extends OptionTypeString ? K['type'] : 'string'>>
    : TypeFromOptionType<K['type'] extends OptionTypeString ? K['type'] : 'string'>;
};
```

Creates a strongly typed options object from an option array. `multiple: true` options map to arrays; options without a declared `type` map to `string`.

```typescript
import type { ICommandOption, InferOptionsType } from 'blendsdk/cmdline';

const deployOptions = [
  { name: 'output', type: 'string' },
  { name: 'retries', type: 'number' },
  { name: 'file', type: 'string', multiple: true },
  { name: 'enabled', type: 'boolean' },
] as const satisfies readonly ICommandOption[];

type DeployOptions = InferOptionsType<typeof deployOptions>;
// {
//   output: string;
//   retries: number;
//   file: string[];
//   enabled: boolean;
// }

const options: DeployOptions = {
  output: 'dist',
  retries: 3,
  file: ['app.js'],
  enabled: true,
};

console.log(options.output.toUpperCase());
```

### Reserved Name Constants

| Constant | Type | Value | Description |
|----------|------|-------|-------------|
| `RESERVED_OPTION_NAMES` | `readonly ['help', 'version']` | `['help', 'version']` | Option names that cannot be declared (case-insensitive check). |
| `RESERVED_COMMAND_NAMES` | `readonly ['help', 'version']` | `['help', 'version']` | Command and alias spellings that cannot be declared (case-insensitive check). |
| `ReservedOptionName` | `'help' \| 'version'` | — | Member type of `RESERVED_OPTION_NAMES`. |
| `ReservedCommandName` | `'help' \| 'version'` | — | Member type of `RESERVED_COMMAND_NAMES`. |

```typescript
import {
  RESERVED_COMMAND_NAMES,
  RESERVED_OPTION_NAMES,
  type ReservedCommandName,
} from 'blendsdk/cmdline';

const reservedCommand: ReservedCommandName = 'version';
console.log(RESERVED_COMMAND_NAMES, RESERVED_OPTION_NAMES, reservedCommand);
```

---

## Token and Result Interfaces

### IToken

Token interface for parsed command line arguments (legacy tokenizer output).

| Property | Type | Description |
|----------|------|-------------|
| `index` | `number` | Position index in the argument list. |
| `arg` | `string` | Raw argument string. |
| `isCommand` | `boolean` | Whether this token represents a command. |
| `isShortOption` | `boolean` | Whether this is a short option (for example `-v`). |
| `isLongOption` | `boolean` | Whether this is a long option (for example `--verbose`). |
| `isOption` | `boolean` | Whether this token is any type of option. |
| `isValue` | `boolean` | Whether this token is a value. |
| `value` | `OptionValueType` | Parsed value of the token. |

### IValidationResult

Result of token validation.

| Property | Type | Description |
|----------|------|-------------|
| `errors` | `string[]` | List of validation errors. |
| `command` | `ICommand` | The matched command, if any. |
| `options` | `OptionsDict` | Parsed options for the command. |

### IParsingContext

Declared parsing context for internal use.

| Property | Type | Description |
|----------|------|-------------|
| `args` | `string[]` | Raw command line arguments. |
| `position` | `number` | Current parsing position. |
| `tokens` | `IToken[]` | Parsed tokens. |
| `currentCommand` | `ICommand` | Current command being processed. |
| `options` | `OptionsDict` | Accumulated options. |

### IHelpOptions

Declared help formatting options.

| Property | Type | Description |
|----------|------|-------------|
| `maxWidth` | `number` | Maximum width for help output. |
| `colors` | `boolean` | Whether to use colors in help output. |
| `template` | `string` | Custom help template. |
| `showExamples` | `boolean` | Show examples in help. |
| `showAliases` | `boolean` | Show aliases in help. |

---

## Errors

Every parser-owned failure is an instance of `CommandLineError`, carrying a stable `code`, a coarse `category`, and an optional structured `context`. In strict mode, failures are collected as specific issues and reject through a single `CommandLineValidationError` aggregate; in legacy mode the messages are rendered in the built-in help output and execution resolves. Handler exceptions are never wrapped — they propagate to the caller unchanged. The parser itself never terminates the process; set `process.exitCode` inside your own catch block if the application should exit non-zero.

### ErrorCategory

| Member | Value | Description |
|--------|-------|-------------|
| `PARSING` | `'PARSING'` | Token recognition and structural input failures. |
| `VALIDATION` | `'VALIDATION'` | Semantic failures: values, required options, relationships, strict aggregates. |
| `CONFIGURATION` | `'CONFIGURATION'` | Registration-time configuration failures. |

### ErrorCode

| Member | Value | Description |
|--------|-------|-------------|
| `VALIDATION_FAILED` | `'VALIDATION_FAILED'` | One strict invocation produced one or more specific parser issues. |
| `UNEXPECTED_ARGUMENT` | `'UNEXPECTED_ARGUMENT'` | A plain argument remained after supported tokens were consumed. |
| `MISSING_OPTION_DEPENDENCY` | `'MISSING_OPTION_DEPENDENCY'` | An explicitly supplied option lacked a declared dependency. |
| `ERROR_HANDLER_FAILED` | `'ERROR_HANDLER_FAILED'` | A custom error-presentation hook threw or rejected. |
| `MISSING_REQUIRED_OPTION` | `'MISSING_REQUIRED_OPTION'` | A required option was absent. |
| `INVALID_OPTION_VALUE` | `'INVALID_OPTION_VALUE'` | A supplied or default value failed type, choices, or validator validation. |
| `NO_COMMAND_PROVIDED` | `'NO_COMMAND_PROVIDED'` | No command was provided and no default exists. |
| `UNKNOWN_COMMAND` | `'UNKNOWN_COMMAND'` | An unrecognized command spelling was provided. |
| `UNKNOWN_OPTION` | `'UNKNOWN_OPTION'` | An unrecognized option spelling was provided. |
| `CONFLICTING_OPTIONS` | `'CONFLICTING_OPTIONS'` | Mutually exclusive options were supplied together. |
| `MALFORMED_ARGUMENT` | `'MALFORMED_ARGUMENT'` | An argument was malformed. |
| `CIRCULAR_DEPENDENCY` | `'CIRCULAR_DEPENDENCY'` | A circular dependency chain was detected. |
| `INVALID_CONFIGURATION` | `'INVALID_CONFIGURATION'` | Command or option configuration was invalid. |

### CommandLineError (abstract)

```typescript
export abstract class CommandLineError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly context?: Record<string, unknown>;

  public constructor(
    message: string,
    category: ErrorCategory,
    code: string,
    context?: Record<string, unknown>
  );
}
```

| Property | Type | Description |
|----------|------|-------------|
| `code` | `string` | Stable programmatic error code (see `ErrorCode`). |
| `category` | `ErrorCategory` | Coarse failure grouping. |
| `context` | `Record<string, unknown>` | Optional structured details; contents differ per subclass. |
| `name` | `string` | Set to the concrete constructor name (for example `'UnknownOptionError'`). |
| `message` | `string` | Human-readable message; see each subclass for its pattern. |
| `stack` | `string \| undefined` | Captured via `Error.captureStackTrace` against the concrete class. |

### Error Summary

| Class | `ErrorCode` | `ErrorCategory` | Message pattern |
|-------|-------------|-----------------|-----------------|
| `CommandLineValidationError` | `VALIDATION_FAILED` | `VALIDATION` | `Command-line validation failed:` followed by every issue message on its own `- ` line |
| `CommandLineErrorHandlerError` | `ERROR_HANDLER_FAILED` | `VALIDATION` | `Command-line error handler failed while presenting a parser error` |
| `UnexpectedArgumentError` | `UNEXPECTED_ARGUMENT` | `PARSING` | `Unexpected argument [<argument>]` (` for command [<commandName>]` when known) |
| `UnknownCommandError` | `UNKNOWN_COMMAND` | `PARSING` | `Unknown command [<commandName>]. Available commands: <list> Did you mean [<suggestedCommand>]?` (optional parts omitted when unavailable) |
| `UnknownOptionError` | `UNKNOWN_OPTION` | `PARSING` | `Unknown option [<optionName>] for command [<commandName>]. Did you mean [--<suggestedOption>]?` (suggestion optional) |
| `MalformedArgumentError` | `MALFORMED_ARGUMENT` | `PARSING` | `Malformed argument [<argument>]: <reason>` |
| `MissingRequiredOptionError` | `MISSING_REQUIRED_OPTION` | `VALIDATION` | `Missing required option [<optionName>] for command [<commandName>]` |
| `InvalidOptionValueError` | `INVALID_OPTION_VALUE` | `VALIDATION` | `Invalid value provided for option [<optionName>], required <expectedType>, provided [<providedValue>]` |
| `ConflictingOptionsError` | `CONFLICTING_OPTIONS` | `VALIDATION` | `Conflicting options provided: <a, b>` |
| `MissingOptionDependencyError` | `MISSING_OPTION_DEPENDENCY` | `VALIDATION` | `Option [<optionName>] requires option [<dependencyName>] for command [<commandName>]` |
| `NoCommandProvidedError` | `NO_COMMAND_PROVIDED` | `PARSING` | `No command provided and no default command available` |
| `CircularDependencyError` | `CIRCULAR_DEPENDENCY` | `CONFIGURATION` | `Circular dependency detected: <a -> b -> a>` |
| `InvalidConfigurationError` | `INVALID_CONFIGURATION` | `CONFIGURATION` | `Invalid configuration for [<configurationItem>]: <reason>` |

---

### CommandLineValidationError

```typescript
public constructor(issues: readonly CommandLineError[])
```

Aggregates every parser-owned issue discovered during one strict invocation. The collection is copied and frozen so later rendering or error hooks cannot change the rejection observed by the consuming application.

| Property | Type | Description |
|----------|------|-------------|
| `issues` | `readonly CommandLineError[]` | Frozen, ordered specific parser issues: token problems in original argument order first, then registered-option validation issues in declaration order. |

- `context` carries `{ issueCount }`.
- **Throws `TypeError`** when constructed with an empty issues array — an aggregate always contains at least one specific issue.
- Emitted when strict execution collects one or more issues; the optional `errorHandler` receives this exact aggregate before it is thrown.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  UnknownOptionError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true }).addCommand({
  name: 'deploy',
  options: [{ name: 'preserve-status', type: 'boolean' }],
  handler: () => undefined,
});

const rendered: string[] = [];
try {
  await parser.execute(undefined, {
    argv: ['deploy', '--preserve-stauts'],
    write: line => rendered.push(line),
  });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    for (const issue of error.issues) {
      console.error(issue.code, issue.message);
      // UNKNOWN_OPTION Unknown option [preserve-stauts] for command [deploy]. Did you mean [--preserve-status]?
    }
    if (error.issues.some(issue => issue instanceof UnknownOptionError)) {
      process.exitCode = 1;
    }
  } else {
    throw error;
  }
}
```

### CommandLineErrorHandlerError

```typescript
public constructor(parserError: CommandLineError, handlerError: unknown)
```

Preserves both a parser failure and a failed custom error-presentation hook.

| Property | Type | Description |
|----------|------|-------------|
| `parserError` | `CommandLineError` | Original parser-owned failure that blocked command execution. |
| `handlerError` | `unknown` | Value thrown or rejected by the custom error handler. |

- `context` carries `{ parserErrorCode: parserError.code }`.
- Emitted when the configured `errorHandler` throws or rejects while presenting an aggregate.

### UnexpectedArgumentError

```typescript
public constructor(argument: string, commandName?: string)
```

| Property | Type | Description |
|----------|------|-------------|
| `argument` | `string` | Original unconsumed argument text. |
| `commandName` | `string` | Canonical command whose input contained the argument, when available. |

- `context` carries `{ argument, commandName }`.
- Emitted for a plain argument that remains after supported tokens were consumed.

### UnknownCommandError

```typescript
public constructor(commandName: string, availableCommands: string[] = [], suggestedCommand?: string)
```

| Property | Type | Description |
|----------|------|-------------|
| `commandName` | `string` | Unrecognized command spelling as supplied. |
| `availableCommands` | `string[]` | Registered command spellings reported in the message; empty when none exist. |

- `context` carries `{ commandName, availableCommands, suggestedCommand }`.
- A `Did you mean` hint appears only for a uniquely closest registered spelling under the suggestion budgets; a hint never changes the rejection.

### UnknownOptionError

```typescript
public constructor(optionName: string, commandName: string, suggestedOption?: string)
```

| Property | Type | Description |
|----------|------|-------------|
| `optionName` | `string` | Parsed option name without its leading dash characters. |
| `commandName` | `string` | Canonical command (or the parser name when no command applies) providing diagnostic context. |

- `context` carries `{ optionName, commandName, suggestedOption }`.
- `suggestedOption` is a long option name; the message formats it with a `--` prefix.

### MalformedArgumentError

```typescript
public constructor(argument: string, reason: string)
```

| Property | Type | Description |
|----------|------|-------------|
| `argument` | `string` | Original argument text supplied by the caller. |
| `reason` | `string` | Durable explanation for the malformed input. |

- `context` carries `{ argument, reason }`.
- Typical reasons: `Invalid option format` (bare `-` / `--`), `Invalid option name format`, `Empty argument provided` (legacy), and `Option [<name>] requires a value` (a recognized non-boolean option without a value).

### MissingRequiredOptionError

```typescript
public constructor(optionName: string, commandName: string)
```

| Property | Type | Description |
|----------|------|-------------|
| `optionName` | `string` | Required option that was not supplied. |
| `commandName` | `string` | Canonical command that declares the option. |

- `context` carries `{ optionName, commandName }`.
- A configured `default` satisfies the requirement; the error is emitted only when no value and no default exist.

### InvalidOptionValueError

```typescript
public constructor(optionName: string, expectedType: string, providedValue: unknown)
```

| Property | Type | Description |
|----------|------|-------------|
| `optionName` | `string` | Option whose value failed validation. |
| `expectedType` | `string` | Human-readable expectation: a type name (`string`, `number`, `boolean`, `email string`, `domain string`), an explicit email/domain failure reason, a choices list such as `one of [json], [yaml]`, a custom validator message, or `a value accepted by its validator`. |
| `providedValue` | `unknown` | Value that failed validation. |

- `context` carries `{ optionName, expectedType, providedValue }`.
- `choices` validation runs before a custom `validator`; a value that fails `choices` is reported once and the validator is not called for it.

### ConflictingOptionsError

```typescript
public constructor(conflictingOptions: string[])
```

| Property | Type | Description |
|----------|------|-------------|
| `conflictingOptions` | `string[]` | The two canonical option names in the conflicting pair. |

- `context` carries `{ conflictingOptions }`.
- Emitted once per conflicting pair, deduplicated (reciprocal declarations produce one error), in owner registration then declaration order. Explicit `false` counts as supplied; defaults alone do not activate a conflict.

### MissingOptionDependencyError

```typescript
public constructor(optionName: string, dependencyName: string, commandName: string)
```

| Property | Type | Description |
|----------|------|-------------|
| `optionName` | `string` | Explicitly supplied option that declares the dependency. |
| `dependencyName` | `string` | Required companion option that was absent. |
| `commandName` | `string` | Canonical command that owns both options. |

- `context` carries `{ optionName, dependencyName, commandName }`.
- A dependency is satisfied by an explicitly supplied value or a configured default, including `false`.

### NoCommandProvidedError

```typescript
public constructor()
```

- Message: `No command provided and no default command available`. No `context`.
- Exported for programmatic use; the built-in parser paths report a missing command by rendering help instead (strict mode resolves with top-level help; legacy mode renders and resolves).

### CircularDependencyError

```typescript
public constructor(dependencyChain: string[])
```

| Property | Type | Description |
|----------|------|-------------|
| `dependencyChain` | `string[]` | The detected dependency cycle, rendered as `a -> b -> a`. |

- `context` carries `{ dependencyChain }`.
- Exported for programmatic use; the current built-in parser paths do not throw this error.

### InvalidConfigurationError

```typescript
public constructor(configurationItem: string, reason: string)
```

| Property | Type | Description |
|----------|------|-------------|
| `configurationItem` | `string` | Dotted path of the offending configuration item, for example `command.name` or `deploy.options.output.short`. |
| `reason` | `string` | Explanation of the violated rule. |

- `context` carries `{ configurationItem, reason }`.
- Thrown by the `CommandLineParser` constructor and `addCommand()` — bad configuration never reaches parsing.

### isCommandLineError

```typescript
export function isCommandLineError(error: unknown): error is CommandLineError
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `error` | `unknown` | Yes | Value to test. |

**Returns**: `boolean` — `true` when the value is an instance of `CommandLineError`.

```typescript
import { CommandLineParser, isCommandLineError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tool-cli', strict: true }).addCommand({
  name: 'show',
  handler: () => undefined,
});

try {
  await parser.execute(undefined, { argv: ['show', '--bogus'], write: () => undefined });
} catch (error) {
  if (isCommandLineError(error)) {
    console.error(error.code, error.category); // VALIDATION_FAILED VALIDATION
  } else {
    throw error;
  }
}
```

---

## Validators

`isValidEmail` and `isValidDomain` back the `email` and `domain` option types; `getEmailValidationError` and `getDomainValidationError` produce the human-readable explanations the parser embeds in validation failures. All four helpers are exported so applications can reuse the same rules outside the parser.

### isValidEmail

```typescript
export function isValidEmail(value: string): boolean
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `value` | `string` | Yes | Email address to validate. |

**Returns**: `boolean` — `true` when the value is a practical, RFC 5322-inspired email address.

Rules applied:

- Exactly one `@` separating a local part and a domain part.
- Local part: at most 64 characters; must not start or end with a dot.
- Domain part: at most 253 characters; validated by `isValidDomain`.
- The domain must contain at least one dot (single-label domains such as `localhost` are not valid emails) and the TLD must be at least 2 characters.
- No consecutive dots anywhere in the address.
- Non-string input defensively returns `false`.

```typescript
import { isValidEmail } from 'blendsdk/cmdline';

const accepted: boolean = isValidEmail('user.name+tag@example.com'); // true
const rejected: boolean = isValidEmail('test@localhost'); // false — single-label domain
const consecutive: boolean = isValidEmail('test..test@example.com'); // false

console.log(accepted, rejected, consecutive);
```

### isValidDomain

```typescript
export function isValidDomain(value: string): boolean
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `value` | `string` | Yes | Domain name (including subdomains) to validate. |

**Returns**: `boolean` — `true` when the value is a valid domain name.

Rules applied:

- Input is trimmed; empty or longer than 253 characters is rejected.
- The domain must not start or end with a dot or a hyphen.
- Labels are 1–63 characters and must not start or end with a hyphen.
- Non-TLD labels allow letters, numbers, hyphens, and underscores.
- Single-label domains (for example `localhost`) allow letters, numbers, hyphens, and underscores.
- Multi-label TLDs must be alphanumeric and contain at least one letter.
- Non-string input defensively returns `false`.

```typescript
import { isValidDomain } from 'blendsdk/cmdline';

const accepted: boolean = isValidDomain('deep.sub.example.com'); // true
const localhost: boolean = isValidDomain('localhost'); // true — single-label domain
const malformed: boolean = isValidDomain('example..com'); // false — empty label

console.log(accepted, localhost, malformed);
```

### getEmailValidationError

```typescript
export function getEmailValidationError(value: string): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `value` | `string` | Yes | Email value that failed validation. |

**Returns**: `string` — the first applicable human-readable reason, checked in this order:

| Condition | Message |
|-----------|---------|
| Not a string | `Email must be a string` |
| Empty | `Email cannot be empty` |
| No `@` | `Email must contain @ symbol` |
| More than one `@` | `Email must contain exactly one @ symbol` |
| Missing local part | `Email must have a local part before @` |
| Local part longer than 64 characters | `Email local part cannot exceed 64 characters` |
| Missing domain part | `Email must have a domain part after @` |
| Domain part longer than 253 characters | `Email domain part cannot exceed 253 characters` |
| Contains consecutive dots | `Email cannot contain consecutive dots` |
| Local part starts or ends with a dot | `Email local part cannot start or end with a dot` |
| Any other failure | `Invalid email format` |

```typescript
import { getEmailValidationError, isValidEmail } from 'blendsdk/cmdline';

const candidate = 'test..test@example.com';
if (!isValidEmail(candidate)) {
  console.error(getEmailValidationError(candidate)); // Email cannot contain consecutive dots
}
```

### getDomainValidationError

```typescript
export function getDomainValidationError(value: string): string
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `value` | `string` | Yes | Domain value that failed validation. |

**Returns**: `string` — the first applicable human-readable reason, checked in this order:

| Condition | Message |
|-----------|---------|
| Not a string | `Domain must be a string` |
| Empty after trimming | `Domain cannot be empty` |
| Longer than 253 characters | `Domain cannot exceed 253 characters` |
| Starts or ends with a dot | `Domain cannot start or end with a dot` |
| Starts or ends with a hyphen | `Domain cannot start or end with a hyphen` |
| Empty label | `Domain labels cannot be empty` |
| Label longer than 63 characters | `Domain label "<label>" cannot exceed 63 characters` |
| Label starts or ends with a hyphen | `Domain label "<label>" cannot start or end with a hyphen` |
| Label contains invalid characters | `Domain label "<label>" contains invalid characters (only letters, numbers, and hyphens allowed)` |
| TLD without a letter | `Top-level domain must contain at least one letter` |
| Any other failure | `Invalid domain format` |

```typescript
import { getDomainValidationError, isValidDomain } from 'blendsdk/cmdline';

const candidate = 'example..com';
if (!isValidDomain(candidate)) {
  console.error(getDomainValidationError(candidate)); // Domain labels cannot be empty
}
```

---

## Internal Modules (Not Exported)

The following modules exist inside the package but are not exported from the package root. They are listed only to clarify the boundary — never import them directly and never rely on their shapes.

| Module | Responsibility |
|--------|----------------|
| `argument-parser` | Pure registry construction and argument recognition (no process or handler side effects). |
| `configuration` | Defensive cloning and registration-time validation of parser, command, and option configuration. |
| `help-renderer` | Plain-text help rendering shared by strict and legacy outcomes. |
| `strict-diagnostics` | Conversion of ordered token issues into typed errors with bounded similarity hints. |
| `strict-validation` | Registered-option validation: defaults, required, types, choices, validators, and relationships. |
| `suggestions` | Deterministic, budgeted Damerau–Levenshtein suggestion matching. |

If a symbol is not documented on this page, it is not part of the public API — everything consumable is reachable through `import { ... } from 'blendsdk/cmdline'`.

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
