> **Package**: `blendsdk/cmdline`

# cmdline Advanced Patterns

---

## How to Use This Document

The basic usage of `blendsdk/cmdline` — declaring commands, adding options, and calling `execute()` — is covered in the introductory pages. This document is about what happens when a CLI grows: failure contracts that must not swallow bad input, invocation reuse from tests and embedding tools, cross-cutting flags, declarative cross-option rules, layered validation, multi-file command catalogs, machine-readable diagnostics, and an incremental migration from the compatibility parser to strict parsing.

Every example is a complete ESM module with all imports, strict-mode TypeScript, and realistic output. The patterns compose: a production-grade CLI typically applies Pattern 1 (entry point), Pattern 6 (command modules), and Pattern 7 (diagnostics) together.

| # | Pattern | Combines |
| --- | --- | --- |
| 1 | Fail-Closed Entry Point with Caller-Owned Exit Policy | `strict: true`, aggregated rejection, `errorHandler`, exit policy |
| 2 | Invocation-Local Embedding and Output Capture | `{ argv, write }`, `context`, parser reuse, in-process tests |
| 3 | Cross-Cutting Flags with Global Options | `globalOptions`, aliases, scope enforcement, canonical names |
| 4 | Declarative Option Relationships | `conflicts`, `depends`, explicit-occurrence semantics |
| 5 | Layered Value Validation | `email`/`domain`/`number` types, `choices`, `validator`, defaults |
| 6 | Composable Command Catalogs | `ICommand` modules, fluent registration, defensive cloning |
| 7 | Machine-Readable Diagnostics | `ErrorCode`, `ErrorCategory`, structured issue fields |
| 8 | Migrating One CLI from Legacy to Strict Mode | behavior matrix, before/after diff, migration checklist |

---

## Pattern 1 — Fail-Closed Entry Point with Caller-Owned Exit Policy

**When to use it** — on every production CLI that must never run its command handler after invalid input. The application entry point is the single place that decides how failures are presented and how the process signals them; everything below it (`strict: true`, aggregate errors, the optional `errorHandler` hook) exists to feed that one decision.

```typescript
import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'release-cli',
  version: '1.0.0',
  strict: true,
  errorHandler: error => {
    if (error instanceof CommandLineValidationError) {
      for (const issue of error.issues) {
        console.error(issue.message);
      }
      return;
    }
    console.error(error.message);
  },
});

parser.addCommand({
  name: 'deploy',
  description: 'Deploy an artifact to an environment',
  options: [
    { name: 'artifact', type: 'string', required: true },
    {
      name: 'environment',
      short: 'e',
      type: 'string',
      required: true,
      choices: ['staging', 'production'],
    },
  ],
  handler: async options => {
    console.log(`Deploying ${String(options['artifact'])} to ${String(options['environment'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineErrorHandlerError) {
    console.error('The error handler failed while presenting the failure:', error.handlerError);
    process.exitCode = 1;
  } else if (error instanceof CommandLineValidationError) {
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

```bash
# node release-cli.js deploy --artifact=app.zip --enviroment=production
#   → Unknown option [enviroment] for command [deploy]. Did you mean [--environment]?
#   → Missing required option [environment] for command [deploy]
#   → rejects with CommandLineValidationError; the catch sets process.exitCode = 1
#
# node release-cli.js deploy --artifact=app.zip --environment=production
#   → Deploying app.zip to production
#
# node release-cli.js deploy --help
#   → clean help: command help renders and execute() resolves without running the handler
```

**Why this pattern is valuable** — it concentrates the entire failure contract in one screen of code. The parser collects every problem of an invocation into one frozen, ordered `CommandLineValidationError.issues` array (token issues in input order first, then validation issues in declaration order), the hook presents it once, and the rejection is typed. Because the library never terminates the process, the exit policy stays visible and testable at the call site: set `process.exitCode` and let buffered output flush naturally.

**Outcomes of `execute()` in strict mode**

| Outcome | When | Result |
| --- | --- | --- |
| Resolve with the handler's return value | Valid input, command selected | `command.handler(options & { context })` ran |
| Resolve with `undefined` | Clean help (`--help` alone) or no command and no default | Help rendered, handler never ran |
| Reject with `CommandLineValidationError` | Any token or validation issue | Aggregate; handler never ran |
| Reject with `CommandLineErrorHandlerError` | A configured `errorHandler` threw or rejected | Both `parserError` and `handlerError` preserved |
| Reject with anything else | Your command handler threw | Application failure, propagated unchanged |

**Caveats and considerations**

- Setting `errorHandler` *replaces* the built-in invalid-input rendering entirely — you own all failure presentation. Without a hook, the parser prints every issue (including any `Did you mean` hint) plus the relevant command help, and then still rejects.
- Help never masks invalid input: `--help` beside a misspelled option or an invalid value is not a "clean help" request — the invocation rejects.
- `CommandLineValidationError.issues` is a copied, frozen array; it is safe to store, re-render, or serialize later.
- Similarity hints are computed under fixed internal budgets (lookup, candidate, and comparison limits), and a hint appears only when a single closest candidate is provably within the distance threshold — typo handling cannot blow up on adversarial input.
- Application errors from your handler propagate with their original identity; the `throw error` branch above keeps their stack traces intact.

---

## Pattern 2 — Invocation-Local Embedding and Output Capture

**When to use it** — when the same CLI definition must serve three masters: a real terminal, an integration-test suite that must not spawn child processes, and another tool that calls the commands in-process (for example a BlendSDK monorepo task runner). `execute(context, { argv, write })` supplies the arguments, the output boundary, and a caller-owned context for each invocation.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

interface CliContext {
  readonly workspace: string;
  readonly output: (line: string) => void;
}

function isCliContext(value: unknown): value is CliContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('workspace' in value) || !('output' in value)) {
    return false;
  }
  return typeof value.workspace === 'string' && typeof value.output === 'function';
}

const parser = new CommandLineParser({ name: 'workspace-cli', version: '2.0.0', strict: true });

parser.addCommand({
  name: 'summary',
  description: 'Print a summary of the current workspace',
  options: [{ name: 'format', type: 'string', choices: ['text', 'json'], default: 'text' }],
  handler: options => {
    const context = options.context;
    if (!isCliContext(context)) {
      throw new Error('The summary command requires a workspace context');
    }
    const format = typeof options['format'] === 'string' ? options['format'] : 'text';
    if (format === 'json') {
      context.output(JSON.stringify({ workspace: context.workspace }));
      return;
    }
    context.output(`workspace: ${context.workspace}`);
  },
});

interface RunResult {
  readonly stdout: readonly string[];
  readonly problems: readonly string[];
}

async function run(workspace: string, argv: readonly string[]): Promise<RunResult> {
  const stdout: string[] = [];
  const context: CliContext = { workspace, output: line => stdout.push(line) };
  try {
    await parser.execute(context, { argv, write: line => stdout.push(line) });
    return { stdout, problems: [] };
  } catch (error) {
    if (error instanceof CommandLineValidationError) {
      return { stdout, problems: error.issues.map(issue => issue.message) };
    }
    throw error;
  }
}

const succeeded = await run('core', ['summary', '--format=json']);
const rejected = await run('cmdline', ['summary', '--frmat=json']);
const help = await run('cmdline', ['summary', '--help']);

console.log(succeeded.stdout.join('\n')); // {"workspace":"core"}
console.log(rejected.problems.join('\n')); // Unknown option [frmat] for command [summary]. Did you mean [--format]?
console.log(help.stdout.length); // captured command help lines; console output untouched
```

**Why this pattern is valuable** — one parser definition becomes the single source of truth for terminal use and for every embedding. Invocation state is rebuilt per call — defaults are re-applied, `multiple` arrays start empty, and a previous success can never satisfy a later required-option check. Tests exercise the real command definitions (`run('core', [...])`), not a parallel mock CLI, and the `write` boundary captures help rendering so a clean help request is assertable as data.

**Caveats and considerations**

- Reusing one instance sequentially is fully supported. For concurrent executions (one per workspace in parallel), construct a separate parser per task — the instance keeps invocation bookkeeping such as the current command and, in legacy mode, per-command value storage.
- `write` captures help rendering only. Route your own command output through the context (as shown) or through `console.log`; do not expect the parser to intercept handler output.
- `process.argv` is read only when `argv` is omitted, and it is never mutated — tests can pass explicit argument lists side by side with unrelated process arguments.
- Context is opaque to the parser: it is forwarded untouched, so the same command module works with a terminal context, a test context, or an embedding tool's context. Validate it in the handler (as shown) and fail fast when it is missing.

---

## Pattern 3 — Cross-Cutting Flags with Global Options

**When to use it** — when several commands share flags: credential profiles, verbosity, output format, or dry-run switches. Declaring them once as `globalOptions` removes the copy-paste and gives the parser enough information to reject ambiguous configurations at startup.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'release-cli',
  version: '1.0.0',
  strict: true,
  globalOptions: [
    {
      name: 'profile',
      short: 'p',
      type: 'string',
      default: 'default',
      description: 'Named credential profile',
    },
    {
      name: 'verbose',
      short: 'v',
      type: 'boolean',
      description: 'Log every executed step',
    },
  ],
});

parser.addCommand({
  name: 'deploy',
  aliases: ['ship'],
  description: 'Deploy an artifact to an environment',
  options: [
    { name: 'artifact', type: 'string', required: true },
    {
      name: 'environment',
      short: 'e',
      type: 'string',
      choices: ['staging', 'production'],
      default: 'staging',
    },
  ],
  handler: async options => {
    if (options['verbose'] === true) {
      console.log(`[verbose] using profile ${String(options['profile'])}`);
    }
    console.log(`Deploying ${String(options['artifact'])} to ${String(options['environment'])}`);
  },
});

parser.addCommand({
  name: 'rollback',
  description: 'Roll back the most recent deployment',
  options: [{ name: 'revision', short: 'r', type: 'number', required: true }],
  handler: async options => {
    if (options['verbose'] === true) {
      console.log(`[verbose] using profile ${String(options['profile'])}`);
    }
    console.log(`Rolling back to revision ${String(options['revision'])}`);
  },
});

await parser.execute();
```

```bash
# A global option before the command
# node release-cli.js --profile=production deploy --artifact=app.zip --environment=production
#   → Deploying app.zip to production
#
# The same global option after the command, in short form with a separate value
# node release-cli.js deploy --artifact=app.zip -p production --verbose
#   → [verbose] using profile production
#   → Deploying app.zip to staging
#
# An alias selects the same canonical handler with the same globals
# node release-cli.js ship -p staging --artifact=app.zip
#   → Deploying app.zip to staging
```

**Why this pattern is valuable** — cross-cutting concerns are declared once and reach every handler under canonical long names, regardless of whether the user wrote `--profile=production`, `-p production`, or placed it before the command. Both orders and both commands above produce identical handler values; the only difference is where the token appeared. Registration-time enforcement means the flags can never silently shadow a command-local option.

**Caveats and considerations**

- Command-local options are recognized only *after* an explicit command token in strict mode. `node release-cli.js --artifact=app.zip deploy` fails closed with an unknown-option issue, and its "Did you mean" scope considers only visible global long options — matching exactly what strict recognition would have accepted at that position.
- A command option that reuses a global long or short spelling (`--profile` or `-p` on `deploy`) throws `InvalidConfigurationError` at `addCommand()` time. Ambiguity is a startup failure, not a runtime surprise.
- Global options participate in validation for every invocation: `required` is enforced and `default` is applied (hence `profile: 'default'` above even when the user never mentions it).
- Aliases follow the same lookup rule as command names: exact in strict mode, case-normalized in legacy mode.

---

## Pattern 4 — Declarative Option Relationships: `conflicts` and `depends`

**When to use it** — when options have cross-option invariants: "upload needs a token", "force-refresh conflicts with offline mode", "quiet and verbose are mutually exclusive". Declaring the relationship on the option keeps the rule next to the definition and removes imperative checks from every handler.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'sync-cli',
  version: '1.0.0',
  strict: true,
  errorHandler: error => {
    if (error instanceof CommandLineValidationError) {
      for (const issue of error.issues) {
        console.error(issue.message);
      }
    }
  },
});

parser.addCommand({
  name: 'sync',
  description: 'Synchronize the local cache with a remote store',
  options: [
    { name: 'source', type: 'string', required: true },
    { name: 'cache', type: 'boolean', depends: ['store'], description: 'Enable the local cache' },
    { name: 'store', type: 'string', choices: ['memory', 'redis'] },
    { name: 'refresh', type: 'boolean', conflicts: ['offline'], description: 'Force a full refresh' },
    { name: 'offline', type: 'boolean', default: false },
  ],
  handler: async options => {
    const cache = options['cache'] === true;
    const offline = options['offline'] === true;
    console.log(`Synchronizing ${String(options['source'])} (cache: ${cache}, offline: ${offline})`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

```bash
# Runs — relationships stay inactive because only a default supplies offline
# node sync-cli.js sync --source=origin
#   → Synchronizing origin (cache: false, offline: false)
#
# Rejected — cache is explicitly supplied and its dependency store is absent
# node sync-cli.js sync --source=origin --cache
#   → Option [cache] requires option [store] for command [sync]
#
# Rejected — refresh conflicts with offline, even when offline is explicitly false
# node sync-cli.js sync --source=origin --refresh --offline=false
#   → Conflicting options provided: refresh, offline
#
# Runs — both constraints satisfied
# node sync-cli.js sync --source=origin --cache --store=redis --refresh
#   → Synchronizing origin (cache: true, offline: false)
```

**Why this pattern is valuable** — the constraints are enforced on *explicit occurrences*, which is the semantics users expect: a configured default never "activates" a conflict or dependency (the first invocation above runs despite `offline: false` being in effect), while an explicitly supplied `false` counts as present (third invocation). Diagnostics are deduplicated — reciprocal declarations produce a single conflict pair, repeated occurrences do not multiply errors — and are ordered by option registration, then declaration order inside each list, so tests and users see stable output.

**Caveats and considerations**

- A dependency is satisfied by an explicit value *or* a configured default (including `false`); the missing-dependency error carries `optionName`, `dependencyName`, and `commandName` for programmatic handling.
- An option cannot both conflict with and depend on the same name — that is an `InvalidConfigurationError` at registration.
- The same definitions behave differently per mode by design: under strict, relationship violations reject with typed issues and block the handler; under legacy, they render help with the messages and resolve. Legacy mode remains the v5 default, so test both if you ship both.
- Keep relationship lists to canonical option names only; spellings like `-o` are not accepted in `conflicts` / `depends`.

---

## Pattern 5 — Layered Value Validation: Types, Choices, and Custom Validators

**When to use it** — when a value's validity is not captured by a single built-in type: numeric ranges, non-blank strings, emails validated under a custom policy. Each value is checked in a fixed layer order — runtime type, then `choices`, then the custom `validator` — and the first failure for a value produces exactly one typed issue, while all other values and options are still validated so the user sees the full picture at once.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  getEmailValidationError,
  isValidEmail,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'notify-cli',
  version: '1.0.0',
  strict: true,
  errorHandler: error => {
    if (error instanceof CommandLineValidationError) {
      for (const issue of error.issues) {
        console.error(issue.message);
      }
    }
  },
});

parser.addCommand({
  name: 'send',
  description: 'Send a release notification',
  options: [
    { name: 'to', type: 'email', required: true, multiple: true },
    { name: 'subject', type: 'string', required: true },
    { name: 'channel', type: 'string', choices: ['email', 'webhook'], default: 'email' },
    {
      name: 'retries',
      type: 'number',
      default: 0,
      validator: value =>
        (typeof value === 'number' && Number.isInteger(value) && value >= 0) ||
        'Retries must be a non-negative integer',
    },
    {
      name: 'owner',
      type: 'string',
      validator: value => {
        if (typeof value !== 'string') {
          return 'Owner must be a string';
        }
        return isValidEmail(value) ? true : getEmailValidationError(value);
      },
    },
  ],
  handler: async options => {
    const to = options['to'];
    const recipients = Array.isArray(to) ? to.map(String) : [String(to)];
    console.log(`Sending "${String(options['subject'])}" to ${recipients.join(', ')}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

```bash
# Rejected — the built-in email type rejects one of two supplied values
# node notify-cli.js send --to=ops@example.com --to=ops@example --subject=Release
#   → Invalid value provided for option [to], required Invalid email format, provided [ops@example]
#
# Rejected — the numeric type converts first, then the custom validator explains the failure
# node notify-cli.js send --to=ops@example.com --subject=Release --retries=-1
#   → Invalid value provided for option [retries], required Retries must be a non-negative integer, provided [-1]
#
# Rejected — choices fail before any validator for that value would run
# node notify-cli.js send --to=ops@example.com --subject=Release --channel=sms
#   → Invalid value provided for option [channel], required one of [email], [webhook], provided [sms]
```

**Why this pattern is valuable** — validation is declarative and layered instead of scattered through handler code, and the layers compose: the `email` type performs format validation with human-readable messages, `choices` performs membership checks with a deterministic list rendering, and custom validators handle everything domain-specific. A validator returning a string turns that string into the expected-value clause of `InvalidOptionValueError`, which keeps error text actionable while the *code* (`INVALID_OPTION_VALUE`) stays stable for programmatic consumers.

**Caveats and considerations**

- Validators must be synchronous (`boolean | string`) and should be pure — they are invoked once per supplied value, once per element of a `multiple` option, and once for an applied default.
- Validators are not called for absent options without defaults, so `owner` above costs nothing unless supplied.
- Defaults are validated on every invocation; a bad default fails each run. The one default problem caught earlier is a `default` that is not in `choices`, which throws `InvalidConfigurationError` at registration.
- For custom string options that should still use email/domain rules, reuse `isValidEmail`, `isValidDomain`, `getEmailValidationError`, and `getDomainValidationError` as shown — the validator can return the exact message the built-in types would have produced.
- When help is requested (`--help`) together with other input, values are still validated: a bad `--retries` beside `--help` rejects rather than silently rendering help.

---

## Pattern 6 — Composable Command Catalogs

**When to use it** — when the command count grows past a handful, or when separate teams own separate commands. Each command becomes a standalone `ICommand` module; the entry point is a few dozen lines that imports the modules, registers them, and applies the Pattern 1 failure contract.

`src/commands/status.ts`:

```typescript
import type { ICommand } from 'blendsdk/cmdline';

export const statusCommand: ICommand = {
  name: 'status',
  description: 'Show the status of the workspace',
  options: [{ name: 'json', type: 'boolean', default: false }],
  handler: options => {
    if (options['json'] === true) {
      console.log(JSON.stringify({ status: 'ok' }));
      return;
    }
    console.log('status: ok');
  },
};
```

`src/commands/deploy.ts`:

```typescript
import type { ICommand } from 'blendsdk/cmdline';

export const deployCommand: ICommand = {
  name: 'deploy',
  description: 'Deploy an artifact to an environment',
  aliases: ['ship'],
  options: [
    { name: 'artifact', type: 'string', required: true },
    {
      name: 'environment',
      short: 'e',
      type: 'string',
      choices: ['staging', 'production'],
      default: 'staging',
    },
  ],
  handler: async options => {
    console.log(`Deploying ${String(options['artifact'])} to ${String(options['environment'])}`);
  },
};
```

`src/cli.ts`:

```typescript
import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
  type ICommand,
} from 'blendsdk/cmdline';
import { deployCommand } from './commands/deploy.js';
import { statusCommand } from './commands/status.js';

const commands: readonly ICommand[] = [statusCommand, deployCommand];

const parser = new CommandLineParser({
  name: 'workspace-cli',
  version: '2.0.0',
  strict: true,
  errorHandler: error => {
    if (error instanceof CommandLineValidationError) {
      for (const issue of error.issues) {
        console.error(issue.message);
      }
    }
  },
});

for (const command of commands) {
  parser.addCommand(command);
}

// For small, fixed sets the fluent chain is equivalent:
// const parser = new CommandLineParser({ name: 'workspace-cli', version: '2.0.0', strict: true })
//   .addCommand(statusCommand)
//   .addCommand(deployCommand);

try {
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineErrorHandlerError) {
    console.error('Error presentation failed:', error.handlerError);
    process.exitCode = 1;
  } else if (error instanceof CommandLineValidationError) {
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

```bash
# node workspace-cli.js status --json
#   → {"status":"ok"}
#
# node workspace-cli.js ship --artifact=app.zip --environment=production
#   → Deploying app.zip to production
```

**Why this pattern is valuable** — each command module is mode-agnostic and independently testable: import `deployCommand` into a test suite and run it through the Pattern 2 harness with injected `argv`. Wiring mistakes fail fast at startup — duplicate names, colliding aliases, reserved spellings, and global/command scope collisions all throw `InvalidConfigurationError` while the process is still configuring, never on the first invocation. And because `addCommand()` defensively clones the command, aliases, examples, and options, later mutation of an imported module object (or of a test fixture that shares it) cannot alter a live parser.

**Caveats and considerations**

- Registration order controls help presentation order; it has no other effect, because duplicate spellings are rejected rather than first-wins.
- The clone is one-directional: editing `deployCommand.options` after registration changes nothing in the parser, which is the point — treat registered commands as immutable.
- Handler options arrive as `OptionsDict`; narrow values in the handler (`String(...)`, `typeof ... === 'boolean'`, `Array.isArray(...)`) as the modules above do. Strict validation guarantees the runtime types, and a small read helper per module keeps handlers clean.
- Command modules can carry `aliases` safely: collisions are checked across every module at registration, so two teams cannot accidentally publish the same alias.

---

## Pattern 7 — Machine-Readable Diagnostics for CI and IDE Consumers

**When to use it** — when build pipelines, IDE integrations, or wrapper scripts consume CLI results programmatically. The typed error hierarchy exposes `code`, `category`, and per-issue structured fields, so consumers can branch on data instead of parsing prose — even though the human-friendly messages (including any `Did you mean` hint) remain available.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  ErrorCategory,
  ErrorCode,
  isCommandLineError,
} from 'blendsdk/cmdline';

interface Diagnostic {
  readonly severity: 'error';
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
}

function emitDiagnostics(error: CommandLineValidationError): void {
  for (const issue of error.issues) {
    const diagnostic: Diagnostic = {
      severity: 'error',
      code: issue.code,
      category: issue.category,
      message: issue.message,
    };
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  }
}

function exitCodeFor(error: CommandLineValidationError): number {
  return error.issues.some(issue => issue.code === ErrorCode.UNKNOWN_COMMAND) ? 2 : 1;
}

const parser = new CommandLineParser({
  name: 'ci-cli',
  version: '3.0.0',
  strict: true,
  errorHandler: error => {
    if (error instanceof CommandLineValidationError) {
      emitDiagnostics(error);
    }
  },
});

parser.addCommand({
  name: 'build',
  description: 'Build the current package',
  options: [{ name: 'target', type: 'string', required: true, choices: ['esm', 'cjs'] }],
  handler: async options => {
    console.log(`Building ${String(options['target'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    process.exitCode = exitCodeFor(error);
  } else if (isCommandLineError(error)) {
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

```bash
# node ci-cli.js build --targt=esm
#   → stderr: {"severity":"error","code":"UNKNOWN_OPTION","category":"PARSING","message":"Unknown option [targt] for command [build]. Did you mean [--target]?"}
#   → stderr: {"severity":"error","code":"MISSING_REQUIRED_OPTION","category":"VALIDATION","message":"Missing required option [target] for command [build]"}
#   → process.exitCode = 1
#
# node ci-cli.js biuld
#   → stderr: {"severity":"error","code":"UNKNOWN_COMMAND","category":"PARSING","message":"Unknown command [biuld]. Available commands: build Did you mean [build]?"}
#   → process.exitCode = 2
```

**Why this pattern is valuable** — one invocation emits one JSON diagnostic per issue, in deterministic order (token issues in input order, then validation issues in declaration order), so a pipeline can render or route each problem independently. Stable codes and categories survive message wording changes, and the tailored exit code (`2` for unknown commands, `1` for other rejections) gives CI systems a coarse discriminator without parsing anything.

**Structured fields beyond `code` / `category` / `message`**

| Error type | Additional fields |
| --- | --- |
| `CommandLineValidationError` | `issues` |
| `UnknownCommandError` | `commandName`, `availableCommands` |
| `UnknownOptionError` | `optionName`, `commandName` |
| `MissingRequiredOptionError` | `optionName`, `commandName` |
| `MissingOptionDependencyError` | `optionName`, `dependencyName`, `commandName` |
| `ConflictingOptionsError` | `conflictingOptions` |
| `InvalidOptionValueError` | `optionName`, `expectedType`, `providedValue` |
| `MalformedArgumentError` | `argument`, `reason` |
| `UnexpectedArgumentError` | `argument` (optional `commandName`) |
| `CommandLineErrorHandlerError` | `parserError`, `handlerError` |

**Caveats and considerations**

- Machine consumers should branch on `code` and the structured fields above; the message text — including `Did you mean` phrasing — is for humans and may be reworded.
- If the diagnostics sink itself throws or rejects (for example, a broken IPC channel), execution rejects with `CommandLineErrorHandlerError`, which preserves both the original aggregate in `parserError` and the sink failure in `handlerError`; treat that as a generic failure (exit code 1 above).
- `isCommandLineError` is the type guard for catch blocks that only need "was this a parser rejection or an application failure?"; use explicit `instanceof` branches when the specific failure category matters.
- Exit-code conventions are yours to define — the library classifies errors and never touches the process exit state itself.

---

## Pattern 8 — Migrating One CLI from Legacy to Strict Mode

**When to use it** — when adopting strict parsing on an existing v5 application. Legacy mode remains the v5 default (`strict` defaults to `false`), so the migration is opt-in, parser by parser. The diff is deliberately small: the command definitions do not change, only the parser configuration and the failure policy around `execute()`.

**Before** — the compatibility path:

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'release-cli', version: '1.0.0' });

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'artifact', type: 'string', required: true },
    { name: 'dry-run', type: 'boolean' },
  ],
  handler: async options => {
    console.log(`Deploying ${String(options['artifact'])}`);
  },
});

await parser.execute();
```

**After** — strict parsing with an explicit exit policy:

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'release-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'artifact', type: 'string', required: true },
    { name: 'dry-run', type: 'boolean' },
  ],
  handler: async options => {
    console.log(`Deploying ${String(options['artifact'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

```bash
# Legacy (v5 default): the misspelled flag is silently ignored and the handler runs
# node release-cli.js deploy --artifact=app.zip --dryrun
#   → Deploying app.zip
#
# Strict: the same input fails closed, with a bounded similarity hint
# node release-cli.js deploy --artifact=app.zip --dryrun
#   → renders help with: - Unknown option [dryrun] for command [deploy]. Did you mean [--dry-run]?
#   → rejects with CommandLineValidationError; the caller sets process.exitCode = 1
```

**Behavior matrix for the same definitions**

| Scenario | Legacy (`strict: false`, the v5 default) | Strict (`strict: true`) |
| --- | --- | --- |
| Unknown option | Ignored; handler still runs | `UnknownOptionError`; handler blocked; hint when a unique match exists |
| Unexpected positional argument | Ignored | `UnexpectedArgumentError` |
| Missing required option | Help rendered; `execute()` resolves | `MissingRequiredOptionError`; rejects |
| Invalid value (type, choices, validator) | Help rendered; resolves | `InvalidOptionValueError`; rejects |
| Conflict or missing dependency | Help rendered; resolves | `ConflictingOptionsError` / `MissingOptionDependencyError`; rejects |
| Unknown command | Help rendered with "No command provided!"; resolves | `UnknownCommandError`; rejects |
| Command and alias spelling | Case-normalized (`DEPLOY` matches `Deploy`) | Exact (`DEPLOY` does not match `Deploy`) |
| `--help` alone | Help rendered; resolves | clean help; resolves without running the handler |
| Invalid input beside `--help` | Help rendered; resolves | Rejects — help never masks invalid input |

**Migration checklist**

1. Add `strict: true` to the parser configuration for one CLI. Existing behavior is untouched until you do.
2. Wrap `execute()` in a `try`/`catch` and choose the exit policy: `process.exitCode = 1` after a `CommandLineValidationError`, rethrow application errors.
3. Decide who presents failures: keep the built-in rendering (issues plus relevant command help, then rejection), or add an `errorHandler` to emit your own format — for example the JSON diagnostics of Pattern 7.
4. Audit spellings that relied on case folding: command names, aliases, and option names are matched exactly in strict mode. The suggestion hints usually make these visible on the first run.
5. Remove reliance on tolerant parsing. Scripts that worked because stray operands or unknown flags were ignored must now pass valid input; this is the point of the migration, but it is also the change most likely to surface in wrappers and shell history.
6. Replace handler use of the legacy `showHelp` helper. Legacy handlers receive a callable `showHelp()` option; strict handlers do not. In strict mode, help is requested through `--help` (a clean help request when the rest of the input is valid), or rendered through your own output boundary.

**Why this pattern is valuable** — both modes share the same foundations: configuration validation and cloning, the help renderer, typed option values, `choices`, custom validators, aliases, global options, and the `conflicts` / `depends` engine. A migration therefore changes *failure semantics only*, never the command surface, and both modes can coexist in the same repository while different CLIs migrate on their own schedule.

**Caveats and considerations**

- The most common behavioral surprise is not the new errors — it is that previously ignored input becomes a rejection. Roll strict mode out per CLI and watch the first CI runs before enforcing it everywhere.
- `CommandLineValidationError` aggregates every problem of an invocation at once; users migrating from one-error-at-a-time tooling should expect longer, more complete reports.
- If an intermediate state must be tolerant, keep that CLI on legacy mode; do not relax strict mode with catch-all options — the fail-closed guarantee is the feature.

---

## Related Documents

- `00-overview.md` — package identity, architecture, and the two parsing modes
- `01-core-concepts.md` — commands, options, and the invocation model
- `02-basic-usage.md` — first commands, help, and handlers
- `04-best-practices.md` — conventions for option naming and configuration
- `08-api-reference.md` — complete type and error reference

The patterns above are designed to be combined: a production CLI uses Pattern 6 for its command catalog, Pattern 1 for its entry point, Pattern 3 for shared flags, Pattern 4 and Pattern 5 for its option contracts, Pattern 2 for its test suite, and Pattern 7 or 8 as its operational context demands.

---

# cmdline Common Scenarios

This page answers the questions developers ask most often when adopting `blendsdk/cmdline`, ordered from a minimal working application to advanced validation, diagnostics, and in-process testing. Every example is a complete ESM module — imports, types, and error handling included — and uses `process.exitCode` for failure reporting, because the library never terminates the process on your behalf.

---

## How do I create a minimal command-line application with a single command?

Create a `CommandLineParser`, register one command with `addCommand()`, and call `execute()`. Opt into `strict: true` so invalid input rejects with a `CommandLineValidationError` instead of being silently tolerated, then translate that rejection into an exit code in a `try` / `catch`.

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
  options: [
    {
      name: 'name',
      short: 'n',
      type: 'string',
      description: 'Name of the person to greet',
      required: true,
    },
  ],
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

  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- `execute()` reads `process.argv.slice(2)` and writes help to the console unless you supply an invocation object (see the dedicated scenario below).
- Every command automatically gains `--help` / `-h` (disable with `skipHelp: true`); a clean help request renders help and resolves without running the handler.
- Errors thrown by your handler reject `execute()` unchanged — the `catch` above rethrows anything that is not a parser failure.

---

## How do I accept option values in every supported spelling?

Long options accept attached (`--output=dist`) or separate (`--output dist`) values, and short options accept `-o=dist`, `-odist`, and `-o dist`. Declare the option once with `name` and `short`, and the parser maps every spelling to the same canonical key.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'build-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'build',
  description: 'Build the project',
  options: [
    {
      name: 'output',
      short: 'o',
      type: 'string',
      description: 'Output directory',
    },
  ],
  handler: async options => {
    console.log(`Building into ${String(options['output'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

| Spelling | Meaning |
| --- | --- |
| `--output=dist` | long form, value attached with `=` |
| `--output dist` | long form, value in the next token |
| `-o=dist` | short form, value attached with `=` |
| `-odist` | compact short form |
| `-o dist` | short form, value in the next token |
| `--output=` | explicit empty string `''` — supplied, not missing |

**Notes**

- A non-boolean option with no value at all (`--output` at the end of the line, or followed only by another option) is malformed input; strict mode rejects it with a `MalformedArgumentError`.
- Option names must start with a letter and may contain letters, digits, hyphens, and underscores; short names must be exactly one letter. Both are validated when the command is registered.

---

## How do I add a boolean flag?

Declare the option with `type: 'boolean'` and it becomes a flag: a bare `--minify` (or `-m`) means `true`. An explicit `=false`, or a separate `true` / `false` literal, sets the value; any other attached text fails validation in strict mode.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'build-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'build',
  options: [
    {
      name: 'minify',
      short: 'm',
      type: 'boolean',
      description: 'Minify the output bundle',
    },
  ],
  handler: async options => {
    console.log(`minify=${String(options['minify'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

| Input | Effective value |
| --- | --- |
| `--minify` or `-m` | `true` |
| `--minify=true` | `true` |
| `--minify=false` | `false` |
| `--minify false` | `false` (the literal word is consumed) |
| `--minify=maybe` | rejected in strict mode — not a boolean |

**Notes**

- Only the literal words `true` / `false` are consumed from the next token; `--minify extra` leaves `extra` behind, which strict mode rejects as an unexpected argument.
- Use `--flag=false` when a caller needs to override a scripted or default-enabled flag.

---

## How do I accept numbers, including negative values?

Declare `type: 'number'` and supplied values are converted with JavaScript number semantics before validation. Negative decimals such as `-2.5` are recognized as values rather than options, so both `--offset -2.5` and `--offset=-2.5` reach the option.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'run-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'run',
  options: [
    { name: 'retries', short: 'r', type: 'number', description: 'Retry attempts' },
    { name: 'offset', short: 'x', type: 'number', description: 'Offset in milliseconds' },
  ],
  handler: async options => {
    console.log(`retries=${String(options['retries'])} offset=${String(options['offset'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

| Input | Result |
| --- | --- |
| `--retries=5` | `5` (a real number) |
| `--offset -2.5` | `-2.5` |
| `--offset=-2.5` | `-2.5` |
| `--retries=` | supplied but invalid — `''` is not a number |
| `--retries=abc` | invalid — unparseable text is kept and rejected |

**Notes**

- Conversion runs before `choices` and custom `validator` checks, so those see a real number.
- A value that cannot be converted stays a string and is rejected in strict mode with an `InvalidOptionValueError` (empty and whitespace-only attachments included).

---

## How do I give an option a default value?

Add `default` to the option definition and the value applies whenever the option is absent, so the handler always receives a concrete value. Defaults run through the same type, `choices`, and validator checks as supplied values.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'build-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'build',
  options: [
    {
      name: 'mode',
      type: 'string',
      choices: ['safe', 'fast'],
      default: 'safe',
      description: 'Build mode (default: safe)',
    },
  ],
  handler: async options => {
    console.log(`mode=${String(options['mode'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- A default that is not in `choices` throws an `InvalidConfigurationError` from `addCommand()`; a default rejected by a custom validator fails at execution time.
- A `default` also satisfies `required`, so the two settings never conflict.
- An absent option without a default is `undefined` in the handler.

---

## How do I make an option required?

Set `required: true` on the option definition. In strict mode a missing required option is a typed parser failure that blocks the handler; in legacy mode the same situation renders help and resolves quietly.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deploy-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'deploy',
  options: [
    {
      name: 'output',
      short: 'o',
      type: 'string',
      required: true,
      description: 'Deploy target',
    },
  ],
  handler: async options => {
    console.log(`Deploying to ${String(options['output'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- The aggregate contains a `MissingRequiredOptionError` with `optionName` and `commandName` fields, and the handler is never invoked after invalid input in strict mode.
- A clean help request is not blocked by missing required options — it renders help and resolves; other invalid input still rejects even when `--help` is also present.
- A `default` satisfies `required`, so combine them when "required" means "must have a value" rather than "must appear on the command line".

---

## How do I collect multiple values for one option?

Set `multiple: true` on the option and repeat it on the command line; values accumulate in source order and the handler receives an array.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'tag-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'tag',
  options: [
    {
      name: 'label',
      short: 'l',
      type: 'string',
      multiple: true,
      description: 'Labels to attach (repeatable)',
    },
  ],
  handler: async options => {
    const label = options['label'];
    const labels = Array.isArray(label) ? label.map(value => String(value)) : [];
    console.log(`labels=${labels.join(', ')}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- Run as `tag --label=one --label=two`, the handler receives `['one', 'two']`; even a single occurrence arrives as a one-element array.
- Without `multiple`, a repeated option keeps the last value (`--output=a --output=b` yields `b`).
- `choices` and custom validators are applied to every collected value; one invalid element blocks the handler in strict mode.

---

## How do I restrict an option to a fixed set of values?

List the accepted values in `choices`. The check is exact and case-sensitive, runs before any custom validator, and failures are reported with the allowed values.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deploy-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'deploy',
  options: [
    {
      name: 'environment',
      short: 'e',
      type: 'string',
      choices: ['dev', 'staging', 'production'],
      required: true,
      description: 'Target environment',
    },
  ],
  handler: async options => {
    console.log(`Deploying to ${String(options['environment'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- Matching is exact: `--environment=Test` fails even though `test` is close to `staging` — values are never case-folded.
- Values are converted before comparison, so numeric choices work: `--level=3` matches `choices: [1, 2, 3]`.
- An empty `choices` array, or a `default` that is not in `choices`, throws an `InvalidConfigurationError` when the command is registered.

---

## How do I validate a value with my own rule?

Add a `validator` function that returns `true` to accept the value, `false` for a generic failure, or a string that becomes the explanation in the error message. In strict mode validators run after type and `choices` checks, so they receive converted values of the declared type.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'archive-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'archive',
  options: [
    {
      name: 'path',
      type: 'string',
      required: true,
      validator: value => {
        if (typeof value !== 'string') {
          return 'Path must be a string';
        }
        return value.startsWith('/') || 'Path must be absolute';
      },
    },
  ],
  handler: async options => {
    console.log(`Archiving ${String(options['path'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- Validators also run on defaults and on each element of a `multiple` option; they are skipped only when the option is absent and has no default.
- A `false` result produces a generic message, while a returned string is used verbatim as the reason — ideal for actionable feedback (`Path must be absolute`).
- Narrow the parameter with `typeof` checks as shown; the parser guarantees the declared type only after its own type validation passes.

---

## How do I validate email addresses and domain names?

Declare the option as `type: 'email'` or `type: 'domain'` and the parser applies the built-in practical validators. Failures include the human-readable reason produced by `getEmailValidationError` / `getDomainValidationError`.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'notify-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'notify',
  options: [
    {
      name: 'email',
      short: 'e',
      type: 'email',
      required: true,
      description: 'Recipient address',
    },
    {
      name: 'host',
      type: 'domain',
      default: 'example.com',
      description: 'SMTP host',
    },
  ],
  handler: async options => {
    console.log(`notify ${String(options['email'])} via ${String(options['host'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- Email values must contain exactly one `@`, a local part of at most 64 characters, and a dotted domain whose last label has at least two characters — `user@localhost` is rejected.
- Domain values allow single labels such as `localhost`, but every label is limited to 63 characters and the final label must contain at least one letter.
- `isValidEmail`, `isValidDomain`, `getEmailValidationError`, and `getDomainValidationError` are exported so application code can reuse the exact same rules.

---

## How do I let an alias invoke a command?

Add `aliases` to a command definition; every alias selects the same canonical command with the same options and handler. Aliases are exact in strict mode and case-normalized in legacy mode.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deploy-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'deploy',
  aliases: ['ship', 'release'],
  options: [{ name: 'output', short: 'o', type: 'string' }],
  handler: async options => {
    console.log(`Deploying to ${String(options['output'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- In strict mode an alias must match exactly (`ship`); a differently cased spelling such as `Ship` is an unknown command that gets a `Did you mean [ship]?` hint. Legacy mode normalizes case, so `SHIP` invokes the same command.
- Registering an alias that is reserved, malformed, duplicated after normalization, or already owned by another command throws an `InvalidConfigurationError` from `addCommand()`.
- Command and alias spellings start with a letter and may contain letters, digits, hyphens, and underscores — `build-prod` and `deploy_to_staging` are valid.

---

## How do I run a command when no command is specified?

Mark one command with `default: true` and it runs when the argument list contains no explicit command token, including option-only invocations.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'serve-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'serve',
  description: 'Start the development server',
  default: true,
  options: [
    {
      name: 'port',
      short: 'p',
      type: 'number',
      default: 3000,
      description: 'Listening port',
    },
  ],
  handler: async options => {
    console.log(`Serving on port ${String(options['port'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- An unknown explicit command never falls back to the default — explicit input always wins, even when it is invalid.
- The default is effective only while exactly one command is registered; add a second command and bare invocations render top-level help instead (the same rule applies in legacy mode).
- Option-only invocations (`--port=4000`) select the default command; option values are consumed before the parser decides whether a command token exists.

---

## How do I define options that are shared by every command?

Pass `globalOptions` to the parser constructor. Global options are accepted before or after the explicit command, and their values always arrive in the handler under the canonical long name.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deploy-cli',
  version: '1.0.0',
  strict: true,
  globalOptions: [
    { name: 'profile', short: 'p', type: 'string', description: 'Configuration profile' },
    { name: 'dry-run', type: 'boolean', description: 'Plan without applying changes' },
  ],
});

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', short: 'o', type: 'string' }],
  handler: async options => {
    const profile = String(options['profile']);
    const dryRun = String(options['dry-run']);
    const output = String(options['output']);
    console.log(`profile=${profile} dry-run=${dryRun} output=${output}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- Both `--profile=release deploy` and `deploy --profile=release` reach the handler with `profile: 'release'`.
- Global options support the same configuration surface as command options (types, `required`, `default`, `choices`, validators, `conflicts` / `depends`).
- Collisions with a command option's long or short spelling fail at registration; lowercase `h` collides with automatic help unless `skipHelp: true`.
- In strict mode only global options are recognized before the command token — place command-local options after the command name.

---

## How do I enforce conflicting and dependent options?

Use `conflicts` to forbid combinations and `depends` to require companions. Both are evaluated from explicitly supplied options only: an explicit `false` counts as present, while a default alone never activates either relationship.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  ConflictingOptionsError,
  MissingOptionDependencyError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deploy-cli',
  version: '1.0.0',
  strict: true,
});

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'quiet', type: 'boolean', conflicts: ['verbose'] },
    { name: 'verbose', type: 'boolean' },
    { name: 'upload', type: 'boolean', depends: ['token'] },
    { name: 'token', type: 'string' },
  ],
  handler: async () => {
    console.log('Deploying');
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  for (const issue of error.issues) {
    if (issue instanceof ConflictingOptionsError) {
      console.error(`conflict: ${issue.conflictingOptions.join(', ')}`);
    } else if (issue instanceof MissingOptionDependencyError) {
      console.error(`missing dependency: ${issue.optionName} needs ${issue.dependencyName}`);
    } else {
      console.error(issue.message);
    }
  }
  process.exitCode = 1;
}
```

**Notes**

- `deploy --quiet --verbose` produces one deduplicated `ConflictingOptionsError`; reciprocal declarations are reported once, ordered by owner registration then declaration order.
- A dependency is satisfied by an explicit value or a configured `default`, including `false` — `--upload` with `--token=` set elsewhere still fails, but a defaulted `token` satisfies it.
- A single option cannot list the same name in both `conflicts` and `depends`; that fails at registration time.
- Legacy mode renders help and resolves for these failures instead of rejecting.

---

## How do I pass application state into a command handler?

Pass a context value as the first argument of `execute()`; the parser forwards it opaquely to the selected handler as `options.context`. Narrow it defensively in the handler, since the parser does not inspect it.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

interface RequestContext {
  readonly userId: number;
  readonly environment: string;
}

function isRequestContext(value: unknown): value is RequestContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    'userId' in value &&
    'environment' in value &&
    typeof value.userId === 'number' &&
    typeof value.environment === 'string'
  );
}

const parser = new CommandLineParser({ name: 'report-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'report',
  options: [{ name: 'format', type: 'string', default: 'json' }],
  handler: async options => {
    const context = options.context;
    if (isRequestContext(context)) {
      console.log(`user ${context.userId} in ${context.environment}: ${String(options['format'])}`);
      return;
    }
    console.log(`anonymous request: ${String(options['format'])}`);
  },
});

const context: RequestContext = { userId: 123, environment: 'test' };

try {
  await parser.execute(context, { argv: ['report', '--format=json'] });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- The context is invocation-local: the same parser instance can receive a different value on every `execute()` call.
- Executing without a context leaves `options.context` as `undefined` — the guard above handles both cases without an `any` cast.
- Typical contexts include loggers, request ids, or service handles that the CLI's composition root already built.

---

## How do I run the parser with explicit arguments and capture help output?

Pass an invocation object as the second argument of `execute()`: `argv` replaces `process.argv.slice(2)`, and `write` collects every rendered help line instead of writing to the console.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'show-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'show',
  options: [{ name: 'value', type: 'string', required: true }],
  handler: async options => {
    console.log(`value=${String(options['value'])}`);
  },
});

try {
  // First invocation: supply arguments explicitly; process.argv is not read.
  await parser.execute(undefined, { argv: ['show', '--value', 'first'] });

  // Second invocation: a clean help request renders into the collector and resolves.
  const helpLines: string[] = [];
  await parser.execute(undefined, {
    argv: ['show', '--help'],
    write: line => {
      helpLines.push(line);
    },
  });
  console.log(helpLines.join('\n'));
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- When `argv` is supplied, `process.argv` is neither read nor mutated, so the pattern is safe in tests and embedded runners.
- Parsed values, defaults, arrays, and help flags are rebuilt on every call — one parser instance can serve many invocations without leaking state.
- A clean help request resolves without executing the handler; invalid input still rejects with the typed aggregate.

---

## How do I customize how invalid input is presented?

Provide an `errorHandler` in the parser configuration. The parser awaits your hook instead of rendering built-in help, then rejects with the same typed error, so programmatic failure semantics never change.

```typescript
import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deploy-cli',
  version: '1.0.0',
  strict: true,
  errorHandler: async error => {
    if (error instanceof CommandLineValidationError) {
      for (const issue of error.issues) {
        console.error(`[${issue.code}] ${issue.message}`);
      }
      return;
    }
    console.error(`[${error.code}] ${error.message}`);
  },
});

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', short: 'o', type: 'string', required: true }],
  handler: async options => {
    console.log(`Deploying to ${String(options['output'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (
    error instanceof CommandLineValidationError ||
    error instanceof CommandLineErrorHandlerError
  ) {
    // Presentation already happened; the application only owns the exit policy.
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

**Notes**

- The hook is awaited, suppresses the built-in help rendering, and then execution rejects with the same `CommandLineValidationError` — it never swallows the failure.
- If the hook throws or rejects, execution rejects with a `CommandLineErrorHandlerError` exposing `.parserError` (the original aggregate) and `.handlerError`.
- The hook only sees parser failures; an error thrown by your command handler always propagates unchanged.

---

## How do I opt into strict parsing, and how does it differ from legacy mode?

Set `strict: true` in the parser configuration. Legacy mode remains the v5 default, so an existing application keeps its permissive behavior until it opts in; the two modes differ mainly in lookup rules, failure handling, and diagnostics.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

// Legacy mode remains the v5 default: command selection folds case.
const legacyParser = new CommandLineParser({ name: 'legacy-cli', version: '1.0.0' });
legacyParser.addCommand({
  name: 'Deploy',
  handler: async () => {
    console.log('legacy: running Deploy');
  },
});
await legacyParser.execute(undefined, { argv: ['deploy'] });

// Strict mode is opt-in and matches the declared spelling exactly.
const strictParser = new CommandLineParser({ name: 'strict-cli', version: '1.0.0', strict: true });
strictParser.addCommand({
  name: 'Deploy',
  handler: async () => {
    console.log('strict: running Deploy');
  },
});

try {
  await strictParser.execute(undefined, { argv: ['deploy'] });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  // Rejects: Unknown command [deploy]. ... Did you mean [Deploy]?
  console.error(error.message);
  process.exitCode = 1;
}
```

| Aspect | Strict (`strict: true`) | Legacy (default) |
| --- | --- | --- |
| Command lookup | exact declared spelling | case-insensitive |
| Option lookup | exact declared spelling | exact declared spelling |
| Unknown options / stray operands | rejected | ignored |
| Invalid or missing values | rejects with `CommandLineValidationError` | renders help and resolves |
| Typos | `Did you mean [...]?` hints | none |
| Help request | clean help, resolves | renders help, resolves |

**Notes**

- Legacy mode lower-cases command tokens before lookup and opportunistically JSON-parses supplied values, falling back to the raw string when parsing fails.
- Legacy handlers additionally receive a `showHelp()` helper they can call to render help on demand.
- Everything else — commands, aliases, global options, choices, validators, relationships — works in both modes, so adoption can happen one parser at a time.

---

## How do I get "Did you mean" suggestions for typos?

Nothing to configure — in strict mode, unknown commands and unknown long options automatically carry a bounded `Did you mean [spelling]?` hint when exactly one registered candidate is close enough. The hint is diagnostic only: the token stays invalid and the command never runs.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'preserve-status', type: 'boolean' }],
  handler: async options => {
    console.log(`preserve-status=${String(options['preserve-status'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy', '--preserve-stauts'] });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  // Prints: Unknown option [preserve-stauts] for command [deploy]. Did you mean [--preserve-status]?
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- Hints appear for unknown commands and unknown long options (in the typed error message and in rendered help); short options never get hints.
- A transposition counts as one edit (`hlep` → `help`); two edits are allowed only when both compared spellings are at least eight characters long.
- Only a unique best candidate produces a hint — ties are omitted, names shorter than four characters are never compared, and very long spellings are skipped.
- Work is bounded per execution, so when the comparison budget is exhausted the hint is silently omitted rather than guessed; hidden options are excluded from option candidates.

---

## How do I disable the automatic help option?

Pass `skipHelp: true` to the parser configuration and no automatic help is added to any command, freeing the short name `h` for your own options.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'batch-cli',
  version: '1.0.0',
  strict: true,
  skipHelp: true,
});

parser.addCommand({
  name: 'run',
  options: [{ name: 'host', short: 'h', type: 'string', description: 'Target host' }],
  handler: async options => {
    console.log(`Running against ${String(options['host'])}`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(error.message);
  process.exitCode = 1;
}
```

**Notes**

- Without `skipHelp`, every command automatically registers `--help` / `-h`; with it, strict mode treats those tokens as unknown options and rejects them, while legacy mode ignores them as unknown tokens.
- Disabling help frees lowercase `h` for your own option; otherwise only uppercase `H` avoids the automatic collision, because short-name checks are case-sensitive.
- The names `help` and `version` are reserved for commands and options either way, so a replacement help facility must use a different spelling (for example a `usage` option).

---

# cmdline Examples Library

This library collects copy-paste-ready examples for `blendsdk/cmdline`, organized by feature area and ordered from simple to complex. Every example is complete: imports, parser configuration, handlers, and the expected result. All examples assume ESM and Node.js >= 22 with top-level `await` support.

---

## How to Use These Examples

- **Single import root** — every example imports from `blendsdk/cmdline` (never a subpath), ESM only.
- **Two modes** — examples marked `strict: true` fail closed: invalid input rejects with `CommandLineValidationError` and the command handler never runs. Examples that omit `strict` run in legacy mode — legacy mode remains the v5 default for compatibility.
- **Invocation-local I/O** — examples that must be deterministic (or are meant for embedding and tests) inject `{ argv: [...] }` and capture help lines with `{ write: ... }`. The library only touches `process.argv` and the console when those are omitted.
- **Caller-owned exit policy** — strict examples map typed rejection to `process.exitCode` by hand. The library never terminates the process.
- **Expected output** — shown after each example as comments (`#   →` shell lines or `// Output:` lines). Abridged output is marked as such.

---

## Example Index

| Category | Focus |
| --- | --- |
| Getting Started | Minimal strict and legacy CLIs; invocation-local arguments and output |
| Commands | Multiple commands, aliases, defaults, hyphenated names, context |
| Options | Types, short forms, multiple values, defaults, required, choices, validators, email/domain, hidden |
| Global Options | Options accepted before or after a command |
| Option Relationships | `conflicts` and `depends` |
| Error Handling | Rejection, exit policy, error hooks, typed issues, suggestions |
| Help Output | Clean help requests, capturing help, top-level help, `skipHelp` |
| Testing and Embedding | In-process tests and parser reuse |
| Complete Applications | A full strict CLI with everything combined |

---

## Getting Started

### Minimal Strict CLI

The smallest useful strict-mode program: one command, one required option, and typed rejection handling. Invalid input fails closed — the handler is never invoked.

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
  handler: options => {
    console.log(`Hello, ${String(options['name'])}!`);
  },
});

try {
  await parser.execute();
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  // The library rejects instead of terminating; the caller owns the exit policy.
  process.exitCode = 1;
}
```

```bash
# node greet-cli.js greet --name Ada
#   → Hello, Ada!
#
# node greet-cli.js greet --nmae Ada
#   → renders command help, including: Did you mean [--name]?
#   → rejects with CommandLineValidationError; the caller sets process.exitCode = 1
```

### Minimal Legacy CLI (V5 Default)

Omitting `strict` keeps the historic permissive behavior: commands are recognized case-insensitively, and parse problems render help and resolve instead of rejecting.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'greet-cli',
  version: '1.0.0',
  // strict is omitted: legacy mode remains the v5 default.
});

parser.addCommand({
  name: 'greet',
  description: 'Greet someone by name',
  options: [{ name: 'name', short: 'n', type: 'string', required: true }],
  handler: options => {
    console.log(`Hello, ${String(options['name'])}!`);
  },
});

await parser.execute();
```

```bash
# node greet-cli.js GREET --name Ada
#   → Hello, Ada!   (command lookup is case-normalized)
#
# node greet-cli.js greet
#   → renders help listing the missing required option, then resolves
#   → no rejection and no exit-code change
```

### Invocation-Local Arguments and Output

`execute(context, { argv, write })` supplies the argument list and captures rendered lines — no process or console coupling, which makes the parser fully embeddable and testable.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const output: string[] = [];
const parser = new CommandLineParser({ name: 'report-cli', strict: true }).addCommand({
  name: 'report',
  options: [{ name: 'format', type: 'string', choices: ['json', 'csv'], default: 'json' }],
  handler: options => {
    output.push(`format=${String(options['format'])}`);
  },
});

await parser.execute(undefined, {
  argv: ['report', '--format', 'csv'],
  write: line => output.push(line),
});

console.log(output.join('\n'));
// Output: format=csv
```

---

## Commands

### Registering Multiple Commands

`addCommand()` returns the parser instance, so registrations can be chained fluently. With two or more commands and no default, an empty invocation renders top-level help.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'project-cli', version: '1.0.0', strict: true });

parser
  .addCommand({
    name: 'build',
    description: 'Build the project',
    options: [{ name: 'output', short: 'o', type: 'string', default: 'dist' }],
    handler: options => {
      console.log(`Building into ${String(options['output'])}`);
    },
  })
  .addCommand({
    name: 'clean',
    description: 'Remove build artifacts',
    handler: () => {
      console.log('Cleaned.');
    },
  });

await parser.execute();
```

```bash
# node project-cli.js build
#   → Building into dist
#
# node project-cli.js clean
#   → Cleaned.
#
# node project-cli.js
#   → renders top-level help listing both commands, then resolves
```

### Command Aliases

Aliases route to the canonical command's handler state. They are exact in strict mode and case-normalized in legacy mode; an alias that collides with an existing command or alias throws `InvalidConfigurationError` during registration.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'ship-cli', strict: true }).addCommand({
  name: 'deploy',
  description: 'Deploy the application',
  aliases: ['ship', 'release'],
  options: [{ name: 'environment', short: 'e', type: 'string', required: true }],
  handler: options => {
    console.log(`Deploying to ${String(options['environment'])}`);
  },
});

await parser.execute();
```

```bash
# node ship-cli.js ship --environment staging
#   → Deploying to staging
#
# node ship-cli.js release -e production
#   → Deploying to production
#
# node ship-cli.js SHIP --environment staging
#   → rejects (strict lookup is case-sensitive): Did you mean [ship]?
```

### Default Command

A `default: true` command runs when no command token is present — but only while it is the *only* registered command. With two or more commands, an empty invocation renders top-level help instead.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'lint-cli', strict: true }).addCommand({
  name: 'check',
  description: 'Check the codebase',
  default: true,
  options: [{ name: 'fix', type: 'boolean' }],
  handler: options => {
    console.log(options['fix'] === true ? 'Fixing problems...' : 'Checking for problems...');
  },
});

await parser.execute(undefined, { argv: ['--fix'] });
// Output: Fixing problems...
```

### Hyphenated and Underscored Command Names

Command names must start with a letter and may contain letters, digits, hyphens, and underscores. Invalid patterns throw `InvalidConfigurationError` at registration time.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'release-cli', strict: true });

parser.addCommand({
  name: 'build-prod',
  description: 'Create a production build',
  handler: () => {
    console.log('Production build complete.');
  },
});

parser.addCommand({
  name: 'deploy-to_staging',
  description: 'Deploy to the staging environment',
  handler: () => {
    console.log('Staging deployment complete.');
  },
});

await parser.execute(undefined, { argv: ['deploy-to_staging'] });
// Output: Staging deployment complete.
```

### Passing a Context Object

The first argument of `execute()` is forwarded to the selected handler as `options.context` — ideal for injecting loggers, service clients, or an environment name.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true }).addCommand({
  name: 'deploy',
  handler: options => {
    const environment = typeof options.context === 'string' ? options.context : 'development';
    console.log(`Deploying to ${environment}`);
  },
});

await parser.execute('production', { argv: ['deploy'] });
// Output: Deploying to production
```

---

## Options

### Typed Options

Values are converted before validation: `number` options receive numbers, `boolean` flags become `true` when bare, and explicit `true`/`false` text is recognized.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'serve-cli', strict: true }).addCommand({
  name: 'serve',
  options: [
    { name: 'host', type: 'string', required: true },
    { name: 'port', type: 'number', default: 8080 },
    { name: 'verbose', short: 'v', type: 'boolean' },
  ],
  handler: options => {
    const host = String(options['host']);
    const port = Number(options['port']);
    const verbose = options['verbose'] === true;
    console.log(`host=${host} port=${port} verbose=${verbose}`);
  },
});

await parser.execute(undefined, {
  argv: ['serve', '--host', 'example.com', '--port', '3000', '-v'],
});
// Output: host=example.com port=3000 verbose=true
```

### Short Options, Attached Values, and Negative Numbers

The same option value can be bound in five spellings. Negative decimals such as `-2.5` are treated as values only when consumed by a registered `number` option.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'shift-cli', strict: true }).addCommand({
  name: 'shift',
  options: [
    { name: 'output', short: 'o', type: 'string' },
    { name: 'offset', type: 'number' },
  ],
  handler: options => {
    console.log(`output=${String(options['output'])} offset=${Number(options['offset'])}`);
  },
});

// All of these spellings bind the same option value:
//   --output=dist   --output dist   -o=dist   -odist   -o dist
await parser.execute(undefined, { argv: ['shift', '-odist', '--offset', '-2.5'] });
// Output: output=dist offset=-2.5
```

### Multiple Values

With `multiple: true`, every occurrence accumulates in source order, and the handler always receives an array — even after a single occurrence.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'batch-cli', strict: true }).addCommand({
  name: 'copy',
  options: [{ name: 'file', short: 'f', type: 'string', multiple: true }],
  handler: options => {
    const files = options['file'];
    const list: string[] = Array.isArray(files) ? files.map(value => String(value)) : [];
    console.log(`Copying ${list.length} file(s):`);
    for (const file of list) {
      console.log(`  - ${file}`);
    }
  },
});

await parser.execute(undefined, {
  argv: ['copy', '--file', 'a.ts', '--file', 'b.ts'],
});
// Output:
// Copying 2 file(s):
//   - a.ts
//   - b.ts
```

### Default Values

Defaults are applied when an option is absent and pass the same validation as supplied values. A default outside a declared `choices` list is rejected at registration time.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'run-cli', strict: true }).addCommand({
  name: 'run',
  options: [
    { name: 'mode', type: 'string', choices: ['fast', 'normal', 'safe'], default: 'normal' },
    { name: 'trace', type: 'boolean', default: false },
  ],
  handler: options => {
    console.log(`mode=${String(options['mode'])} trace=${options['trace'] === true}`);
  },
});

await parser.execute(undefined, { argv: ['run'] });
// Output: mode=normal trace=false
```

### Required Options

A missing required option produces a `MissingRequiredOptionError` inside the strict failure aggregate. Passing `write` suppresses the built-in help rendering so the example's output stays focused.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  MissingRequiredOptionError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'publish-cli', strict: true }).addCommand({
  name: 'publish',
  options: [{ name: 'tag', type: 'string', required: true }],
  handler: options => {
    console.log(`Publishing ${String(options['tag'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['publish'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    const missing = error.issues.find(issue => issue instanceof MissingRequiredOptionError);
    console.log(`Blocked: ${missing?.message ?? error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
// Output: Blocked: Missing required option [tag] for command [publish]
```

### Restricting Values with Choices

`choices` accepts only the declared literals (case-sensitive) and works with defaults, `multiple`, and custom validators.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'release-cli', strict: true }).addCommand({
  name: 'promote',
  options: [
    {
      name: 'environment',
      short: 'e',
      type: 'string',
      required: true,
      choices: ['dev', 'staging', 'production'],
    },
  ],
  handler: options => {
    console.log(`Promoting to ${String(options['environment'])}`);
  },
});

await parser.execute(undefined, { argv: ['promote', '-e', 'production'] });
// Output: Promoting to production
//
// -e test rejects with InvalidOptionValueError:
//   Invalid value provided for option [environment], required one of [dev], [staging], [production], provided [test]
```

### Custom Validators

A validator receives the already-converted value and returns `true` to accept, or a string message to reject. The message is preserved in the resulting `InvalidOptionValueError`.

```typescript
import { CommandLineParser, type OptionValueType } from 'blendsdk/cmdline';

const portValidator = (value: OptionValueType): boolean | string => {
  if (typeof value !== 'number') {
    return 'Port must be a number';
  }
  return (value >= 1024 && value <= 65535) || 'Port must be between 1024 and 65535';
};

const parser = new CommandLineParser({ name: 'serve-cli', strict: true }).addCommand({
  name: 'serve',
  options: [{ name: 'port', type: 'number', validator: portValidator }],
  handler: options => {
    console.log(`Listening on port ${Number(options['port'])}`);
  },
});

await parser.execute(undefined, { argv: ['serve', '--port', '8080'] });
// Output: Listening on port 8080
//
// --port 80 rejects with InvalidOptionValueError:
//   Invalid value provided for option [port], required Port must be between 1024 and 65535, provided [80]
```

### Email and Domain Option Types

The dedicated `email` and `domain` types validate against the package's built-in rules, and invalid values produce descriptive messages through the same error path as every other option.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'invite-cli', strict: true }).addCommand({
  name: 'invite',
  options: [
    { name: 'email', short: 'e', type: 'email', required: true },
    { name: 'domain', short: 'd', type: 'domain' },
  ],
  handler: options => {
    console.log(`Inviting ${String(options['email'])}`);
    if (options['domain'] !== undefined) {
      console.log(`Restricted to domain ${String(options['domain'])}`);
    }
  },
});

await parser.execute(undefined, {
  argv: ['invite', '--email', 'ada@example.com', '--domain', 'example.com'],
});
// Output:
// Inviting ada@example.com
// Restricted to domain example.com
//
// --email not-an-email rejects with InvalidOptionValueError:
//   Invalid value provided for option [email], required Email must contain @ symbol, provided [not-an-email]
```

### Reusing Built-in Validators

`isValidEmail`, `isValidDomain`, `getEmailValidationError`, and `getDomainValidationError` are exported for use outside option parsing — for example in custom validators, pre-checks, or configuration validation.

```typescript
import { getDomainValidationError, isValidDomain } from 'blendsdk/cmdline';

const candidates = ['example.com', 'bad..domain', '-invalid.example'];

for (const candidate of candidates) {
  if (isValidDomain(candidate)) {
    console.log(`${candidate} -> valid`);
  } else {
    console.log(`${candidate} -> ${getDomainValidationError(candidate)}`);
  }
}

// Output:
// example.com -> valid
// bad..domain -> Domain labels cannot be empty
// -invalid.example -> Domain cannot start or end with a hyphen
```

### Hidden Options

A `hidden: true` option is parsed and validated exactly like a visible one, but it is excluded from "Did you mean" suggestion candidates — useful for internal or debug switches.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'diag-cli', strict: true }).addCommand({
  name: 'scan',
  options: [
    { name: 'depth', type: 'number', default: 1 },
    { name: 'internal-trace', type: 'boolean', hidden: true },
  ],
  handler: options => {
    const trace = options['internal-trace'] === true;
    console.log(`depth=${Number(options['depth'])} trace=${trace}`);
  },
});

await parser.execute(undefined, { argv: ['scan', '--internal-trace', '--depth', '3'] });
// Output: depth=3 trace=true
```

---

## Global Options

### Global Options Before and After a Command

Options declared on the parser itself are recognized in both positions and always reach handlers under their canonical long names. A collision between a global and a command spelling throws `InvalidConfigurationError` at `addCommand` time.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'tool-cli',
  version: '1.0.0',
  strict: true,
  globalOptions: [{ name: 'profile', short: 'p', type: 'string', default: 'default' }],
}).addCommand({
  name: 'deploy',
  handler: options => {
    console.log(`profile=${String(options['profile'])}`);
  },
});

await parser.execute(undefined, { argv: ['--profile', 'release', 'deploy'] });
// Output: profile=release

await parser.execute(undefined, { argv: ['deploy', '--profile', 'release'] });
// Output: profile=release
```

---

## Option Relationships

### Conflicting Options

`conflicts` rejects combinations in which both options are explicitly supplied. An explicit `false` counts as supplied; a default alone never activates a conflict.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  ConflictingOptionsError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'format-cli', strict: true }).addCommand({
  name: 'format',
  options: [
    { name: 'quiet', type: 'boolean', conflicts: ['verbose'] },
    { name: 'verbose', type: 'boolean' },
  ],
  handler: () => {
    console.log('Formatted.');
  },
});

try {
  await parser.execute(undefined, {
    argv: ['format', '--quiet', '--verbose'],
    write: () => undefined,
  });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  for (const issue of error.issues) {
    if (issue instanceof ConflictingOptionsError) {
      console.log(`Rejected: conflicting options ${issue.conflictingOptions.join(', ')}`);
    }
  }
  process.exitCode = 1;
}
// Output: Rejected: conflicting options quiet, verbose
```

### Dependent Options

`depends` requires a companion option whenever the owner is explicitly supplied. The dependency is satisfied by an explicit value or a configured default, including `false`; defaults alone never activate the depending option.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  MissingOptionDependencyError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true }).addCommand({
  name: 'deploy',
  options: [
    { name: 'upload', type: 'boolean', depends: ['token'] },
    { name: 'token', type: 'string' },
  ],
  handler: options => {
    console.log(`Uploading with token ${String(options['token'])}`);
  },
});

await parser.execute(undefined, { argv: ['deploy', '--upload', '--token', 'abc123'] });
// Output: Uploading with token abc123

try {
  await parser.execute(undefined, { argv: ['deploy', '--upload'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    for (const issue of error.issues) {
      if (issue instanceof MissingOptionDependencyError) {
        console.log(
          `Rejected: option [${issue.optionName}] requires option [${issue.dependencyName}]`
        );
      }
    }
    process.exitCode = 1;
  } else {
    throw error;
  }
}
// Output: Rejected: option [upload] requires option [token]
```

---

## Error Handling

### Mapping Typed Errors to an Exit Code

The library rejects with typed errors and leaves process policy to the application. `isCommandLineError` narrows any caught value to the shared `CommandLineError` base with `code`, `category`, and `message`.

```typescript
import { CommandLineParser, isCommandLineError } from 'blendsdk/cmdline';

async function main(): Promise<void> {
  const parser = new CommandLineParser({
    name: 'strict-cli',
    version: '1.0.0',
    strict: true,
  });

  parser.addCommand({
    name: 'run',
    options: [{ name: 'task', type: 'string', required: true }],
    handler: options => {
      console.log(`Running ${String(options['task'])}`);
    },
  });

  try {
    await parser.execute();
  } catch (error) {
    if (!isCommandLineError(error)) {
      throw error;
    }
    console.error(`[${error.code}] ${error.message}`);
    // The library rejects; the application owns termination policy.
    process.exitCode = 1;
  }
}

await main();
```

```bash
# node strict-cli.js run --task build
#   → Running build
#
# node strict-cli.js run
#   → [VALIDATION_FAILED] Command-line validation failed:
#     - Missing required option [task] for command [run]
#   → exit code 1 (set by the caller; the library never terminates the process)
```

### Custom Error Presentation with errorHandler

A configured `errorHandler` replaces the built-in invalid-input rendering. The hook is awaited and the parser still rejects with the same aggregate afterwards, so programmatic handling is unaffected.

```typescript
import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'audit-cli',
  version: '1.0.0',
  strict: true,
  errorHandler: error => {
    // Replaces the built-in invalid-input rendering; the parser still rejects afterwards.
    console.error(`audit-cli rejected the invocation [${error.code}]`);
  },
});

parser.addCommand({ name: 'scan', handler: () => console.log('Scanning...') });

try {
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    process.exitCode = 1;
  } else if (error instanceof CommandLineErrorHandlerError) {
    process.exitCode = 2;
  } else {
    throw error;
  }
}
```

```bash
# node audit-cli.js scan --unknown
#   → audit-cli rejected the invocation [VALIDATION_FAILED]
#   → exit code 1 (set by the caller)
```

### Handling a Failed Error Handler

If the presentation hook throws or rejects, execution rejects with `CommandLineErrorHandlerError`, which preserves both the original parser failure (`parserError`) and the hook failure (`handlerError`).

```typescript
import { CommandLineErrorHandlerError, CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'audit-cli',
  strict: true,
  errorHandler: () => {
    throw new Error('diagnostics channel unavailable');
  },
});

parser.addCommand({ name: 'scan', handler: () => console.log('Scanning...') });

try {
  await parser.execute(undefined, { argv: ['scan', '--unknown'] });
} catch (error) {
  if (!(error instanceof CommandLineErrorHandlerError)) {
    throw error;
  }
  console.error(`presentation failed: ${String(error.handlerError)}`);
  console.error(`original failure: ${error.parserError.code}`);
  process.exitCode = 1;
}
// Output:
// presentation failed: Error: diagnostics channel unavailable
// original failure: VALIDATION_FAILED
```

### Inspecting Every Typed Issue

`CommandLineValidationError.issues` is a frozen, deterministically ordered array: token issues in source order first, then option-validation issues in declaration order. Each issue can be narrowed by class for programmatic handling.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  InvalidOptionValueError,
  MalformedArgumentError,
  MissingRequiredOptionError,
  UnexpectedArgumentError,
  UnknownCommandError,
  UnknownOptionError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'issue-cli', strict: true }).addCommand({
  name: 'deploy',
  options: [{ name: 'retries', type: 'number', required: true }],
  handler: () => console.log('deploying'),
});

try {
  await parser.execute(undefined, {
    argv: ['deploy', '--unknown', 'plain', '--retries=not-a-number'],
    write: () => undefined,
  });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  for (const issue of error.issues) {
    if (issue instanceof UnknownOptionError) {
      console.error(`unknown option: ${issue.optionName}`);
    } else if (issue instanceof UnexpectedArgumentError) {
      console.error(`unexpected argument: ${issue.argument}`);
    } else if (issue instanceof InvalidOptionValueError) {
      console.error(`invalid value for option: ${issue.optionName}`);
    } else if (issue instanceof MissingRequiredOptionError) {
      console.error(`missing required option: ${issue.optionName}`);
    } else if (issue instanceof UnknownCommandError) {
      console.error(`unknown command: ${issue.commandName}`);
    } else if (issue instanceof MalformedArgumentError) {
      console.error(`malformed argument: ${issue.argument}`);
    } else {
      console.error(`${issue.code}: ${issue.message}`);
    }
  }
  process.exitCode = 1;
}
// Output:
// unknown option: unknown
// unexpected argument: plain
// invalid value for option: retries
```

### "Did You Mean" Suggestions

Misspelled long options and commands gain a similarity hint when a uniquely closest registered spelling exists. Hints are computed under fixed lookup and comparison budgets: only names of at least four characters and within a small edit distance participate, and a hint is shown only when the best candidate is unambiguous. The input still rejects.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'serve-cli', strict: true }).addCommand({
  name: 'serve',
  options: [{ name: 'preserve-status', type: 'boolean' }],
  handler: () => console.log('Serving...'),
});

try {
  await parser.execute(undefined, {
    argv: ['serve', '--preserve-stauts'],
    write: () => undefined,
  });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.log(error.issues.map(issue => issue.message).join('\n'));
  process.exitCode = 1;
}
// Output: Unknown option [preserve-stauts] for command [serve]. Did you mean [--preserve-status]?
```

---

## Help Output

### Clean Help Requests

With otherwise valid input, `--help` / `-h` (added automatically to every command) renders clean help and resolves without invoking the handler. Output can be captured by injecting a `write` function.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const lines: string[] = [];
const parser = new CommandLineParser({ name: 'project-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'build',
  description: 'Build the project',
  options: [
    { name: 'output', short: 'o', type: 'string', required: true, description: 'Output directory' },
  ],
  handler: options => {
    console.log(`Building into ${String(options['output'])}`);
  },
});

await parser.execute(undefined, {
  argv: ['build', '--help'],
  write: line => lines.push(line),
});

console.log(lines.join('\n'));
// Output (abridged):
// Welcome to project-cli 1.0.0
//
// Command:
//   build   Build the project
//
// Options:
//   --output | -o   Output directory   [required] [string]
//   --help | -h     Prints help and instructions for the build command. [boolean]
// The handler is not invoked: clean help resolves first.
```

### Help Never Masks Invalid Input

Strict mode rejects invalid input even when `--help` is also present — help only succeeds when every additionally supplied option is valid.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'project-cli', strict: true }).addCommand({
  name: 'build',
  options: [{ name: 'output', short: 'o', type: 'string', required: true }],
  handler: () => console.log('Building...'),
});

try {
  await parser.execute(undefined, {
    argv: ['build', '--help', '--unknown'],
    write: () => undefined,
  });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.log('Rejected because --help does not mask invalid input.');
  process.exitCode = 1;
}
// Output: Rejected because --help does not mask invalid input.
```

### Top-Level Help and skipHelp

An empty invocation without a default command renders the top-level command list and resolves. Setting `skipHelp: true` removes the automatic help option entirely: strict mode then treats `--help` / `-h` as unknown options (still failing closed), while legacy mode continues permissively. Short `h` also becomes available for custom options.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const lines: string[] = [];
const parser = new CommandLineParser({ name: 'project-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'build',
  description: 'Build the project',
  handler: () => console.log('Building...'),
});

parser.addCommand({
  name: 'check',
  description: 'Type-check the project',
  handler: () => console.log('Checking...'),
});

// No command, no default: renders the top-level command list and resolves.
await parser.execute(undefined, { argv: [], write: line => lines.push(line) });

console.log(lines.join('\n'));
// Output (abridged):
// Welcome to project-cli 1.0.0
//
// Commands:
//   build   Build the project
//   check   Type-check the project
```

---

## Testing and Embedding

### Unit Testing a Command Handler

Inject `argv` to drive the parser deterministically, pass a `write: () => undefined` collector to silence help rendering, and assert on handler calls or typed rejections.

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

describe('deploy command', () => {
  it('passes converted values to the handler', async () => {
    const handler = vi.fn();
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'deploy',
      options: [{ name: 'output', type: 'string', required: true }],
      handler,
    });

    await parser.execute(undefined, { argv: ['deploy', '--output', 'release'] });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: 'release' }));
  });

  it('rejects invalid input without invoking the handler', async () => {
    const handler = vi.fn();
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'deploy',
      handler,
    });

    await expect(
      parser.execute(undefined, { argv: ['deploy', '--unknown'], write: () => undefined })
    ).rejects.toBeInstanceOf(CommandLineValidationError);
    expect(handler).not.toHaveBeenCalled();
  });
});
// Both tests pass.
```

### Reusing One Parser Across Invocations

Parsed values, defaults, multiple-value arrays, and help state are rebuilt for every invocation — nothing leaks between runs, and `process.argv` stays untouched when `argv` is provided.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const observed: string[] = [];
const parser = new CommandLineParser({ name: 'tools-cli', strict: true }).addCommand({
  name: 'show',
  options: [{ name: 'value', type: 'string', required: true }],
  handler: options => {
    observed.push(String(options['value']));
  },
});

await parser.execute(undefined, { argv: ['show', '--value', 'first'] });
await parser.execute(undefined, { argv: ['show', '--value', 'second'] });

console.log(observed.join(','));
// Output: first,second
```

---

## Complete Applications

### A Complete Strict CLI

A deployer that combines global options, aliases, choices, conflicts, dependencies, a custom `errorHandler`, and caller-owned exit policy — the full strict-mode contract in one runnable program.

```typescript
import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deployer',
  version: '2.1.0',
  strict: true,
  globalOptions: [
    { name: 'profile', short: 'p', type: 'string', default: 'default' },
    { name: 'verbose', short: 'v', type: 'boolean' },
  ],
  errorHandler: error => {
    console.error(`deployer: ${error.code}`);
    console.error(error.message);
  },
});

parser.addCommand({
  name: 'deploy',
  description: 'Deploy the application to an environment',
  aliases: ['ship', 'release'],
  options: [
    {
      name: 'environment',
      short: 'e',
      type: 'string',
      required: true,
      choices: ['dev', 'staging', 'production'],
    },
    { name: 'force', type: 'boolean', conflicts: ['check'] },
    { name: 'check', type: 'boolean' },
    { name: 'token', type: 'string' },
    { name: 'upload', type: 'boolean', depends: ['token'] },
  ],
  handler: options => {
    const environment = String(options['environment']);
    const profile = String(options['profile']);
    const verbose = options['verbose'] === true;
    const force = options['force'] === true;
    if (verbose) {
      console.log(`[profile=${profile}] preparing deployment`);
    }
    console.log(`Deployed to ${environment}${force ? ' (forced)' : ''}.`);
  },
});

parser.addCommand({
  name: 'status',
  description: 'Show the current deployment status',
  handler: () => {
    console.log('All systems operational.');
  },
});

try {
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineErrorHandlerError) {
    console.error('The custom error presenter also failed.');
    process.exitCode = 2;
  } else if (error instanceof CommandLineValidationError) {
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

```bash
# node deployer.js ship --environment staging
#   → Deployed to staging.
#
# node deployer.js deploy --environment production -v --profile prod
#   → [profile=prod] preparing deployment
#   → Deployed to production.
#
# node deployer.js status
#   → All systems operational.
#
# node deployer.js deploy --environment moon
#   → deployer: VALIDATION_FAILED
#   → Command-line validation failed:
#     - Invalid value provided for option [environment], required one of [dev], [staging], [production], provided [moon]
#   → exit code 1 (set by the caller)
#
# node deployer.js deploy -e dev --force --check
#   → deployer: VALIDATION_FAILED
#   → Command-line validation failed:
#     - Conflicting options provided: force, check
#   → exit code 1 (set by the caller)
```

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
