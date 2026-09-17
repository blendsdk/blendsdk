> **Package**: `blendsdk/cmdline`

# cmdline Best Practices

This document collects the practices that keep `blendsdk/cmdline` CLIs predictable, testable, and safe to run in automation. Every pair below shows the mistake and the correct approach side by side, followed by why the wrong version actually breaks. The anti-patterns section covers traps that appear repeatedly in the package's own compatibility and documentation tests.

---

## Do / Don't Pairs

### 1. Opt In to Strict Mode Explicitly

**❌ Wrong — relying on the permissive default**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', version: '1.0.0' });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'environment', type: 'string', required: true }],
  handler: async options => {
    console.log(`Deploying to ${String(options['environment'])}`);
  },
});

await parser.execute();
```

**✅ Correct — strict, fail-closed parsing with typed rejection**

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'environment', type: 'string', required: true }],
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
  process.exitCode = 1;
}
```

**Why**: Strict parsing is opt-in — legacy mode remains the v5 default. In legacy mode, `node deploy-cli.js deply` (misspelled command) renders help and resolves successfully, so CI and automation cannot distinguish a real run from a typo; a typo'd option on a valid command behaves the same way. With `strict: true`, recognition is exact and case-sensitive, invalid input never reaches the handler, and every failure rejects with a `CommandLineValidationError` whose `issues` array contains the concrete problems in deterministic order. In strict mode a `--help` request with otherwise valid input is a clean help request — it resolves and the handler never runs — but any invalid input still rejects and wins over help.

---

### 2. Own the Failure Policy: Typed Usage Errors vs. Handler Bugs

**❌ Wrong — one catch for everything, exit code stays 0**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  handler: async () => {
    throw new Error('database connection refused');
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy'] });
} catch (error) {
  // Prints, but the process still exits with code 0, and handler bugs
  // are indistinguishable from usage errors.
  console.error(error instanceof Error ? error.message : String(error));
}
```

**✅ Correct — separate invalid input from broken handlers**

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  handler: async () => {
    throw new Error('database connection refused');
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy'] });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    process.exitCode = 1; // invalid input: fail without a stack trace
  } else {
    throw error; // handler or environment failure: keep its stack trace
  }
}
```

**Why**: `CommandLineValidationError` means the caller supplied invalid input — a non-zero `process.exitCode` is the right signal, and the built-in help output has already explained the problem. Anything else is a handler or environment failure; rethrowing keeps the stack trace visible and prevents masking real bugs as usage errors. The library deliberately never terminates the process itself: it rejects, and the caller owns the exit policy. Do not hard-terminate inside the catch either — an immediate process termination can truncate pending asynchronous output. If you configure a custom `errorHandler` hook and the hook itself fails, execution rejects with `CommandLineErrorHandlerError`, which preserves both the original aggregate (`parserError`) and the hook failure (`handlerError`) — handle it explicitly if your hook does real work.

---

### 3. Branch on Typed Issues, Not Message Strings

**❌ Wrong — matching on human-readable text**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', short: 'o', type: 'string' }],
  handler: async options => {
    console.log(`Deploying to ${String(options['output'] ?? 'default')}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy', '--otuput=release'] });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('Unknown option')) {
    process.exitCode = 2;
  }
}
```

**✅ Correct — inspect subclasses and structured fields**

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  MissingRequiredOptionError,
  UnknownOptionError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', short: 'o', type: 'string' }],
  handler: async options => {
    console.log(`Deploying to ${String(options['output'] ?? 'default')}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy', '--otuput=release'] });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }

  for (const issue of error.issues) {
    if (issue instanceof UnknownOptionError) {
      console.error(`Unknown option [${issue.optionName}] for command [${issue.commandName}]`);
    } else if (issue instanceof MissingRequiredOptionError) {
      console.error(`Missing required option [${issue.optionName}] for command [${issue.commandName}]`);
    } else {
      console.error(issue.message);
    }
  }

  process.exitCode = 1;
}
```

**Why**: Message text is a presentation detail. It contains a similarity hint such as `Did you mean [--output]?`, and hints change with diagnostic tuning — so substring matching is brittle and can misfire on your own handler errors if texts collide. The stable programmatic surface is the error class hierarchy plus the structured fields each error exposes (`code`, `category`, `optionName`, `argument`, `commandName`, `dependencyName`, and so on), with `isCommandLineError(value)` as a general-purpose guard. The aggregate's `issues` array is copied and frozen, and its order is deterministic: token problems in original argument order first, then option-validation issues in declaration order.

---

### 4. Inject `argv` and `write` — Never Mutate `process.argv` in Tests

**❌ Wrong — global process state plus a console spy**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { CommandLineParser } from 'blendsdk/cmdline';

describe('deploy command', () => {
  it('runs the handler', async () => {
    const handler = vi.fn();
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'deploy',
      options: [{ name: 'output', short: 'o', type: 'string' }],
      handler,
    });

    process.argv = ['node', 'test-cli.js', 'deploy', '--output=release'];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await parser.execute();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: 'release' }));
    consoleSpy.mockRestore();
  });
});
```

**✅ Correct — invocation-local arguments and output capture**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

describe('deploy command', () => {
  it('runs the handler with injected arguments and captured output', async () => {
    const handler = vi.fn();
    const output: string[] = [];
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'deploy',
      options: [{ name: 'output', short: 'o', type: 'string' }],
      handler,
    });

    await parser.execute(undefined, {
      argv: ['deploy', '--output=release'],
      write: line => output.push(line),
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: 'release' }));
    expect(output).toEqual([]);
  });

  it('rejects an unknown option with a typed aggregate', async () => {
    const output: string[] = [];
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'deploy',
      options: [{ name: 'output', short: 'o', type: 'string' }],
      handler: vi.fn(),
    });

    await expect(
      parser.execute(undefined, {
        argv: ['deploy', '--otuput=release'],
        write: line => output.push(line),
      })
    ).rejects.toBeInstanceOf(CommandLineValidationError);

    expect(output.join('\n')).toContain('Did you mean [--output]?');
  });
});
```

**Why**: The parser is invocation-local by design: `execute(context, { argv, write })` reads and writes exactly through those boundaries — the tests in this repository verify that supplied `argv` is neither read from nor written to `process.argv`. Mutating `process.argv` leaks global state between test cases (a failed assertion can leave it replaced), couples assertions to console formatting, and makes tests order-dependent. Injection lets one parser instance serve every case, keeps help output inspectable as an array of lines, and lets you assert on typed rejections instead of printed text. The first argument of `execute()` is caller-owned `context`; it is merged into the handler options under `context`, which is also the right channel for programmatic state in embedded use.

---

### 5. Declare Constraints on Options Instead of Re-Validating in the Handler

**❌ Wrong — string option, manual parsing, throw inside the handler**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'retries', type: 'string' }],
  handler: async options => {
    const retries = Number(options['retries'] ?? '3');
    if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
      throw new Error('retries must be an integer between 0 and 5');
    }
    console.log(`Deploying with ${retries} retries`);
  },
});
```

**✅ Correct — declared type, default, and validator**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [
    {
      name: 'retries',
      type: 'number',
      default: 3,
      validator: value =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5
          ? true
          : 'retries must be an integer between 0 and 5',
    },
  ],
  handler: async options => {
    console.log(`Deploying with ${String(options['retries'])} retries`);
  },
});
```

**Why**: With `type: 'string'`, `--retries=abc` parses successfully and your handler becomes the first place the problem surfaces — as a thrown `Error` with a stack trace instead of a usage error, and only after application work may have started. Declared constraints are enforced before the handler runs: `type` drives conversion (`type: 'number'` receives a real number), `default` fills absent values, and the validator's message string becomes the reported error text. Validation also runs against applied defaults on every invocation, so a bad default is caught on the first run rather than on a rare path. `required` and `choices` work the same way — declare them instead of checking them yourself.

---

### 6. Use the Built-In `email` and `domain` Types Instead of Custom Regexes

**❌ Wrong — hand-rolled shorthand regex**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'invite-cli', strict: true });

parser.addCommand({
  name: 'invite',
  options: [
    {
      name: 'email',
      type: 'string',
      required: true,
      validator: value => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return typeof value === 'string' && emailRegex.test(value)
          ? true
          : 'Invalid email format';
      },
    },
  ],
  handler: async options => {
    console.log(`Inviting ${String(options['email'])}`);
  },
});
```

**✅ Correct — declared `email` type, package validators for pre-flight checks**

```typescript
import { CommandLineParser, getEmailValidationError, isValidEmail } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'invite-cli', strict: true });

parser.addCommand({
  name: 'invite',
  options: [{ name: 'email', type: 'email', required: true }],
  handler: async options => {
    const email = String(options['email']);
    if (!isValidEmail(email)) {
      throw new Error(getEmailValidationError(email));
    }
    console.log(`Inviting ${email}`);
  },
});
```

**Why**: The shorthand regex accepts many strings the built-in validator rejects — consecutive dots, leading/trailing dots in the local part, over-long local parts or domains, single-label email domains, and malformed labels. The built-in `email` and `domain` types enforce these structural rules and produce specific messages ("Email must contain exactly one @ symbol", "Domain label ... cannot exceed 63 characters") instead of a generic failure. The underlying `isValidEmail`, `isValidDomain`, `getEmailValidationError`, and `getDomainValidationError` helpers are public exports, so a handler that re-checks externally sourced values can reuse exactly the same rules — as shown above, where they add defense beyond the parser's own validation.

---

### 7. Model Cross-Option Rules with `conflicts` and `depends`

**❌ Wrong — truthiness checks that cannot see presence**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'cache', type: 'boolean', default: false },
    { name: 'refresh', type: 'boolean' },
    { name: 'upload', type: 'boolean' },
    { name: 'token', type: 'string' },
  ],
  handler: async options => {
    if (options['cache'] === true && options['refresh'] === true) {
      throw new Error('cache and refresh cannot be combined');
    }
    if (options['upload'] === true && options['token'] === undefined) {
      throw new Error('upload requires token');
    }
    console.log('Deploying');
  },
});
```

**✅ Correct — declarative relationships enforced before the handler**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'cache', type: 'boolean', conflicts: ['refresh'] },
    { name: 'refresh', type: 'boolean' },
    { name: 'upload', type: 'boolean', depends: ['token'] },
    { name: 'token', type: 'string' },
  ],
  handler: async options => {
    console.log(
      `Deploying with cache=${String(options['cache'])} refresh=${String(options['refresh'])}`
    );
  },
});
```

**Why**: Relationship checks are presence-based, not value-based, and manual truthiness checks get both directions wrong. `--cache=false --refresh=false` is still a conflict, because an explicitly supplied `false` counts as supplied; a value that appears only because of its `default` never activates its owner's `conflicts`. For `depends`, a dependency is satisfied by an explicit value (including `false`) or a configured default. In strict mode these rules surface as `ConflictingOptionsError` and `MissingOptionDependencyError` inside the aggregate, before the handler; in legacy mode they render help and resolve. Registration also validates the declarations: an option that both conflicts with and depends on the same name is rejected up front as `InvalidConfigurationError`.

---

### 8. Keep Validators Synchronous and Total

**❌ Wrong — a validator that throws on malformed input**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'config-cli', strict: true });

parser.addCommand({
  name: 'apply',
  options: [
    {
      name: 'config',
      type: 'string',
      required: true,
      validator: value => {
        const parsed = JSON.parse(String(value)); // throws on malformed input
        return typeof parsed === 'object' && parsed !== null;
      },
    },
  ],
  handler: async options => {
    console.log(`Applying ${String(options['config'])}`);
  },
});
```

**✅ Correct — return `true` or a message; catch and report internally**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'config-cli', strict: true });

parser.addCommand({
  name: 'apply',
  options: [
    {
      name: 'config',
      type: 'string',
      required: true,
      validator: value => {
        if (typeof value !== 'string') {
          return 'config must be a JSON string';
        }
        try {
          const parsed: unknown = JSON.parse(value);
          return typeof parsed === 'object' && parsed !== null
            ? true
            : 'config must contain a JSON object';
        } catch {
          return 'config must be valid JSON';
        }
      },
    },
  ],
  handler: async options => {
    console.log(`Applying ${String(options['config'])}`);
  },
});
```

**Why**: A validator's contract is to *return* `true`, `false`, or a message string — nothing else. A `throw` inside a validator escapes the aggregate: the strict path does not wrap validator execution, so the raw exception propagates, the `errorHandler` hook is skipped, and consumers receive an untyped error instead of a `CommandLineValidationError`. Validators are also synchronous by contract: returning a `Promise` is not `true`, so it is reported as a generic invalid value rather than awaited. Keep validators pure functions of the value; do I/O, lookups, and file access in the handler, where asynchronous errors have a proper channel.

---

### 9. Declare Cross-Cutting Flags as `globalOptions`, Not per Command

**❌ Wrong — the same flag redefined inside every command**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'deploy-cli', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'verbose', short: 'v', type: 'boolean' }],
  handler: async options => {
    console.log(`Deploying (verbose=${String(options['verbose'])})`);
  },
});

parser.addCommand({
  name: 'rollback',
  options: [{ name: 'verbose', short: 'v', type: 'boolean' }],
  handler: async options => {
    console.log(`Rolling back (verbose=${String(options['verbose'])})`);
  },
});
```

**✅ Correct — one `globalOptions` declaration, visible on both sides of the command**

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'deploy-cli',
  version: '1.0.0',
  strict: true,
  globalOptions: [{ name: 'verbose', short: 'v', type: 'boolean' }],
});

parser.addCommand({
  name: 'deploy',
  handler: async options => {
    console.log(`Deploying (verbose=${String(options['verbose'])})`);
  },
});

parser.addCommand({
  name: 'rollback',
  handler: async options => {
    console.log(`Rolling back (verbose=${String(options['verbose'])})`);
  },
});

await parser.execute(undefined, { argv: ['--verbose', 'deploy'] });
```

**Why**: Command-local options are only visible after the command token, so duplicated per-command declarations make `--verbose deploy` fail with an unknown option while `deploy --verbose` works — an inconsistency users hit immediately. Duplicated blocks also drift out of sync when one copy changes. `globalOptions` are accepted before or after every explicit command, validated once, and still keyed by canonical long name in every handler. Registration rejects a global/command long-name or short-name collision as `InvalidConfigurationError`, so a command can never silently shadow a global flag.

---

## Anti-Patterns

These mistakes recur in real usage and are pinned down by the package's own compatibility and documentation tests.

| Anti-pattern | Why it breaks | Instead |
| --- | --- | --- |
| Marking a command `default: true` when more than one command is registered | The effective default exists only for a single-command registry; adding a second command silently disables it, and an explicit unknown command never falls through to it. An empty invocation renders top-level help and runs nothing. | Keep `default: true` only in single-command CLIs, or require an explicit command. |
| Mutating configuration or command objects after `addCommand` | The parser validates and stores a defensive clone at registration; later mutations are ignored, so the running CLI no longer matches the object you edited. | Decide configuration before registration; register a new command instead of editing a live one. |
| Declaring commands or options that reuse reserved names, or claiming short `h` | `help` and `version` are reserved, and short `h` collides with automatic help; registration throws `InvalidConfigurationError`. | Rely on automatic `--help` and `-h`, or set `skipHelp: true` and own the spelling deliberately. |
| Reading `process.argv` inside a handler | Bypasses recognition and validation, defeats injected-`argv` tests, and mixes argument access with business logic. | Declare options; pass programmatic state through the `context` argument of `execute()`. |
| Expecting repeated flags to arrive as arrays without `multiple: true` | Default semantics are last-value-wins; duplicates stay observable in `occurrences`, but the handler receives a scalar. | Set `multiple: true` and consume an array. |
| Writing an `async` validator | The contract is a synchronous `boolean` or message string; a returned `Promise` is never `true` and is reported as a generic invalid value. | Keep validators pure and synchronous; do I/O in the handler. |
| Depending on legacy JSON-shaped value conversion | Legacy mode heuristically interprets value tokens, so `--id=42` can arrive as a number and then fail `type: 'string'` validation, while JSON-looking text can fail converted types. Strict mode passes literal text. | Read the raw string in the handler and parse it deliberately with error handling. |
| Expecting a `--` separator or trailing positional operands | A bare `-` or `--` is a malformed argument in both modes, and plain positional tokens become unexpected-argument issues in strict mode. | Model every input as a declared option. |

The compatibility suite asserts several of these explicitly — the disabled multi-command default, detached configuration under caller mutation, and the legacy JSON conversion — which is a good indication of how often each one appears in practice.

---

## Performance Tips

1. **Register once, execute many times.** `addCommand()` validates the new command against every registered spelling and stores a defensive clone of the configuration; `execute()` reseeds per-invocation state and builds a fresh recognition registry on each call. Both costs scale with your declared commands and options — not with input size — so build the parser at process start and reuse one instance. Await each `execute()` before starting the next one on the same instance: the parser carries per-invocation state (`currentCommand`, legacy option storage), so concurrent execution on one instance is not supported.

2. **Test in-process with injected `argv` and `write`.** Each `{ argv }` invocation runs the real recognition and validation pipeline without spawning a Node process or touching `process.argv`. A table of a hundred argument lists costs a few milliseconds each instead of a full interpreter startup per case, and cases cannot leak state into one another.

3. **Prefer strict mode for value-heavy arguments.** Strict recognition is exact map lookups plus conversion only for declared `number` and `boolean` options. Legacy mode additionally case-normalizes tokens and attempts JSON-shaped interpretation of every value token, which is extra per-argument work and can force a second validation pass when a value converts to an unexpected type. The mode you pick at startup is the mode you keep for every invocation.

4. **Keep validators cheap and hoisted.** Validators run for every supplied value and for every applied `default`, on every invocation, and `choices` membership is a linear scan per value. Compile patterns once as module-level regex literals instead of constructing `new RegExp` inside the validator, and for very large closed sets validate against a `Set` (O(1) membership) with a clear message instead of enumerating hundreds of `choices`. Never perform I/O in a validator — the contract is synchronous, and slow validators delay every parse.

5. **Let the built-in suggestion budgets do their job.** Hints are computed under fixed budgets: at most 16 distinct misspellings, 256 relevant candidates per lookup, and 512 edit-distance comparisons per invocation; candidates must be 4–128 characters, and a hint appears only for a unique best match. There is nothing to tune for safety. Marking internal or experimental options `hidden: true` keeps them out of the candidate set and out of help, so hints stay focused on user-facing flags.

The parser's hot path is a single pass over the argument list plus map lookups; the wins above come from not repeating startup work, not from micro-tuning the parse.

---

## Security Considerations

1. **Keep secrets off the command line.** Argument values are visible in OS process listings, and the parser's diagnostics echo raw input: an invalid value is reported as `provided [<value>]`, malformed and unexpected-argument errors include the full token text, and help output prints `[default:<value>]` for defaults. Read secrets from environment variables (or stdin) in the handler, or supply them programmatically through the `context` argument of `execute()`, and mark operational flags `hidden: true` so they stay out of help and suggestion output. Hidden does not redact — error text can still echo a provided value — so never route secrets through `argv` at all.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'publish-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'publish',
  options: [
    { name: 'registry', type: 'domain', required: true },
    { name: 'dry-run', type: 'boolean', hidden: true },
  ],
  handler: async options => {
    const token = process.env['PUBLISH_TOKEN'];
    if (token === undefined || token.length === 0) {
      throw new Error('PUBLISH_TOKEN is not set');
    }
    console.log(
      `Publishing to ${String(options['registry'])} (dry run: ${String(options['dry-run'] ?? false)})`
    );
  },
});
```

2. **Fail closed in automation.** Legacy mode's failure behavior is help-and-resolve, so a scheduled job can "succeed" while nothing ran, and a clean help request also resolves without running the handler — correct for humans, wrong to treat as a successful run in scripts. Use `strict: true`, translate `CommandLineValidationError` into `process.exitCode = 1`, and never swallow rejections with empty catches.

3. **The parser validates syntax, not authority.** Types, `choices`, and validators confirm shape and format; they know nothing about who is calling or what the caller may do. Enforce authorization, allowlists, path containment, and escaping for any option value you later hand to file systems, URLs, or child processes — and prefer argument-array process APIs over shell-string interpolation.

4. **Diagnostics are bounded by construction.** Suggestion lookups are capped (16 lookups, 256 candidates per lookup, 512 comparisons per invocation; names limited to 4–128 characters, unique-best only), so adversarially long or numerous misspellings cannot drive unbounded edit-distance work. Registration-time validation rejects duplicate names, reserved names, and global/command scope collisions, keeping recognition unambiguous.

5. **Treat error text as untrusted output.** Validation messages embed raw argument text and provided values. If you forward them to terminals, logs, or HTML, bound and escape them like any other user-controlled data. A custom `errorHandler` hook runs before rejection and replaces built-in output — if it fails, `CommandLineErrorHandlerError` preserves both the parser aggregate and the hook failure, so make the hook part of your failure policy rather than an afterthought.

---

# cmdline Testing Patterns

`blendsdk/cmdline` is built to be testable in-process. `execute()` accepts both the argument list (`argv`) and an output writer (`write`), the recognition pipeline is pure, and failures are reported as typed rejections instead of process termination. That means almost everything worth asserting — command selection, option conversion, validation, conflicts, help text, and error output — can be verified with real parser instances and `vi.fn()` handlers, without spawning child processes or touching the network.

---

## Test Setup

### Framework and runtime

| Item | Value |
| --- | --- |
| Test runner | Vitest 4 (`vitest`, `@vitest/coverage-v8`) |
| Runtime | Node.js >= 22, ESM only (`"type": "module"`) |
| Language | TypeScript (strict mode); Vitest transpiles, it does not type-check |
| Environment | Default Node environment — tests read and write `process.argv` and `process.exitCode` |
| Docker / external services | None. Every test runs in a single Node.js process; isolation comes from replacing `process.argv`, injecting `{ argv, write }`, and restoring global state in `afterEach` |

### Running the suite

The package scripts cover the common workflows:

| Script | Command | Purpose |
| --- | --- | --- |
| `test` | `vitest run --reporter=verbose` | Single verbose run for CI |
| `test:watch` | `vitest watch --reporter=verbose` | Watch mode during development |
| `test:coverage` | `vitest run --coverage` | V8 coverage through `@vitest/coverage-v8` |
| `build` | `tsc` | Type-check and emit `dist`; also validates `*.compile-spec.ts` files |

```bash
npm test
npm run test:watch
npm run test:coverage
```

Because Vitest only transpiles TypeScript, type-level contracts are verified by the compiler: the package keeps `tests/public-exports.compile-spec.ts`, a file that is never executed but fails `tsc` (for example during `npm run build`) if a documented export or error field disappears.

### Test file naming conventions

| Suffix | Executed by Vitest | Purpose |
| --- | --- | --- |
| `*.test.ts` | Yes | Behaviour tests through the facade or the public API |
| `*.impl.test.ts` | Yes | Focused implementation/branch coverage; may import internal modules by relative path |
| `*.spec.test.ts` | Yes | Specification-style matrices (recognition, errors, compatibility, integration) |
| `*.compile-spec.ts` | No | Compile-time contract verified by `tsc` |

The package suite follows this layout:

```text
packages/cmdline/tests/
├── argument-parser.impl.test.ts              # pure recognition unit tests
├── cmdline.test.ts                           # facade behaviour via process.argv
├── invocation.impl.test.ts                   # invocation-local argv/write, parser reuse
├── legacy-parser.impl.test.ts                # protected legacy internals
├── strict-parsing.recognition.spec.test.ts   # strict recognition matrix
├── strict-parsing.errors.spec.test.ts        # diagnostics, hooks, process policy
├── strict-parsing.compatibility.spec.test.ts # dual-mode acceptance matrix
├── strict-parsing.impl.test.ts               # configuration and invariants
├── strict-parsing.integration.spec.test.ts   # public entry point + exit policy
├── suggestions.impl.test.ts                  # similarity budgets
├── validators.test.ts                        # email/domain validators
├── public-exports.compile-spec.ts            # compile-time export contract
└── documentation.impl.test.ts                # training-page contract audit
```

### Imports

Inside the package, unit specs import sources by relative path. The `.js` extension is required because the package is ESM-only:

```typescript
// Unit spec inside packages/cmdline
import { CommandLineParser } from '../src/index.js';
import type { ICommandOption, OptionValueType } from '../src/types.js';
```

Consumers and integration specs import the public entry point:

```typescript
// Consumer project or integration spec
import {
  CommandLineParser,
  CommandLineValidationError,
  UnknownOptionError,
  type ICommandLineParser,
  type ICommandOption,
} from 'blendsdk/cmdline';
```

The supported import surface is the package root only. Deep subpath imports are not part of the public contract — the documentation contract test rejects any stale subpath import in the training pages or examples.

### Standard test lifecycle

Most spec files share the same skeleton: save the process state, install console spies, restore everything afterwards.

```typescript
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { CommandLineParser } from 'blendsdk/cmdline';

describe('my-cli', () => {
  let parser: CommandLineParser;
  let mockHandler: Mock;
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    parser = new CommandLineParser({ name: 'test-cli', version: '1.0.0', strict: true });
    mockHandler = vi.fn().mockResolvedValue(undefined);
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('forwards caller context to the command handler', async () => {
    parser.addCommand({ name: 'deploy', handler: mockHandler });

    await parser.execute({ userId: 123 }, { argv: ['deploy'] });

    expect(mockHandler).toHaveBeenCalledWith(
      expect.objectContaining({ context: { userId: 123 } })
    );
  });
});
```

Isolation checklist:

- Restore `process.argv` and `process.exitCode` in `afterEach` whenever a test mutates them.
- Spy on `console.log` / `console.error` so built-in help output is captured or suppressed, never printed.
- Create handler stubs with `vi.fn().mockResolvedValue(undefined)` so `await parser.execute()` cannot fail on an unhandled return value.
- Reset state with `vi.restoreAllMocks()` (which also restores spied implementations); `vi.clearAllMocks()` only clears recorded calls.

### Shared test helpers

The suite defines a small set of helpers per spec file. Reuse these in consumer tests to keep examples short and consistent:

```typescript
import { expect, vi } from 'vitest';

import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

/** Replaces application arguments while retaining interpreter and script positions. */
function setArguments(...args: string[]): void {
  process.argv = ['node', 'test-cli.js', ...args];
}

/** Returns all built-in parser output without depending on presentation formatting. */
function renderedOutput(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map(value => String(value))
    .join(' ');
}

/** Creates a parser whose mode is explicit so compatibility expectations cannot drift. */
function createParser(
  strict: boolean,
  overrides: {
    errorHandler?: (error: Error) => void | Promise<void>;
    globalOptions?: Array<{ name: string; type?: 'string' | 'number' | 'boolean' }>;
  } = {}
): CommandLineParser {
  return new CommandLineParser({ name: 'test-cli', version: '1.0.0', strict, ...overrides });
}

/** Captures the aggregate that every ordinary strict parser failure rejects with. */
async function expectStrictFailure(
  execution: Promise<unknown>
): Promise<CommandLineValidationError> {
  try {
    await execution;
  } catch (error) {
    expect(error).toBeInstanceOf(CommandLineValidationError);
    if (!(error instanceof CommandLineValidationError)) {
      throw error;
    }
    expect(error.issues.length).toBeGreaterThan(0);
    return error;
  }
  throw new Error('Expected strict command-line parsing to reject');
}

/** Captures a rejection whose wrapper type is asserted by the calling specification. */
async function captureRejection(execution: Promise<unknown>): Promise<unknown> {
  try {
    await execution;
  } catch (error) {
    return error;
  }
  throw new Error('Expected command-line execution to reject');
}
```

| Helper | Purpose | Notes |
| --- | --- | --- |
| `setArguments(...args)` | Replaces `process.argv` with `['node', 'test-cli.js', ...args]` | Only needed when testing the default `process.argv` path |
| `renderedOutput()` | Concatenates every `console.log` / `console.error` call into one string | Requires the console spies from the lifecycle block |
| `createParser(strict, overrides?)` | Builds a parser with `name: 'test-cli'`, `version: '1.0.0'`, and an explicit mode | `strict: false` mirrors the legacy default |
| `expectStrictFailure(execution)` | Asserts a `CommandLineValidationError` and returns it | Fails the test when execution resolves or rejects with something else |
| `captureRejection(execution)` | Returns any rejection for wrapper-type assertions | Used for `CommandLineErrorHandlerError` contracts |

### Fixture conventions

| Fixture | Value | Used for |
| --- | --- | --- |
| Parser name | `test-cli` | Diagnostics context (`UnknownOptionError.commandName`, help heading) |
| Version | `1.0.0` | Help heading |
| Command | `deploy` | Primary command in recognition tests |
| Alias | `ship` | Alias selection tests |
| Option | `output` / `-o` | Canonical string option |
| Typo fixture | `--preserve-stauts` vs `--preserve-status` | Deterministic "Did you mean" hint |
| Context objects | `{ userId: 123 }`, `{ actor: 'ci' }` | Context forwarding assertions |

---

## Unit Testing

There are two levels of unit tests: behaviour tests through the facade (the default for consumer projects and most of the package suite) and pure recognition tests over internal modules (contributors only).

### Behaviour-level unit tests through the facade

Inject `{ argv }`, stub the handler, and assert the canonical options the command received.

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser } from 'blendsdk/cmdline';

describe('deploy command', () => {
  it('converts typed options and merges caller context', async () => {
    const handler = vi.fn();
    const parser = new CommandLineParser({ name: 'test-cli', version: '1.0.0', strict: true })
      .addCommand({
        name: 'deploy',
        options: [
          { name: 'output', short: 'o', type: 'string' },
          { name: 'retries', type: 'number' },
          { name: 'force', type: 'boolean' },
        ],
        handler,
      });

    await parser.execute(
      { actor: 'ci' },
      { argv: ['deploy', '--output=release', '--retries', '3', '--force'] }
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        output: 'release',
        retries: 3,
        force: true,
        context: { actor: 'ci' },
      })
    );
  });
});
```

Use `expect.objectContaining` rather than exact object equality: the legacy path adds a `showHelp` helper to the handler options, and values you do not assert (defaults, unrelated options) should not break the test.

### Asserting typed rejection

In strict mode, execution rejects with a `CommandLineValidationError` whose `issues` array carries one typed error per problem. Prefer the `expectStrictFailure` helper, or use the explicit guard when a test is meant to document the raw contract:

```typescript
import { describe, expect, it, vi } from 'vitest';

import {
  CommandLineParser,
  CommandLineValidationError,
  ErrorCode,
  MissingRequiredOptionError,
  UnknownOptionError,
} from 'blendsdk/cmdline';

describe('deploy command', () => {
  it('rejects a misspelled option and never runs the handler', async () => {
    const handler = vi.fn();
    const parser = new CommandLineParser({ name: 'test-cli', version: '1.0.0', strict: true })
      .addCommand({
        name: 'deploy',
        options: [{ name: 'output', type: 'string', required: true }],
        handler,
      });

    try {
      await parser.execute(undefined, { argv: ['deploy', '--outpt=release'] });
      throw new Error('Expected strict execution to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandLineValidationError);
      if (!(error instanceof CommandLineValidationError)) {
        throw error;
      }

      expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(error.issues.some(issue => issue instanceof UnknownOptionError)).toBe(true);
      expect(error.issues.some(issue => issue instanceof MissingRequiredOptionError)).toBe(true);
      expect(error.issues[0]?.message).toContain('Did you mean [--output]?');
    }

    expect(handler).not.toHaveBeenCalled();
  });
});
```

The default (hook-less) strict path also renders help before rejecting; install the console spies from the lifecycle block to keep that output contained. Every other example in this document assumes the shared helpers from the Test Setup section.

### Testing pure recognition internals (contributor pattern)

Inside the package, `createArgumentRegistry()` and `parseArguments()` are tested directly. They are pure functions: no process, console, or handler side effects, and each call returns a fresh result object.

```typescript
import { describe, expect, it, vi } from 'vitest';

import { createArgumentRegistry, parseArguments } from '../src/argument-parser.js';
import type { ICommand, ICommandOption } from '../src/types.js';

/** Creates a real command definition while keeping token behavior in focus. */
function command(
  options: readonly ICommandOption[] = [],
  overrides: Partial<ICommand> = {}
): ICommand {
  return { name: 'deploy', options: [...options], handler: vi.fn(), ...overrides };
}

describe('argument parser token consumption', () => {
  it('retains source indexes for globals before a command and command options after it', () => {
    const deploy = command([{ name: 'output', short: 'o', type: 'string' }]);
    const registry = createArgumentRegistry({
      parserName: 'test-cli',
      commands: [deploy],
      globalOptions: [{ name: 'verbose', short: 'v', type: 'boolean' }],
    });

    const result = parseArguments(['--verbose', 'deploy', '--output', 'release'], registry, 'strict');

    expect(result.command).toBe(deploy);
    expect(result.commandIndex).toBe(1);
    expect(result.options).toEqual({ verbose: true, output: 'release' });
    expect(result.occurrences.map(occurrence => occurrence.index)).toEqual([0, 2]);
    expect(result.issues).toEqual([]);
  });

  it('consumes a negative decimal only for a registered numeric option', () => {
    const deploy = command([{ name: 'offset', short: 'o', type: 'number' }]);
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [deploy] });

    const result = parseArguments(['deploy', '--offset', '-2.5'], registry, 'strict');

    expect(result.options).toEqual({ offset: -2.5 });
    expect(result.issues).toEqual([]);
  });

  it('orders malformed and unexpected leftovers by their original positions', () => {
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [command()] });

    const result = parseArguments(['deploy', '--', 'extra'], registry, 'strict');

    expect(result.issues).toEqual([
      expect.objectContaining({ kind: 'malformed-argument', argument: '--', index: 1 }),
      expect.objectContaining({ kind: 'unexpected-argument', argument: 'extra', index: 2 }),
    ]);
  });
});
```

`IArgumentIssue.kind` is the stable discriminator to assert on. Each kind maps to exactly one public error at the facade:

| `kind` | Meaning | Facade error |
| --- | --- | --- |
| `malformed-argument` | `-`, `--`, invalid option spellings, missing required values | `MalformedArgumentError` |
| `unknown-command` | First plain token that is not a registered command | `UnknownCommandError` |
| `unknown-option` | Unregistered long or short option spelling | `UnknownOptionError` |
| `unexpected-argument` | Plain token left after command selection | `UnexpectedArgumentError` |

These modules are not exported from the package root, so this pattern only applies inside this repository. Consumers reach the same behaviour through the facade tests above.

---

## Integration Testing

### Importing the public entry point

Integration specs import `blendsdk/cmdline` — the published entry point — rather than a relative source path, so the test is honest about what consumers actually import. If your resolver honours the package `exports` map (which points at `./dist/index.js`), run `npm run build` before the integration run so the built output exists.

### Consumer-owned process exit policy

The library rejects on failure; the application decides what that means for the process. The integration spec asserts exactly that boundary:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

describe('strict parsing through the public package API', () => {
  it('lets the consumer catch strict rejection and own the process exit policy', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('The command-line library must not terminate the consuming process');
    });
    const handler = vi.fn();
    const parser = new CommandLineParser({
      name: 'consumer-cli',
      version: '1.0.0',
      strict: true,
    }).addCommand({ name: 'deploy', handler });

    try {
      await parser.execute(undefined, { argv: ['deploy', '--unknown'] });
    } catch (error) {
      if (!(error instanceof CommandLineValidationError)) {
        throw error;
      }
      // The application translates typed rejection into an exit code.
      process.exitCode = 1;
    }

    expect(handler).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
```

Save and restore `process.exitCode` in `beforeEach` / `afterEach`; a leaked exit code makes later failures in the same worker hard to interpret.

### Dual-mode compatibility matrix

Legacy mode remains the v5 default (`strict: false`), so behaviour that is shared between the modes is verified twice — once with `strict: true` and once with the default. A small mode table drives the whole matrix:

```typescript
import { describe, expect, it } from 'vitest';

import { CommandLineParser } from 'blendsdk/cmdline';

type ParserMode = readonly [name: string, strict: boolean];

const parserModes: readonly ParserMode[] = [
  ['strict', true],
  ['legacy', false],
];

describe('aliases and global options in both modes', () => {
  it.each(parserModes)(
    'uses an alias to invoke canonical handler state in %s mode',
    async (_mode, strict) => {
      const handler = vi.fn();
      const parser = new CommandLineParser({ name: 'test-cli', version: '1.0.0', strict })
        .addCommand({
          name: 'deploy',
          aliases: ['ship'],
          options: [{ name: 'output', type: 'string' }],
          handler,
        });

      await parser.execute(undefined, { argv: ['ship', '--output=release'] });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: 'release' }));
    }
  );

  it.each(
    parserModes.flatMap(
      ([mode, strict]) =>
        [
          [`${mode} before the command`, strict, ['-p=release', 'deploy']],
          [`${mode} after the command`, strict, ['deploy', '--profile=release']],
        ] as const
    )
  )('accepts a global option %s', async (_scenario, strict, args) => {
    const handler = vi.fn();
    const parser = new CommandLineParser({
      name: 'test-cli',
      version: '1.0.0',
      strict,
      globalOptions: [{ name: 'profile', short: 'p', type: 'string' }],
    }).addCommand({ name: 'deploy', handler });

    await parser.execute(undefined, { argv: args });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ profile: 'release' }));
  });
});
```

When asserting expectations that differ between the modes, keep the difference explicit in the test itself rather than branching inside shared helpers:

| Situation | `strict: true` | `strict: false` (v5 default) |
| --- | --- | --- |
| Unknown option or unknown short option | Rejects with `CommandLineValidationError` | Ignored; the handler still runs unless another check fails |
| Extra positional argument | Rejects (`UnexpectedArgumentError`) | Ignored |
| Missing required option | Rejects (`MissingRequiredOptionError`) | Renders help, resolves, handler does not run |
| Invalid typed/choices/validator value | Rejects (`InvalidOptionValueError`) | Renders help, resolves, handler does not run |
| Conflict or unmet dependency | Rejects (`ConflictingOptionsError` / `MissingOptionDependencyError`) | Renders help, resolves, handler does not run |
| Unknown command (no effective default) | Rejects (`UnknownCommandError`) | Renders help, resolves |
| Command spelling | Exact, case-sensitive | Case-normalized |
| Clean help request (`--help` / `-h`, nothing else invalid) | Renders help, resolves | Renders help, resolves |
| "Did you mean" hints | Included in diagnostics | Not generated |

### Optional subprocess smoke tests

The package suite never spawns child processes — anything the parser does is reproducible in-process. If your application wants a true end-to-end check of its built entry point, add a small smoke test and give it a longer timeout than the default 5 seconds:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

describe('greet-cli entry point', () => {
  it('prints the greeting', async () => {
    const { stdout } = await run(process.execPath, ['dist/cli.js', 'greet', '--name', 'Ada']);

    expect(String(stdout)).toContain('Hello, Ada!');
  });
});
```

Build first, assert with `toContain` (never on full output), and make the entry point set `process.exitCode = 1` in its catch block so `execFile` rejects on the failure path and you can assert the typed diagnostics in the rejection.

---

## Mocking & Stubbing

### Stub and spy targets

| Target | Technique | Notes |
| --- | --- | --- |
| Command handler | `vi.fn().mockResolvedValue(undefined)` typed as `Mock` | Assert canonical option keys and `context`; the handler must not run on strict failure |
| `console.log` / `console.error` | `vi.spyOn(console, 'log').mockImplementation(() => undefined)` | Suppress built-in help and assert its content with `toContain` |
| `process.exit` | `vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('...'); })` | Proves the library never terminates the process |
| `process.argv` | Save in `beforeEach`, restore in `afterEach` (or inject `{ argv }`) | Only for tests that exercise the default argument source |
| `process.exitCode` | Save in `beforeEach`, restore in `afterEach` | Asserts consumer-owned exit policy without leaking state |
| Option `validator` | `vi.fn((value: OptionValueType) => ...)` | Records calls; returning a string supplies the message asserted in help output |
| `errorHandler` hook | `vi.fn(async error => { ... })` | Proves the hook is awaited once and receives the aggregate |
| Help output | Collect with `write`, or inspect console call arguments | Assert with `toContain`, never on exact formatting |

### Handler stubs

Declare the stub once per file, not per test, so call-count assertions stay readable:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

describe('handler stubs', () => {
  let mockHandler: Mock;

  beforeEach(() => {
    mockHandler = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('records the canonical option object exactly once', async () => {
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'deploy',
      handler: mockHandler,
    });

    await parser.execute(undefined, { argv: ['deploy'] });

    expect(mockHandler).toHaveBeenCalledTimes(1);
  });
});
```

### Console and output capture

Two levels of assertions are available: probe the process console (legacy default behaviour, strict built-in help), or capture lines through the injectable writer:

```typescript
const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

await parser.execute(undefined, { argv: ['deploy', '--unknown'] });

expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('deploy'));
consoleSpy.mockRestore();
```

```typescript
const output: string[] = [];

await parser.execute(undefined, {
  argv: ['deploy', '--help'],
  write: line => output.push(line),
});

expect(output.join('\n')).toContain('Command:');
```

The `write` collector is the preferred technique for new tests: it asserts on the rendered lines without touching global console state.

### Process-state spies

`process.exit` must never fire from library code. Guard it with a spy that turns termination into a test failure:

```typescript
const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
  throw new Error('The command-line library must not terminate the consuming process');
});

await expectStrictFailure(parser.execute(undefined, { argv: ['deploy', '--unknown'] }));

expect(exitSpy).not.toHaveBeenCalled();
```

### Validator and error-handler probes

Validator stubs double as call recorders. Type the parameter as `OptionValueType` and narrow inside — that keeps the mock assignable to the option definition while still asserting the converted value:

```typescript
const validator = vi.fn((value: OptionValueType) => {
  return typeof value === 'number' && value >= 0 && value <= 100
    ? true
    : 'Value must be between 0 and 100';
});
```

```typescript
const events: string[] = [];
const errorHandler = vi.fn(async () => {
  events.push('started');
  await Promise.resolve();
  events.push('finished');
});
```

Assert that the hook ran exactly once, received the same aggregate instance that was thrown, and fully completed before the rejection propagated:

```typescript
expect(errorHandler).toHaveBeenCalledTimes(1);
expect(errorHandler).toHaveBeenCalledWith(error);
expect(events).toEqual(['started', 'finished']);
```

### What not to mock

| Don't mock | Reason |
| --- | --- |
| `CommandLineParser` itself | The parser is the unit under test; it has no external collaborators to isolate |
| Error classes | `instanceof` assertions only mean something with real instances — construct real errors or drive the parser into the failure |
| `createArgumentRegistry` / `parseArguments` (internal tests) | They are pure functions; stubbing them removes the behaviour under test |
| Help rendering | Assert presence of lines with `toContain` on collected output instead of freezing exact formatting |

---

## Test Patterns by Feature

| Feature | Primary technique | Key assertion |
| --- | --- | --- |
| Command registration & configuration | `expect(() => parser.addCommand(...)).toThrow(InvalidConfigurationError)` | Rejection happens at registration, before any parsing |
| Command selection, aliases, defaults | `it.each` over mode/argv tables | Handler runs for canonical and alias spellings; an explicit unknown command never falls back to a default |
| Option spellings & conversion | `it.each` over attached/compact/separate forms | Handler receives converted values under canonical long names |
| Multiple values | Repeated `--file=...` occurrences | Handler receives an array in source order, refreshed per invocation |
| Required options & defaults | `expectStrictFailure` plus handler assertions | `MissingRequiredOptionError`; defaults are validated like supplied values |
| Choices & validators | `vi.fn` validator probes | `InvalidOptionValueError`; choices are checked before the custom validator |
| Conflicts & dependencies | Explicit-occurrence argv | `ConflictingOptionsError` / `MissingOptionDependencyError`; an explicit `false` counts as present |
| Global options | argv with `-p` before and after the command | Values reach the handler in both modes |
| Help & output capture | Injectable `write` collector | Clean help resolves; invalid input still rejects |
| Strict diagnostics | Issue-class filters on the aggregate | Token issues in input order first, then validation issues in declaration order |
| Error handler hook | Sync/async `vi.fn` hooks | Awaited once; hook failures wrap in `CommandLineErrorHandlerError` |
| "Did you mean" suggestions | Behaviour assertions plus session budgets | Hints appear only for a unique close match inside fixed distance and length bounds |
| Defensive copies | Mutate caller objects after registration | Parser behaviour is unaffected |
| Invocation isolation | Execute one parser repeatedly | Defaults recur, arrays and required values are rebuilt |
| Validators module | Table-driven valid/invalid arrays | Boolean result plus human-readable message helpers |
| Public contract | `*.compile-spec.ts` + documentation audit | `tsc` and the docs test fail on drift |

### Command registration and configuration errors

Configuration problems are fail-fast: they throw `InvalidConfigurationError` from the constructor or `addCommand()`, long before parsing starts.

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser, InvalidConfigurationError } from 'blendsdk/cmdline';

describe('command registration', () => {
  it('rejects a command whose short option collides with automatic help', () => {
    const parser = new CommandLineParser({ name: 'test-cli', strict: true });

    expect(() =>
      parser.addCommand({
        name: 'deploy',
        options: [{ name: 'host', short: 'h' }],
        handler: vi.fn(),
      })
    ).toThrow(InvalidConfigurationError);
  });

  it('allows a short h when automatic help is disabled', () => {
    expect(() =>
      new CommandLineParser({
        name: 'test-cli',
        skipHelp: true,
        globalOptions: [{ name: 'host', short: 'h' }],
      }).addCommand({ name: 'deploy', handler: vi.fn() })
    ).not.toThrow();
  });

  it('rejects exact duplicate global long and short option names', () => {
    expect(
      () =>
        new CommandLineParser({
          name: 'test-cli',
          strict: true,
          globalOptions: [
            { name: 'profile', short: 'p' },
            { name: 'profile', short: 'p' },
          ],
        })
    ).toThrow(InvalidConfigurationError);
  });
});
```

The same `expect(...).toThrow(InvalidConfigurationError)` shape covers reserved names, duplicate commands, alias collisions (including case-normalized duplicates such as `Ship` / `ship`), global/command scope collisions, and empty `choices` arrays.

### Command selection, aliases, and defaults

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser, UnknownCommandError } from 'blendsdk/cmdline';

describe('command selection', () => {
  it('does not fall through to a default command after an explicit unknown command', async () => {
    const handler = vi.fn();
    const parser = createParser(true).addCommand({ name: 'deploy', default: true, handler });

    const error = await expectStrictFailure(parser.execute(undefined, { argv: ['deply'] }));

    expect(error.issues[0]).toBeInstanceOf(UnknownCommandError);
    expect(error.issues[0]?.message).toContain('Did you mean [deploy]?');
    expect(handler).not.toHaveBeenCalled();
  });

  it('disables an effective default when multiple commands exist', async () => {
    const defaultHandler = vi.fn();
    const otherHandler = vi.fn();
    const parser = createParser(true)
      .addCommand({ name: 'deploy', default: true, handler: defaultHandler })
      .addCommand({ name: 'inspect', handler: otherHandler });

    await parser.execute(undefined, { argv: [] });

    expect(renderedOutput()).toContain('deploy');
    expect(renderedOutput()).toContain('inspect');
    expect(defaultHandler).not.toHaveBeenCalled();
    expect(otherHandler).not.toHaveBeenCalled();
  });
});
```

The default command is effective only when exactly one command is registered. Round-trip the same scenarios through `parserModes` (see Dual-mode compatibility matrix) when the behaviour is shared with legacy mode.

### Option spellings and value conversion

Drive spelling and conversion with `it.each`. Wrap each case in an extra array so a single callback parameter receives the argument list:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser } from 'blendsdk/cmdline';

describe('option spellings', () => {
  it.each([[['--output=x']], [['--output', 'x']], [['-o=x']], [['-ox']], [['-o', 'x']]])(
    'accepts the registered string-option spelling %j',
    async args => {
      const handler = vi.fn();
      const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
        name: 'deploy',
        options: [{ name: 'output', short: 'o', type: 'string' }],
        handler,
      });

      await parser.execute(undefined, { argv: ['deploy', ...args] });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: 'x' }));
    }
  );

  it.each([
    [['--enabled'], true],
    [['--enabled=false'], false],
    [['--enabled', 'false'], false],
  ])('parses boolean input %j as %s', async (args, expected) => {
    const handler = vi.fn();
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'deploy',
      options: [{ name: 'enabled', type: 'boolean' }],
      handler,
    });

    await parser.execute(undefined, { argv: ['deploy', ...args] });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ enabled: expected }));
  });
});
```

Boundary cases worth their own tests: a negative decimal (`--offset -2.5` → `-2.5`) is consumed only by a registered `number` option; an attached empty value (`--output=`) is a supplied empty string, not a missing value; and an attached numeric value of `''` or whitespace is supplied input that then fails numeric validation. Assert those through `expectStrictFailure` with `MalformedArgumentError` or `InvalidOptionValueError` respectively.

### Multiple values and last-value semantics

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser } from 'blendsdk/cmdline';

describe('multiple values', () => {
  it('accumulates repeated values in source order only for a multiple option', async () => {
    const handler = vi.fn();
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'deploy',
      options: [
        { name: 'file', type: 'string', multiple: true },
        { name: 'output', type: 'string' },
      ],
      handler,
    });

    await parser.execute(undefined, {
      argv: ['deploy', '--output=a', '--file=one', '--output=b', '--file=two'],
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ output: 'b', file: ['one', 'two'] })
    );
  });
});
```

Without `multiple: true`, the last occurrence wins — but every occurrence is still observable to the parser, which matters for `conflicts` / `depends` (an option is "explicitly supplied" even when repeated).

### Required options and defaults

```typescript
import { describe, expect, it, vi } from 'vitest';

import {
  CommandLineParser,
  MissingRequiredOptionError,
  type OptionValueType,
} from 'blendsdk/cmdline';

describe('required options and defaults', () => {
  it('reports a missing required option before running the handler', async () => {
    const handler = vi.fn();
    const parser = createParser(true).addCommand({
      name: 'deploy',
      options: [{ name: 'output', type: 'string', required: true }],
      handler,
    });

    const error = await expectStrictFailure(parser.execute(undefined, { argv: ['deploy'] }));

    expect(error.issues.some(issue => issue instanceof MissingRequiredOptionError)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('applies defaults and validates them like supplied values', async () => {
    const validator = vi.fn((value: OptionValueType) => value === 'stable');
    const handler = vi.fn();
    const parser = createParser(true).addCommand({
      name: 'deploy',
      options: [{ name: 'mode', type: 'string', default: 'stable', validator }],
      handler,
    });

    await parser.execute(undefined, { argv: ['deploy'] });

    expect(validator).toHaveBeenCalledWith('stable');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ mode: 'stable' }));
  });
});
```

A clean help request is the exception: `--help` with otherwise valid input skips required-option and default checks (`validateAbsentOptions` is disabled for that invocation) and resolves with the rendered help.

### Choices and custom validators

Validation order is contractual: type → `choices` → custom `validator`. When choices fail, the validator must not run.

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser, InvalidOptionValueError } from 'blendsdk/cmdline';

describe('choices and validators', () => {
  it('does not call a custom validator when choices validation fails', async () => {
    const validator = vi.fn(() => true);
    const handler = vi.fn();
    const parser = createParser(true).addCommand({
      name: 'deploy',
      options: [
        { name: 'priority', type: 'string', choices: ['low', 'medium', 'high'], validator },
      ],
      handler,
    });

    const error = await expectStrictFailure(
      parser.execute(undefined, { argv: ['deploy', '--priority=urgent'] })
    );

    expect(error.issues.some(issue => issue instanceof InvalidOptionValueError)).toBe(true);
    expect(validator).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
```

Legacy mode surfaces the same validator message through help instead of a rejection — assert it with `renderedOutput()` and `expect.stringContaining(...)`.

### Conflicts and dependencies

Relationship rules are evaluated from explicit occurrences only. An explicitly supplied `false` counts as present; a default alone never activates a relationship.

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser, ConflictingOptionsError } from 'blendsdk/cmdline';

describe('conflicts and dependencies', () => {
  it('treats explicit false values as present for conflicts', async () => {
    const handler = vi.fn();
    const parser = createParser(true).addCommand({
      name: 'deploy',
      options: [
        { name: 'cache', type: 'boolean', conflicts: ['refresh'] },
        { name: 'refresh', type: 'boolean' },
      ],
      handler,
    });

    const error = await expectStrictFailure(
      parser.execute(undefined, { argv: ['deploy', '--cache=false', '--refresh=false'] })
    );

    expect(error.issues.filter(issue => issue instanceof ConflictingOptionsError)).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not activate a dependency from a default-only owner', async () => {
    const handler = vi.fn();
    const parser = createParser(true).addCommand({
      name: 'deploy',
      options: [
        {
          name: 'cache',
          type: 'boolean',
          default: false,
          conflicts: ['refresh'],
          depends: ['token'],
        },
        { name: 'refresh', type: 'boolean' },
        { name: 'token', type: 'string' },
      ],
      handler,
    });

    await parser.execute(undefined, { argv: ['deploy', '--refresh'] });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ cache: false, refresh: true }));
  });
});
```

For deterministic ordering assertions, filter with a type predicate and compare the mapped pairs:

```typescript
const conflicts = error.issues.filter(
  (issue): issue is ConflictingOptionsError => issue instanceof ConflictingOptionsError
);
expect(conflicts.map(issue => issue.conflictingOptions)).toEqual([
  ['alpha', 'gamma'],
  ['alpha', 'beta'],
]);
```

### Global options

Global options are accepted before and after an explicit command and reach the handler under their canonical long names:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser } from 'blendsdk/cmdline';

describe('global options', () => {
  it.each([
    ['before the command', ['-p=release', 'deploy']],
    ['after the command', ['deploy', '--profile=release']],
  ])('accepts a global option %s', async (_position, args) => {
    const handler = vi.fn();
    const parser = new CommandLineParser({
      name: 'test-cli',
      version: '1.0.0',
      strict: true,
      globalOptions: [{ name: 'profile', short: 'p', type: 'string' }],
    }).addCommand({ name: 'deploy', handler });

    await parser.execute(undefined, { argv: args });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ profile: 'release' }));
  });
});
```

Registration-time collision checks (global vs. command long/short names) belong in this feature's negative tests — assert them with `toThrow(InvalidConfigurationError)` as in the registration pattern.

### Help requests and clean help output

A clean help request (`--help` / `-h` and nothing else invalid) renders help and resolves; the handler never runs. Capture the lines with `write`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser, UnknownOptionError } from 'blendsdk/cmdline';

describe('help', () => {
  it('renders a clean help request through the invocation writer', async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handler = vi.fn();
    const parser = createParser(true).addCommand({
      name: 'deploy',
      options: [{ name: 'output', short: 'o', type: 'string', required: true }],
      handler,
    });

    await parser.execute(undefined, {
      argv: ['deploy', '--help'],
      write: line => output.push(line),
    });

    expect(output.join('\n')).toContain('Command:');
    expect(output.join('\n')).toContain('output');
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects invalid input even when automatic help is also requested', async () => {
    const handler = vi.fn();
    const parser = createParser(true).addCommand({ name: 'deploy', handler });

    const error = await expectStrictFailure(
      parser.execute(undefined, { argv: ['deploy', '--help', '--unknown'] })
    );

    expect(error.issues.some(issue => issue instanceof UnknownOptionError)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});
```

Help never masks an invalid token, an invalid value, a failed choice, or a failing custom validator.

### Strict diagnostics: aggregation and ordering

`CommandLineValidationError.issues` is ordered: token issues in input order first, then validation issues in option declaration order. Assert class membership per position:

```typescript
import { describe, expect, it, vi } from 'vitest';

import {
  CommandLineValidationError,
  ErrorCode,
  MissingRequiredOptionError,
  UnexpectedArgumentError,
  UnknownOptionError,
} from 'blendsdk/cmdline';

describe('strict diagnostics', () => {
  it('orders token issues before registered-option validation issues', async () => {
    const handler = vi.fn();
    const parser = createParser(true).addCommand({
      name: 'deploy',
      options: [{ name: 'required-value', type: 'string', required: true }],
      handler,
    });

    const error = await expectStrictFailure(
      parser.execute(undefined, { argv: ['deploy', '--unknown', 'plain'] })
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(error.issues[0]).toBeInstanceOf(UnknownOptionError);
    expect(error.issues[1]).toBeInstanceOf(UnexpectedArgumentError);
    expect(error.issues[2]).toBeInstanceOf(MissingRequiredOptionError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('copies and freezes aggregate issues against later caller mutation', () => {
    const source = [new UnknownOptionError('bad', 'deploy')];
    const aggregate = new CommandLineValidationError(source);

    source.push(new UnknownOptionError('later', 'deploy'));

    expect(aggregate.issues).toHaveLength(1);
    expect(Object.isFrozen(aggregate.issues)).toBe(true);
  });
});
```

Each issue also carries structured fields — `optionName`, `argument`, `commandName`, `conflictingOptions`, `dependencyName` — which are more stable to assert than message text.

### Error handler hooks

The `errorHandler` hook replaces built-in rendering, is awaited exactly once, and always precedes the rejection:

```typescript
import { describe, expect, it, vi } from 'vitest';

import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
  ErrorCode,
} from 'blendsdk/cmdline';

describe('error handler hooks', () => {
  it('awaits an asynchronous error hook once and suppresses built-in output', async () => {
    const events: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorHandler = vi.fn(async () => {
      events.push('started');
      await Promise.resolve();
      events.push('finished');
    });
    const handler = vi.fn();
    const parser = new CommandLineParser({
      name: 'test-cli',
      strict: true,
      errorHandler,
    }).addCommand({ name: 'deploy', handler });

    const error = await expectStrictFailure(
      parser.execute(undefined, { argv: ['deploy', '--unknown'] })
    );

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(error);
    expect(events).toEqual(['started', 'finished']);
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves parser and presentation failures when the hook throws', async () => {
    const presentationFailure = new Error('presentation failed');
    const handler = vi.fn();
    const parser = new CommandLineParser({
      name: 'test-cli',
      strict: true,
      errorHandler: () => {
        throw presentationFailure;
      },
    }).addCommand({ name: 'deploy', handler });

    const rejection = await captureRejection(
      parser.execute(undefined, { argv: ['deploy', '--unknown'] })
    );

    expect(rejection).toBeInstanceOf(CommandLineErrorHandlerError);
    if (rejection instanceof CommandLineErrorHandlerError) {
      expect(rejection.code).toBe(ErrorCode.ERROR_HANDLER_FAILED);
      expect(rejection.parserError).toBeInstanceOf(CommandLineValidationError);
      expect(rejection.handlerError).toBe(presentationFailure);
    }
    expect(handler).not.toHaveBeenCalled();
  });
});
```

Test both the synchronous throw and the asynchronous rejection variant — they must produce the same wrapper type.

### "Did you mean" suggestions

Behaviour-level assertions check the diagnostic message; the hint must never change recognition:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { UnknownOptionError } from 'blendsdk/cmdline';

describe('suggestions', () => {
  it('suggests one uniquely close registered long option while keeping the input invalid', async () => {
    const handler = vi.fn();
    const parser = createParser(true).addCommand({
      name: 'deploy',
      options: [{ name: 'preserve-status', type: 'boolean' }],
      handler,
    });

    const error = await expectStrictFailure(
      parser.execute(undefined, { argv: ['deploy', '--preserve-stauts'] })
    );
    const issue = error.issues.find(item => item instanceof UnknownOptionError);

    expect(issue).toBeInstanceOf(UnknownOptionError);
    expect(issue?.message).toContain('Did you mean [--preserve-status]?');
    expect(handler).not.toHaveBeenCalled();
  });
});
```

Inside the package, budgets and distance boundaries are tested over the standalone helper and a session with overridden limits:

```typescript
import { describe, expect, it } from 'vitest';

import { createSuggestionSession, findSuggestion } from '../src/suggestions.js';

describe('similarity suggestions', () => {
  it('accepts two edits only when both spellings are at least eight characters', () => {
    expect(findSuggestion('abczefgy', ['abcdefgh'])).toBe('abcdefgh');
    expect(findSuggestion('abczefg', ['abcdefgh'])).toBeUndefined();
  });

  it('returns no result when the best distance is tied', () => {
    expect(findSuggestion('task', ['bask', 'mask'])).toBeUndefined();
  });

  it('caches repeated misspellings without consuming additional comparison budget', () => {
    const session = createSuggestionSession({
      maxLookups: 2,
      maxCandidatesPerLookup: 2,
      maxComparisons: 1,
    });
    const matcher = session.createMatcher(['deploy']);

    expect(matcher.find('deply')).toBe('deploy');
    expect(matcher.find('DEPLY')).toBe('deploy');
    expect(session.getUsage()).toEqual({ lookups: 1, comparisons: 1 });
  });
});
```

The consumer-facing cases to cover through parser behaviour: unique close match, tie (no hint), names shorter than four characters (no hint), and the 128-character guard (no hint).

### Defensive copies and invocation isolation

Registration clones everything; mutate the caller objects afterwards and prove the parser is unaffected:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser } from 'blendsdk/cmdline';

describe('defensive copies', () => {
  it('detaches registered command data from caller mutation', async () => {
    const handler = vi.fn();
    const aliases = ['ship'];
    const command = {
      name: 'deploy',
      aliases,
      options: [{ name: 'output', type: 'string' as const }],
      handler,
    };
    const parser = createParser(true).addCommand(command);

    aliases.push('inspect');
    command.name = 'renamed';

    await parser.execute(undefined, { argv: ['ship', '--output=release'] });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: 'release' }));
  });
});
```

The same test shape works for parser configuration and `globalOptions`. For invocation isolation, run the same parser across success, failure, and success and assert fresh values each time:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser } from 'blendsdk/cmdline';

describe('invocation isolation', () => {
  it('rebuilds default and repeated values for every invocation', async () => {
    const handler = vi.fn();
    const parser = createParser(true).addCommand({
      name: 'deploy',
      default: true,
      options: [
        { name: 'mode', type: 'string', default: 'safe' },
        { name: 'file', type: 'string', multiple: true },
      ],
      handler,
    });

    await parser.execute(undefined, { argv: ['--file=a', '--file=b'] });
    await parser.execute(undefined, { argv: ['--file=c'] });

    expect(handler).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: 'safe', file: ['a', 'b'] })
    );
    expect(handler).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: 'safe', file: ['c'] })
    );
  });
});
```

### Email and domain validators

The `validators` module is pure and exported, so test it directly with table-driven arrays:

```typescript
import { describe, expect, it } from 'vitest';

import {
  getDomainValidationError,
  getEmailValidationError,
  isValidDomain,
  isValidEmail,
} from 'blendsdk/cmdline';

describe('validators', () => {
  it('accepts valid emails and rejects invalid ones', () => {
    const valid = ['test@example.com', 'user+tag@example.org', 'a@b.co'];
    const invalid = ['', 'invalid', 'test@example', 'test@localhost', 'test..test@example.com'];

    for (const email of valid) {
      expect(isValidEmail(email)).toBe(true);
    }
    for (const email of invalid) {
      expect(isValidEmail(email)).toBe(false);
    }
  });

  it('returns a human-readable reason for each rejection', () => {
    expect(getEmailValidationError('')).toBe('Email cannot be empty');
    expect(getEmailValidationError('invalid')).toBe('Email must contain @ symbol');
    expect(getEmailValidationError('test..test@example.com')).toBe(
      'Email cannot contain consecutive dots'
    );
  });

  it('handles domain boundaries', () => {
    expect(isValidDomain('sub.example.com')).toBe(true);
    expect(isValidDomain('localhost')).toBe(true);
    expect(isValidDomain('example.123')).toBe(false);
    expect(getDomainValidationError('example.123')).toBe(
      'Top-level domain must contain at least one letter'
    );
  });
});
```

The package's own suite additionally feeds non-string runtime inputs to exercise the `typeof` guards; those cases use deliberate casts because TypeScript's signatures already exclude them.

### Compile-time and documentation contracts

Contract regressions that runtime tests cannot catch are covered by a compile-spec file that is never executed — it simply has to type-check. Referencing exported values and annotating documented fields is enough to fail `tsc` on removal:

```typescript
import {
  CommandLineError,
  CommandLineErrorHandlerError,
  CommandLineValidationError,
  ErrorCode,
  type ICommandLineParser,
} from 'blendsdk/cmdline';

/** A consumer can opt into strict parsing and perform asynchronous error presentation. */
const strictConfig: ICommandLineParser = {
  name: 'compile-contract-cli',
  strict: true,
  errorHandler: async error => {
    const code: string = error.code;
    void code;
  },
};

/** Referencing the class values proves that every constructor is publicly exported. */
const publicErrorConstructors = {
  CommandLineValidationError,
  CommandLineErrorHandlerError,
};

/** Every strict discriminator is available for exhaustive programmatic handling. */
const strictErrorCodes: readonly ErrorCode[] = [
  ErrorCode.VALIDATION_FAILED,
  ErrorCode.UNEXPECTED_ARGUMENT,
  ErrorCode.MISSING_OPTION_DEPENDENCY,
  ErrorCode.ERROR_HANDLER_FAILED,
];

/** Reading documented fields keeps the public error shape part of the contract. */
function describeIssue(error: CommandLineError): string {
  return `${error.code}: ${error.message}`;
}

void strictConfig;
void publicErrorConstructors;
void strictErrorCodes;
void describeIssue;
```

The training pages themselves are audited by a documentation contract test that reads the package-owned markdown and asserts both required phrases (strict rejection, clean help, caller exit policy) and forbidden patterns:

```typescript
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Package-owned training pages audited for the strict parsing contract. */
const trainingPages = ['00-overview.md', '06-testing-patterns.md'] as const;

function trainingPage(name: (typeof trainingPages)[number]): string {
  return readFileSync(new URL(`../ai-training/${name}`, import.meta.url), 'utf8');
}

describe('cmdline package documentation contract', () => {
  it('keeps strict rejection, clean help, and caller exit policy aligned', () => {
    const corpus = trainingPages.map(trainingPage).join('\n');

    expect(corpus).toContain('strict: true');
    expect(corpus).toContain('CommandLineValidationError');
    expect(corpus).toContain('process.exitCode');
    expect(corpus).toContain('clean help');
  });
});
```

The full audit also rejects deep subpath imports, a manually declared help option, and literal process-termination calls inside examples.

---

## Quick Reference

| Do | Don't |
| --- | --- |
| Inject `{ argv, write }` and stub `command.handler` | Mutate `process.argv` when an invocation input exists |
| Assert on canonical option keys with `expect.objectContaining` | Assert on complete option objects, help formatting, or exact message layout |
| Catch `CommandLineValidationError` and inspect `.issues` | Assert on thrown message strings when structured fields exist |
| Run shared behaviour through the `parserModes` table | Assume a change behaves the same in strict and legacy modes |
| Restore `process.argv` and `process.exitCode` in `afterEach` | Leave global state for the next test in the worker |
| Guard `process.exit` with a throwing spy | Let the library terminate the test process |
| Use real error instances and real pure functions | Mock parser internals or error classes |
| Let the application own exit policy via `process.exitCode` | Terminate the process from library-adjacent code |

---

# cmdline Troubleshooting

Failures in `blendsdk/cmdline` surface through exactly two channels, and identifying which channel you are in is the first debugging step:

1. **Registration-time throws** — `new CommandLineParser(...)` and `addCommand(...)` validate and clone configuration immediately. Bad declarations throw `InvalidConfigurationError` before any parsing happens.
2. **Invocation-time outcomes** — `execute()` either resolves (clean help, a legacy error being rendered as help, or a successful handler) or — in strict mode only — rejects with a typed `CommandLineValidationError`. In strict mode, `strict: true` means every invalid token is collected, rendered (or passed to `errorHandler`), and then rejected; the handler never runs. Remember that legacy mode remains the v5 default, so most "nothing happened" reports come from an application that never opted in.

The library never terminates the process. It rejects, and the caller decides the exit policy with `process.exitCode`.

---

## Quick Triage

| Symptom | Most likely section |
| --- | --- |
| `Invalid configuration for [...]` thrown from the constructor or `addCommand()` | Registration-time configuration errors |
| `await parser.execute()` rejects with `Command-line validation failed:` | The strict validation aggregate |
| `Unknown command [...]` / `Unknown option [...]` | Command and option recognition |
| `Malformed argument [...]` / `Unexpected argument [...]` | Token shape problems |
| `Missing required option [...]` / `Invalid value provided for option [...]` | Value validation |
| Help text prints, `execute()` resolves `undefined`, handler never runs | Legacy error path or a clean help request |
| `Command-line error handler failed while presenting a parser error` | Error-presentation hook failures |
| Type errors in the consuming project | TypeScript compiler errors |

---

## Common Errors

### The Strict Validation Aggregate

#### `Command-line validation failed: ...`

**Symptom**

`await parser.execute()` rejects with a message beginning `Command-line validation failed:` followed by a bulleted list of every issue from that invocation:

```text
Command-line validation failed:
- Unknown option [unknown] for command [deploy]
- Unexpected argument [plain] for command [deploy]
- Missing required option [output] for command [deploy]
```

**Cause**

This is the intended contract of strict mode, not a defect. Every parser-owned problem is collected into one aggregate. Issue order is deterministic: token issues first, in original argument order, then option validation issues in declaration order, then relationship issues (deduplicated). When an unknown command prevented selection, registered-option validation is skipped entirely, so the aggregate contains only the command issue.

**Fix**

Catch the rejection, narrow with `instanceof`, iterate `error.issues` (a frozen array of typed `CommandLineError` objects), and set the exit code yourself.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', type: 'string', required: true }],
  handler: async options => {
    console.log(`Deploying to ${String(options['output'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy', '--unknown', 'plain'] });
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  for (const issue of error.issues) {
    console.error(`${issue.code} (${issue.category}): ${issue.message}`);
  }
  process.exitCode = 1;
}
```

Never build an empty aggregate: `new CommandLineValidationError([])` throws `TypeError: Command-line validation requires at least one issue`.

#### Handler never runs; only help text is printed and `execute()` resolves

**Symptom**

The promise resolves to `undefined`, help text appears, and the handler is not invoked. There is nothing to catch.

**Cause**

Three distinct situations produce this:

- **Legacy mode** (the default, `strict: false`): missing required options, invalid values, unknown commands, malformed tokens, and help requests all render help and resolve. This is the historic help-and-resolve compatibility path.
- **A clean help request in strict mode**: `--help` / `-h` with everything else valid renders help and resolves intentionally. A clean help request succeeds even when required options are absent — absent-option checks are skipped — but any *supplied* value that fails type, choices, validator, conflict, or dependency checks still rejects.
- **No command selected**: an empty invocation where no effective default command exists renders top-level help.

**Fix**

Decide the contract each application wants and make it explicit. For automation and CI, opt into strict mode and treat rejection as the failure signal:

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

function createParser(strict: boolean): CommandLineParser {
  return new CommandLineParser({ name: 'mode-cli', version: '1.0.0', strict }).addCommand({
    name: 'deploy',
    options: [{ name: 'output', type: 'string', required: true }],
    handler: async options => {
      console.log(`handler ran with ${String(options['output'])}`);
    },
  });
}

try {
  await createParser(true).execute(undefined, { argv: ['deploy'], write: () => undefined });
} catch {
  console.log('strict rejected; handler never ran');
}

await createParser(false).execute(undefined, { argv: ['deploy'], write: () => undefined });
console.log('legacy resolved after printing help; handler never ran');

try {
  await createParser(true).execute(undefined, { argv: ['deploy', '--output=release'] });
  console.log('strict accepted; handler ran');
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

### Command Recognition

#### `Unknown command [deply]. Available commands: deploy Did you mean [deploy]?`

**Symptom**

Strict-mode rejection with issue code `UNKNOWN_COMMAND` and category `PARSING`. The `UnknownCommandError` exposes `commandName` and `availableCommands`. The hint appears as `Did you mean [deploy]?` and repeats the *registered presentation spelling* (including alias casing such as `[Deploy]`).

**Cause**

Strict command lookup is exact and case-sensitive: a command declared as `Deploy` is not reachable as `deploy`. Aliases are exact in strict mode and case-normalized in legacy mode. The suggestion is diagnostic only — it never corrects the spelling or selects a command.

**Fix**

Use the declared spelling, or register the spellings your users will type as aliases.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'Deploy',
  aliases: ['deploy', 'ship'],
  handler: async () => {
    console.log('deploying');
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy'] });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    for (const issue of error.issues) {
      console.error(issue.message);
    }
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

### Option Recognition

#### `Unknown option [preserve-stauts] for command [deploy]. Did you mean [--preserve-status]?`

**Symptom**

Strict-mode rejection with issue code `UNKNOWN_OPTION`. Short options produce `Unknown option [x] for command [deploy]` with no hint.

**Cause**

The option is not visible in the scope where the token appears. Four common situations:

1. Misspelled or wrong case — strict long/short lookup is exact.
2. A command-local option used *before* the explicit command token — only global options are visible there.
3. The option belongs to a different command (or was never registered).
4. `skipHelp: true` removed the automatic help option, so `--help` / `-h` are themselves unknown in strict mode.

An option declared with `hidden: true` is still recognized — hiding only removes it from help output and suggestion candidates.

**Fix**

Verify the scope and the position of the token. Command options belong after the command; anything that must appear anywhere should be a global option.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'tri-cli',
  version: '1.0.0',
  strict: true,
  globalOptions: [{ name: 'profile', short: 'p', type: 'string' }],
});

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'output', type: 'string' },
    { name: 'preserve-status', type: 'boolean' },
  ],
  handler: async options => {
    console.log(options);
  },
});

// Works: global before the command, command-local after it
await parser.execute(undefined, { argv: ['-p=release', 'deploy', '--output=dist'] });

// Fails: --output is command-local and appears before the command token
try {
  await parser.execute(undefined, { argv: ['--output=dist', 'deploy'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    console.error(error.issues[0]?.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

Demonstrating the `skipHelp` case:

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const strictNoHelp = new CommandLineParser({
  name: 'tri-cli',
  version: '1.0.0',
  strict: true,
  skipHelp: true,
}).addCommand({ name: 'deploy', handler: async () => console.log('ran') });

try {
  await strictNoHelp.execute(undefined, { argv: ['deploy', '--help'], write: () => undefined });
} catch (error) {
  // Unknown option [help] for command [deploy]
  if (error instanceof CommandLineValidationError) {
    console.error(error.issues[0]?.message);
  }
}

const legacyNoHelp = new CommandLineParser({
  name: 'tri-cli',
  version: '1.0.0',
  strict: false,
  skipHelp: true,
}).addCommand({ name: 'deploy', handler: async () => console.log('ran') });

// Legacy mode ignores the unknown option and runs the handler
await legacyNoHelp.execute(undefined, { argv: ['deploy', '--help'] });
```

### Token Shape Problems

#### `Malformed argument [--output]: Option [output] requires a value`

**Symptom**

Strict-mode rejection with issue code `MALFORMED_ARGUMENT`. The issue carries `optionName: 'output'`.

**Cause**

A non-boolean option consumed no value. This happens when the option is the last token, or when the next token is option-shaped (for example another option) and was not consumed as a negative numeric value of a registered `number` option. The parser never borrows an option-looking token as a value.

**Fix**

Supply the value attached (`--output=release`) or as the immediately following token (`--output release`), and keep other options out of that slot.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'output', type: 'string' },
    { name: 'force', type: 'boolean' },
  ],
  handler: async options => {
    console.log(`${String(options['output'])} force=${String(options['force'])}`);
  },
});

try {
  // Fails: --force cannot be consumed as the value of --output
  await parser.execute(undefined, { argv: ['deploy', '--output', '--force'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    // Malformed argument [--output]: Option [output] requires a value
    console.error(error.issues[0]?.message);
  }
}

// Fix: attach the value, or place it before the next option
await parser.execute(undefined, { argv: ['deploy', '--output=release', '--force'] });
await parser.execute(undefined, { argv: ['deploy', '--output', 'release', '--force'] });
```

#### `Malformed argument [--]: Invalid option format`

**Symptom**

A bare `-` or `--` is reported malformed. In strict mode the invocation rejects; in legacy mode the error message is rendered as help and `execute()` resolves.

**Cause**

There is no end-of-options or passthrough semantics. `-` and `--` are never valid tokens. Any plain token after them becomes a separate `Unexpected argument` issue, in original input order.

**Fix**

Remove the marker. Model repeated operands as a real option with `multiple: true`.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'copy',
  options: [{ name: 'path', type: 'string', multiple: true }],
  handler: async options => {
    console.log(options['path']);
  },
});

await parser.execute(undefined, { argv: ['copy', '--path=a', '--path=b'] });
```

#### `Malformed argument [--1bad]: Invalid option name format`

**Cause**

Long option names must match `/^[a-zA-Z][a-zA-Z0-9_-]*$/`; short names must be a single ASCII letter. The only exception is a negative decimal number (`-3`, `-2.5`), which is never treated as an option token.

**Fix**

Rename the option to start with a letter. Keep names free of `=`, `.`, `$`, and leading digits.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'level-2-target', type: 'string' }],
  handler: async options => {
    console.log(String(options['level-2-target']));
  },
});

await parser.execute(undefined, { argv: ['deploy', '--level-2-target=edge'] });
```

#### `Unexpected argument [extra] for command [deploy]`

**Cause**

A plain token remained after all supported tokens were consumed. Positional operands are not supported; they are always strict-mode errors. Also produced as the leftover of a boolean followed by non-literal text: `--enabled maybe` sets `enabled` to `true` and leaves `maybe` behind as an unexpected argument.

**Fix**

Convert operands into options, and pass boolean values as the bare flag, `true`/`false`, or `--flag=true` / `--flag=false`.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'target', type: 'string' },
    { name: 'enabled', type: 'boolean' },
  ],
  handler: async options => {
    console.log(`${String(options['target'])} enabled=${String(options['enabled'])}`);
  },
});

try {
  // Fails twice: 'extra' is unexpected, and 'maybe' is not a boolean literal
  await parser.execute(undefined, { argv: ['deploy', '--enabled', 'maybe', 'extra'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    console.error(error.issues.map(issue => issue.message).join('\n'));
  }
}

await parser.execute(undefined, { argv: ['deploy', '--target=edge', '--enabled=false'] });
```

### Value Validation

#### `Missing required option [output] for command [deploy]`

**Cause**

The option has `required: true` and received neither an explicit value nor a `default`. A configured default suppresses the missing-required error because defaults are applied before the required check.

**Fix**

Pass the value, give the option a default, or use help to communicate it. In strict mode, plain `deploy` rejects; `deploy --help` is a clean help request even though `output` is missing.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'output', type: 'string', required: true },
    { name: 'region', type: 'string', default: 'eu' },
  ],
  handler: async options => {
    console.log(`${String(options['output'])} in ${String(options['region'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    // Missing required option [output] for command [deploy]
    console.error(error.issues[0]?.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

#### `Invalid value provided for option [port], required number, provided [abc]`

**Symptom**

Strict-mode rejection with issue code `INVALID_OPTION_VALUE`. The `InvalidOptionValueError` exposes `optionName`, `expectedType`, and `providedValue`.

**Cause**

Conversion left the raw text in place because it was not a finite number (`Number(trimmed)` must be finite), a boolean literal, or a string as required. Note that `--count=` and `--count=   ` count as *supplied* input and then fail numeric validation; they are not treated as missing values.

**Fix**

Supply a value convertible to the declared type, or relax the declared type.

```typescript
import { CommandLineParser, CommandLineValidationError, InvalidOptionValueError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'count', type: 'number' }],
  handler: async options => {
    console.log(`count=${String(options['count'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy', '--count='], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    const issue = error.issues.find(item => item instanceof InvalidOptionValueError);
    // Invalid value provided for option [count], required number, provided []
    console.error(issue?.message);
  }
}

await parser.execute(undefined, { argv: ['deploy', '--count=0'] });
```

The same error class carries email and domain failures, with the human-readable validator text in the `expectedType` slot — for example `Invalid value provided for option [email], required Email must contain @ symbol, provided [nope]`. Email values require exactly one `@`, a dotted domain, and a TLD of at least two characters; domain values accept single labels such as `localhost`.

```typescript
import { CommandLineParser, isValidDomain, getDomainValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'mail-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'invite',
  options: [
    { name: 'email', type: 'email', required: true },
    { name: 'host', type: 'domain' },
  ],
  handler: async options => {
    console.log(`inviting ${String(options['email'])} via ${String(options['host'])}`);
  },
});

await parser.execute(undefined, { argv: ['invite', '--email=first.last@example.com', '--host=localhost'] });

// Standalone pre-flight checks reuse the same rules
if (!isValidDomain('example.123')) {
  console.error(getDomainValidationError('example.123'));
  // Top-level domain must contain at least one letter
}
```

#### `Invalid value provided for option [format], required one of [json], [yaml], provided [xml]`

**Cause**

`choices` membership is strict equality, checked after conversion, and is case-sensitive: `'json'` does not match `'JSON'`. For `number` options the supplied value is a number, so `choices` must contain numbers, not strings.

**Fix**

Align the input with the declared choices, or make the choices match the intended type.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'render',
  options: [
    { name: 'format', type: 'string', choices: ['json', 'yaml'] },
    { name: 'level', type: 'number', choices: [1, 2, 3] },
  ],
  handler: async options => {
    console.log(`${String(options['format'])} level ${String(options['level'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['render', '--format=JSON', '--level=2'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    // Invalid value provided for option [format], required one of [json], [yaml], provided [JSON]
    console.error(error.issues[0]?.message);
  }
}

await parser.execute(undefined, { argv: ['render', '--format=json', '--level=2'] });
```

#### Validator text is passed through verbatim

**Cause**

A custom `validator` returning `false` or a string fails the value. In strict mode the string becomes the `expectedType` text of an `InvalidOptionValueError`; in legacy mode the string is printed verbatim as an error line. Validators are also applied to defaults, and they are not called for absent options without defaults.

**Fix**

Return `true` for accepted values and a specific diagnostic string for rejected ones.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [
    {
      name: 'age',
      type: 'number',
      validator: value => value >= 0 && value <= 100 ? true : 'Value must be between 0 and 100',
    },
  ],
  handler: async options => {
    console.log(`age=${String(options['age'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy', '--age=150'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    // Invalid value provided for option [age], required Value must be between 0 and 100, provided [150]
    console.error(error.issues[0]?.message);
    process.exitCode = 1;
  }
}
```

#### `Conflicting options provided: quiet, verbose`

**Cause**

Both options were *explicitly supplied*. An explicit `false` counts as supplied (`--cache=false --refresh=false` conflicts when declared), while a `default` alone never activates a conflict. Reciprocal declarations are deduplicated: each pair is reported once, ordered by owner registration and declaration order.

**Fix**

Remove one of the options, or reconsider whether the relationship should be `depends` instead of `conflicts`.

```typescript
import { CommandLineParser, CommandLineValidationError, ConflictingOptionsError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'quiet', type: 'boolean', conflicts: ['verbose'] },
    { name: 'verbose', type: 'boolean' },
  ],
  handler: async options => {
    console.log(`quiet=${String(options['quiet'])} verbose=${String(options['verbose'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy', '--quiet', '--verbose'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    const issue = error.issues.find(item => item instanceof ConflictingOptionsError);
    // Conflicting options provided: quiet, verbose
    console.error(issue?.message);
  }
}

await parser.execute(undefined, { argv: ['deploy', '--quiet'] });
```

#### `Option [upload] requires option [token] for command [deploy]`

**Cause**

A declared `depends` relationship is unsatisfied. A dependency is satisfied by an explicit occurrence *or* by a configured default — including `false`. Missing dependency pairs are deduplicated and reported in owner registration and declaration order.

**Fix**

Supply the dependency (or give it a default). To make a companion truly mandatory, declare `required: true` on it as well.

```typescript
import { CommandLineParser, CommandLineValidationError, MissingOptionDependencyError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [
    { name: 'upload', type: 'boolean', depends: ['token'] },
    { name: 'token', type: 'string' },
  ],
  handler: async options => {
    console.log(`uploading with token ${String(options['token'])}`);
  },
});

try {
  await parser.execute(undefined, { argv: ['deploy', '--upload'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    const issue = error.issues.find(item => item instanceof MissingOptionDependencyError);
    // Option [upload] requires option [token] for command [deploy]
    console.error(issue?.message);
  }
}

await parser.execute(undefined, { argv: ['deploy', '--upload', '--token=abc123'] });
```

### Error Presentation

#### `Command-line error handler failed while presenting a parser error`

**Cause**

The strict `errorHandler` hook threw or rejected. Execution then rejects with a `CommandLineErrorHandlerError` whose `parserError` holds the original aggregate and whose `handlerError` holds whatever the hook threw (including non-`Error` values). Two related facts:

- Configuring `errorHandler` suppresses the built-in help rendering in strict mode. If you "lost" your help output, this is why.
- Rejection happens only *after* the hook settles, so the hook can await I/O.

**Fix**

Make the hook defensive, never rethrow from it, and inspect both causes in the caller.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  CommandLineErrorHandlerError,
  isCommandLineError,
} from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'tri-cli',
  version: '1.0.0',
  strict: true,
  errorHandler: async error => {
    if (isCommandLineError(error)) {
      console.error(`[${error.code}] ${error.message}`);
    }
    // Never rethrow here: doing so produces CommandLineErrorHandlerError
  },
});

parser.addCommand({ name: 'deploy', handler: async () => console.log('ran') });

try {
  await parser.execute(undefined, { argv: ['deploy', '--bogus'] });
} catch (error) {
  if (error instanceof CommandLineErrorHandlerError) {
    console.error(`hook failure: ${String(error.handlerError)}`);
    console.error(`original: [${error.parserError.code}] ${error.parserError.message}`);
    process.exitCode = 1;
  } else if (error instanceof CommandLineValidationError) {
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

### Registration-Time Configuration Errors

#### `Invalid configuration for [<item>]: <reason>`

**Symptom**

`new CommandLineParser(...)` or `addCommand(...)` throws `InvalidConfigurationError` with `configurationItem` and `reason` fields. A failed `addCommand()` validates *before* mutating parser state, so nothing is partially registered and you can fix the declaration and retry.

**Cause**

Registration enforces reserved names, spelling syntax, duplicate detection, collisions with automatic help, global/command scope collisions, `choices`/`default` consistency, and `conflicts` vs `depends` separation. Common reasons and their remedies:

| `configurationItem` pattern | Reason text | Remedy |
| --- | --- | --- |
| `command.name` | `Command name is required and must be a string` | provide a name |
| `command.name` | `Command name 'X' is reserved` | rename; the reserved spellings are exported as `RESERVED_COMMAND_NAMES` |
| `command.name` | `Command 'deploy' already exists` | use unique canonical names |
| `command.name` | `Command name must start with a letter and contain only letters, numbers, hyphens, and underscores` | fix the spelling |
| `command.aliases.<alias>` | `Duplicate alias 'ship' for command 'deploy'` | remove the duplicate (aliases collide case-insensitively) |
| `command.aliases.<alias>` | `Alias 'DEPLOY' already belongs to another command` | alias collides with a canonical name or alias |
| `<owner>.options.<name>.short` | `Short option 'h' conflicts with automatic help` | pick another spelling, or set `skipHelp: true` |
| `<cmd>.options.<name>` | `Option 'output' conflicts with a global option` | rename one side or promote the option |
| `<cmd>.options.<name>.short` | `Short option 'p' conflicts with a global option` | pick a distinct short spelling |
| `<cmd>.options.<name>` | `Duplicate option name 'output'` | unique names per command |
| `<cmd>.options.<name>` | `Option name 'X' is reserved` | reserved option spellings are exported as `RESERVED_OPTION_NAMES` |
| `<cmd>.options.<name>` | `Option cannot both conflict with and depend on: refresh` | split the declarations |
| `<cmd>.options.<name>.choices` | `Choices must be a non-empty array` | provide at least one choice |
| `<cmd>.options.<name>.default` | `Default value 'fast' is not in choices` | align default and choices |
| `<cmd>.options.<name>.short` | `Short option must be a single character` / `must be a letter` / `Duplicate short option 'o'` | fix the short spelling |

For global options the owner segment is `global` (for example `global.options.host.short`); for command options it is the command name.

**Fix — collision with automatic help**

Automatic help is registered per command as the long `help` plus short `h`, unless `skipHelp: true`. Short spellings are case-sensitive, so uppercase `H` is distinct.

```typescript
import { CommandLineParser, InvalidConfigurationError } from 'blendsdk/cmdline';

function createBrokenParser(): CommandLineParser {
  return new CommandLineParser({
    name: 'tri-cli',
    globalOptions: [{ name: 'host', short: 'h', type: 'string' }],
  });
}

try {
  createBrokenParser();
} catch (error) {
  if (error instanceof InvalidConfigurationError) {
    // global.options.host.short: Short option 'h' conflicts with automatic help
    console.error(`${error.configurationItem}: ${error.reason}`);
  }
}

// Fix A: keep automatic help, use a distinct spelling
const keepHelp = new CommandLineParser({
  name: 'tri-cli',
  strict: true,
  globalOptions: [{ name: 'host', short: 'H', type: 'string' }],
});

// Fix B: own the 'h' spelling and disable automatic help
const ownH = new CommandLineParser({
  name: 'tri-cli',
  strict: true,
  skipHelp: true,
  globalOptions: [{ name: 'host', short: 'h', type: 'string' }],
});
```

**Fix — global/command scope collision**

A failed `addCommand()` throws before registering, so a corrected declaration can be added afterwards.

```typescript
import { CommandLineParser, InvalidConfigurationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'tri-cli',
  strict: true,
  globalOptions: [{ name: 'profile', short: 'p', type: 'string' }],
});

try {
  parser.addCommand({
    name: 'deploy',
    options: [{ name: 'port', short: 'p', type: 'number' }],
    handler: async () => undefined,
  });
} catch (error) {
  if (error instanceof InvalidConfigurationError) {
    // deploy.options.port.short: Short option 'p' conflicts with a global option
    console.error(error.message);
  }
}

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'port', short: 'n', type: 'number' }],
  handler: async options => {
    console.log(`port=${String(options['port'])}`);
  },
});
```

### Legacy-Mode Symptoms

#### `Missing required option [output]` is printed, but nothing throws

**Cause**

In legacy mode, `execute()` catches malformed input, renders every validation error as help text, and resolves `undefined`. There is no rejection for missing required options, invalid values, choice violations, or unknown commands. Rendered output uses the headings `Errors: (deploy command)` for command-scoped failures and `Error:` for top-level failures.

**Fix**

If programmatic failure matters, opt into strict mode on that parser and catch the aggregate; otherwise assert on rendered output and handler call counts.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', type: 'string', required: true }],
  handler: async () => console.log('deployed'),
});

try {
  await parser.execute(undefined, { argv: ['deploy'] });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    // Missing required option [output] for command [deploy]
    console.error(error.issues[0]?.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

#### Unknown options are silently tolerated in legacy mode

**Cause**

Legacy validation matches registered options against tokens; a token that matches nothing is simply never reported. Unknown options and extra positional arguments do not prevent the handler from running. This is the historic permissive contract, and it is exactly what strict mode was added to change.

**Fix**

Adopt strict mode where a typo must be fatal. During migration, run both: keep the legacy parser for compatibility and add a strict canary parser in CI that executes the same argv and asserts no rejection.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const legacy = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: false }).addCommand({
  name: 'deploy',
  handler: async () => console.log('legacy ran despite --unknown'),
});

await legacy.execute(undefined, { argv: ['deploy', '--unknown'] });

const canary = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true }).addCommand({
  name: 'deploy',
  handler: async () => console.log('strict ran'),
});

try {
  await canary.execute(undefined, { argv: ['deploy', '--unknown'], write: () => undefined });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    console.error(`canary caught: ${error.issues[0]?.message}`);
    // canary caught: Unknown option [unknown] for command [deploy]
  }
}
```

#### `No command provided!` when options come before the command

**Cause**

Legacy command detection scans leading tokens and consumes only *global* options (with their values) before locating the command token. A leading unknown option, a malformed token, a bare `--`, or a command-local option before the command stops the scan — even when a valid command appears later. The parser then reports `No command provided!` (or renders help) and the handler never runs.

**Fix A:** place the command first, which is the legacy convention. **Fix B:** declare any option that must precede the command as a global option.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({
  name: 'tri-cli',
  version: '1.0.0',
  strict: false,
  globalOptions: [{ name: 'profile', short: 'p', type: 'string' }],
});

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', type: 'string' }],
  handler: async options => {
    console.log(options);
  },
});

// Works: global option value is consumed before the command token
await parser.execute(undefined, { argv: ['-p=release', 'deploy', '--output=dist'] });

// Fails: --output is command-local, so the scan stops and 'deploy' is never recognized
await parser.execute(undefined, { argv: ['--output=dist', 'deploy'] });
```

#### JSON-shaped values fail in legacy mode but pass through in strict mode

**Symptom**

Legacy mode prints a validation failure such as `Invalid value provided for option [data], required string, provided [[object Object]]`. The same input reaches a strict-mode handler as the raw string `{"key":"value"}`.

**Cause**

The legacy pipeline deliberately `JSON.parse`s token text (pass 2), so `{"key":"value"}` becomes an object that fails `string` validation. Strict conversion only converts booleans and finite numbers; everything else stays text.

**Fix**

Pick one mode and be explicit. In strict mode, keep `type: 'string'` and parse in the handler with error handling.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'send',
  options: [{ name: 'payload', type: 'string' }],
  handler: async options => {
    const raw = String(options['payload']);
    try {
      const parsed: unknown = JSON.parse(raw);
      console.log('parsed payload', parsed);
    } catch {
      console.error(`payload is not valid JSON: ${raw}`);
      process.exitCode = 1;
    }
  },
});

await parser.execute(undefined, { argv: ['send', '--payload={"key":"value"}'] });
```

### TypeScript Compiler Errors

#### `TS2307: Cannot find module 'blendsdk/cmdline' or its corresponding type declarations.`

**Cause**

The package is ESM-only (`"type": "module"`) and resolved through the `exports` field. A CommonJS-style tsconfig (`"module": "commonjs"` with classic `"moduleResolution": "node"`) ignores `exports` and cannot resolve the package.

**Fix**

Use a modern module/moduleResolution pair that understands package exports.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true
  }
}
```

#### `TS2305: Module '"blendsdk/cmdline"' has no exported member 'parseArguments'.`

**Cause**

You are importing an internal module name that appears in this repository's tests. Only four modules are public: the parser facade (`cmdline.js`), types, errors, and validators — everything re-exported from the package root. Recognition internals such as the argument parser, suggestion helpers, and strict-validation functions are not part of the public API.

**Fix**

Import from the package root and consume the documented surface: `CommandLineParser`, the error classes and enums, the type interfaces, `isCommandLineError`, and the email/domain validators.

```typescript
import {
  CommandLineParser,
  CommandLineValidationError,
  ErrorCode,
  isCommandLineError,
  isValidEmail,
  type ICommandLineParser,
} from 'blendsdk/cmdline';

const config: ICommandLineParser = { name: 'tri-cli', version: '1.0.0', strict: true };
const parser = new CommandLineParser(config);

parser.addCommand({ name: 'deploy', handler: async () => console.log('ran') });

try {
  await parser.execute(undefined, { argv: ['deploy'] });
  console.log(isValidEmail('first.last@example.com'));
} catch (error) {
  if (isCommandLineError(error) && error.code === ErrorCode.VALIDATION_FAILED) {
    console.error(error.message);
  } else if (error instanceof CommandLineValidationError) {
    console.error(error.issues.length);
  } else {
    throw error;
  }
}
```

#### `TS18046: 'error' is of type 'unknown'.`

**Cause**

Under `strict` (with `useUnknownInCatchVariables`), catch parameters are `unknown`. Accessing `error.message`, `error.issues`, or `error.code` directly fails to compile.

**Fix**

Narrow with `instanceof` or the exported `isCommandLineError` type guard before reading any field.

```typescript
import { CommandLineParser, CommandLineValidationError, isCommandLineError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });
parser.addCommand({ name: 'deploy', handler: async () => console.log('ran') });

try {
  await parser.execute(undefined, { argv: ['deploy', '--unknown'] });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    console.error(`aggregate with ${error.issues.length} issue(s)`);
  } else if (isCommandLineError(error)) {
    console.error(`single issue: ${error.code}`);
  } else {
    throw error;
  }
  process.exitCode = 1;
}
```

#### `TS4104: The type 'readonly CommandLineError[]' is 'readonly' and cannot be assigned to the mutable type 'CommandLineError[]'.`

**Cause**

`CommandLineValidationError.issues` is a frozen, readonly array by design — later rendering or hooks cannot mutate the rejection observed by the consuming application.

**Fix**

Copy it before handing it to APIs that require a mutable array.

```typescript
import { CommandLineParser, CommandLineValidationError, type CommandLineError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'tri-cli', version: '1.0.0', strict: true });
parser.addCommand({ name: 'deploy', handler: async () => console.log('ran') });

try {
  await parser.execute(undefined, { argv: ['deploy', '--unknown'] });
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    const mutable: CommandLineError[] = [...error.issues];
    console.error(mutable.map(issue => issue.code).join(', '));
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

---

## Debugging Strategies

### 1. Reproduce the invocation in-process

Never debug through the shell. Both the argument list and the output writer are injectable, so the same failing command line is reproducible inside a test or script with zero console noise.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const output: string[] = [];
const parser = new CommandLineParser({ name: 'debug-cli', version: '1.0.0', strict: true });

parser.addCommand({
  name: 'deploy',
  options: [{ name: 'output', type: 'string' }],
  handler: async options => {
    console.log(`handler ran with ${JSON.stringify(options)}`);
  },
});

try {
  await parser.execute(undefined, {
    argv: ['deploy', '--output', 'release'],
    write: line => output.push(line),
  });
  console.log('resolved cleanly');
} catch (error) {
  if (!(error instanceof CommandLineValidationError)) {
    throw error;
  }
  console.error(`rejected with ${error.issues.length} issue(s)`);
}

console.log(output.join('\n'));
```

### 2. Read the rejection in order

The aggregate's ordering is a debugging tool:

1. **Token issues** appear in original argument order. The first issue's position localizes the first bad token — issue records keep `index` from the caller's argument list in the underlying parser.
2. **Option validation issues** follow in option declaration order (required, defaults, types, choices, validators).
3. **Relationship issues** come last, deduplicated by pair.

When an unknown command blocks selection, option validation is skipped, so an aggregate with exactly one `UNKNOWN_COMMAND` issue means "fix the command spelling first, then re-run".

### 3. Classify by `code` and `category`

| `code` | `category` | Meaning | First thing to check |
| --- | --- | --- | --- |
| `VALIDATION_FAILED` | `VALIDATION` | Aggregate wrapper for one strict invocation | Iterate `error.issues` |
| `UNKNOWN_COMMAND` | `PARSING` | Explicit command not registered with that exact spelling | Case, aliases, `Did you mean` hint |
| `UNKNOWN_OPTION` | `PARSING` | Option not visible in the token's scope | Global vs command-local, token position |
| `MALFORMED_ARGUMENT` | `PARSING` | `-`, `--`, bad name shape, or missing value | Token spelling and neighboring tokens |
| `UNEXPECTED_ARGUMENT` | `PARSING` | Plain operand left after recognition | Operands are unsupported |
| `MISSING_REQUIRED_OPTION` | `VALIDATION` | Required option had no value and no default | Add a value or a default |
| `INVALID_OPTION_VALUE` | `VALIDATION` | Type, choices, or validator rejected a value | Conversion, case, choices types |
| `CONFLICTING_OPTIONS` | `VALIDATION` | Two mutually exclusive options were both explicitly supplied | Explicit `false` counts as supplied |
| `MISSING_OPTION_DEPENDENCY` | `VALIDATION` | `depends` companion absent and no default | Supply the companion |
| `ERROR_HANDLER_FAILED` | `VALIDATION` | The `errorHandler` hook threw or rejected | Inspect `parserError` and `handlerError` |
| `INVALID_CONFIGURATION` | `CONFIGURATION` | Registration-time validation failed | `configurationItem` + `reason` |

Two exported error classes — `NoCommandProvidedError` (`NO_COMMAND_PROVIDED`) and `CircularDependencyError` (`CIRCULAR_DEPENDENCY`) — exist for programmatic use, but the built-in execution pipelines in 5.x render help instead of constructing them.

### 4. Compare strict and legacy behavior with one factory

`strict` is read from the cloned configuration at construction time, so build a factory rather than mutating a shared parser.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

function createParser(strict: boolean): CommandLineParser {
  return new CommandLineParser({ name: 'compare-cli', version: '1.0.0', strict }).addCommand({
    name: 'deploy',
    options: [{ name: 'output', type: 'string', required: true }],
    handler: async options => {
      console.log(`handler: ${JSON.stringify(options)}`);
    },
  });
}

try {
  await createParser(true).execute(undefined, { argv: ['deploy'], write: () => undefined });
} catch {
  console.log('strict: rejected, handler blocked');
}

await createParser(false).execute(undefined, { argv: ['deploy'], write: () => undefined });
console.log('legacy: resolved after help, handler blocked');
```

### 5. Bisect the command line token by token

Grow the argument list one token at a time and watch the first reported issue. Because token issues preserve their original index, the length at which the first failure appears identifies the offending token.

```typescript
import { CommandLineParser, CommandLineValidationError } from 'blendsdk/cmdline';

const fullArguments = ['deploy', '--output=release', '--unknown', 'extra'];

for (let length = 1; length <= fullArguments.length; length += 1) {
  const slice = fullArguments.slice(0, length);
  const parser = new CommandLineParser({ name: 'bisect-cli', version: '1.0.0', strict: true });
  parser.addCommand({
    name: 'deploy',
    options: [{ name: 'output', type: 'string' }],
    handler: async () => undefined,
  });

  try {
    await parser.execute(undefined, { argv: slice, write: () => undefined });
    console.log(`ok   ${length}: ${slice.join(' ')}`);
  } catch (error) {
    const first = error instanceof CommandLineValidationError
      ? error.issues[0]?.message
      : String(error);
    console.error(`fail ${length}: ${slice.join(' ')} → ${first}`);
  }
}
```

### 6. Verify option visibility and token position

Work through this checklist for any `UNKNOWN_OPTION` issue:

1. Is the option declared on this command, or as a **global** option? Global options are visible before and after the command; command options only after it.
2. Where is the command token? Everything before it is checked against globals only.
3. Is strict mode on and the spelling exact? `--Profile` does not match `--profile` in strict mode; legacy folds case.
4. Is automatic help enabled? With `skipHelp: true`, `--help` and `-h` are just unknown tokens in strict mode.
5. Is the option `hidden: true`? Hidden options are still recognized — do not troubleshoot them as unregistered.

### 7. Verify registration before execution

Configuration problems are cheapest to find by wrapping registration and logging the exact fields:

```typescript
import { CommandLineParser, InvalidConfigurationError } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'register-cli', version: '1.0.0', strict: true });

try {
  parser.addCommand({
    name: 'deploy',
    aliases: ['ship'],
    options: [
      { name: 'output', type: 'string' },
      { name: 'ship', short: 'h', type: 'boolean' },
    ],
    handler: async () => console.log('ran'),
  });
} catch (error) {
  if (error instanceof InvalidConfigurationError) {
    // deploy.options.ship.short: Short option 'h' conflicts with automatic help
    console.error(`${error.configurationItem}: ${error.reason}`);
  } else {
    throw error;
  }
}
```

### 8. Verify help output and routing

If help is missing or looks wrong:

1. Pass `write: line => output.push(line)` and inspect the captured lines — the parser may be writing to the real console when you expected a collector, or the hook may have been replaced by `errorHandler` in strict mode.
2. The heading is `Welcome to <scriptName> <version>`. `scriptName` is `config.name` when set, otherwise the entry script basename; `version` defaults to `'1.0'`.
3. Legacy error output is prefixed by `Errors: (<command> command)` or `Error:`.
4. Confirm whether the invocation was a clean help request (`--help` present, everything else valid) or a legacy help-and-resolve error (an error string appears in the output).

---

## Known Pitfalls

1. **Strict mode is opt-in; legacy mode remains the v5 default.** Without `strict: true`, invalid input is rendered as help and `execute()` resolves — nothing throws. If you expected a rejection, check the mode first.

2. **A default command works only while exactly one command is registered.** Adding any second command — even a hidden one — disables the implicit default rule, and an empty invocation renders top-level help instead.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'default-cli', version: '1.0.0', strict: true });
parser.addCommand({ name: 'deploy', default: true, handler: async () => console.log('deploy') });

await parser.execute(undefined, { argv: [], write: () => undefined });
// One command → 'deploy' is the effective default and runs

parser.addCommand({ name: 'inspect', handler: async () => console.log('inspect') });
await parser.execute(undefined, { argv: [], write: () => undefined });
// Two commands → default rule disabled; help is rendered and nothing runs
```

3. **`--help` never masks invalid input.** A clean help request requires everything else to be valid. `deploy --help --count=not-a-number` rejects with `Invalid value provided for option [count], required number, provided [not-a-number]`, and `deploy --help --unknown` rejects with an `UNKNOWN_OPTION` issue. Missing required options are the one exception — help skips absent-option checks.

4. **`--version` is not automatic.** `version` is reserved for configuration display and printed in the help heading, but no version option is registered. You cannot declare one: the option name is rejected at registration.

5. **`short: 'h'` is rejected while automatic help is enabled.** Uppercase `H` is a valid distinct spelling. With `skipHelp: true`, `-h` becomes registerable — but a long option named `help`/`version` (any casing) is always rejected.

6. **A non-boolean option never borrows an option-looking token as its value.** `--output --force` is `Malformed argument [--output]: Option [output] requires a value`, not `output = '--force'`.

7. **Attached `=` supplies a value even when empty.** `--output=` is a supplied empty string, validated normally; `--output` alone is malformed. Use the distinction deliberately in validators.

8. **Booleans consume only literal `true`/`false`.** `--enabled false` works, but `--enabled maybe` leaves `maybe` as an unexpected argument while `--enabled` stays `true`; `--enabled=maybe` produces `Invalid value provided for option [enabled], required boolean, provided [maybe]`.

9. **Negative numbers are values only for `number` options.** `--offset -2.5` is consumed by a registered numeric option; `-2.5` anywhere else is not an option token, and `-1x` is `Malformed argument [-1x]: Invalid option name format`.

10. **Last value wins unless `multiple: true`.** Repeating `--output=a --output=b` yields `'b'`; only `multiple` options accumulate arrays in source order. Occurrences are retained internally for conflicts/dependencies either way.

11. **Explicit `false` counts as supplied; defaults never activate relationships.** `--cache=false --refresh=false` conflicts when declared, while `cache` carrying `default: false` does not conflict with an explicitly supplied `refresh`. A `depends` target is satisfied by an explicit occurrence *or* a default, including `false`.

12. **Command-local options before the command fail differently per mode.** Strict rejects with `Unknown option [...]`; legacy loses command recognition entirely and prints `No command provided!`. Declare such options as global options if they must lead.

13. **JSON-looking input is mode-dependent.** Legacy `JSON.parse`s token text (so a JSON object fails `string` validation with `provided [[object Object]]`); strict keeps text as text for `string` options. Parse deliberately in the handler instead of relying on implicit conversion.

14. **`execute({ argv })` is wrong.** The first parameter is the handler `context`; the invocation object (with `argv` and `write`) is the second parameter. Passing an object first runs against `process.argv` and injects your object as `options.context`.

```typescript
import { CommandLineParser } from 'blendsdk/cmdline';

const parser = new CommandLineParser({ name: 'invoke-cli', version: '1.0.0', strict: true });
parser.addCommand({
  name: 'deploy',
  handler: async options => {
    console.log(JSON.stringify(options));
  },
});

// Wrong: { argv: [...] } becomes the context; process.argv is still parsed
await parser.execute({ argv: ['deploy'] });

// Right: invocation options are the second argument
await parser.execute(undefined, { argv: ['deploy'], write: () => undefined });
```

15. **Handlers receive injected keys.** Every handler option object contains a `context` key (possibly `undefined`), and the legacy path additionally attaches a callable `showHelp`. Do not spread option objects into strict schemas without accounting for these keys.

16. **Suggestion hints are deliberately conservative.** No hint is produced for names shorter than four characters, for tied best matches, for edit distances beyond one (or two when both spellings are at least eight characters), for names longer than 128 characters, for short options, for command-local options seen before the command, or for hidden options. A missing `Did you mean` is rarely a bug.

17. **`hidden` changes presentation only.** Hidden commands and options are recognized and validated exactly like visible ones; they are excluded from help output and suggestion candidates.

18. **Strict handler options contain only supplied values and defaults.** Legacy handlers see every declared option key (with `undefined` or `[]` for absent ones); strict handlers may see no key at all. Test for absence with `options['x'] === undefined`, and prefer `default` values for stable shapes.

19. **The library never terminates the process.** It rejects (strict) or resolves after help (legacy/clean help). Ignoring the returned promise risks an unhandled rejection; treat failure policy as application code and set `process.exitCode = 1` in your catch block.

20. **Email and domain rules differ.** `type: 'domain'` accepts single-label hosts such as `localhost`; `type: 'email'` requires a dotted domain with a TLD of at least two characters, at most 64 characters in the local part, and no consecutive dots. Use the exported `isValidEmail`, `isValidDomain`, `getEmailValidationError`, and `getDomainValidationError` helpers for consistent messages outside the parser.

---

*This document applies to `blendsdk/cmdline` 5.x. All error texts quoted above are produced by the package source; exact wording may vary in future minor versions — always prefer programmatic checks such as `error.code`, `error.category`, and `isCommandLineError(error)` over string matching.*

<!-- Generated by scripts/skill/generate.ts — do not edit by hand. -->
