import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
  ErrorCode,
  MissingRequiredOptionError,
  UnexpectedArgumentError,
  UnknownCommandError,
  UnknownOptionError,
} from '../src/index.js';

/** Replaces application arguments while retaining interpreter and script positions. */
function setArguments(...args: string[]): void {
  process.argv = ['node', 'test-cli.js', ...args];
}

/** Creates the strict parser configuration shared by diagnostic specifications. */
function createStrictParser(
  overrides: {
    errorHandler?: (error: Error) => void | Promise<void>;
    globalOptions?: Array<{ name: string; type?: 'string' | 'number' | 'boolean' }>;
  } = {}
): CommandLineParser {
  return new CommandLineParser({
    name: 'test-cli',
    version: '1.0.0',
    strict: true,
    ...overrides,
  });
}

/** Returns all built-in parser output without depending on presentation formatting. */
function renderedOutput(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map(value => String(value))
    .join(' ');
}

/** Captures the aggregate that every ordinary strict parser failure rejects with. */
async function expectValidationFailure(
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

describe('strict errors and diagnostics', () => {
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
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

  it('suggests one uniquely close registered long option while keeping the input invalid', async () => {
    // A diagnostic hint never corrects the spelling or permits command execution.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'preserve-status', type: 'boolean' }],
      handler,
    });
    setArguments('deploy', '--preserve-stauts');

    const error = await expectValidationFailure(parser.execute());
    const issue = error.issues.find(item => item instanceof UnknownOptionError);

    expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(issue).toBeInstanceOf(UnknownOptionError);
    expect(issue?.code).toBe(ErrorCode.UNKNOWN_OPTION);
    expect(issue?.message).toContain('Did you mean [--preserve-status]?');
    expect(renderedOutput()).toContain('Did you mean [--preserve-status]?');
    expect(handler).not.toHaveBeenCalled();
  });

  it('suggests a uniquely close command but never selects it', async () => {
    // An unknown explicit command remains rejected even when one registered spelling is nearby.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'required-value', type: 'string', required: true }],
      handler,
    });
    setArguments('deply');

    const error = await expectValidationFailure(parser.execute());

    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toBeInstanceOf(UnknownCommandError);
    expect(error.issues[0]?.message).toContain('Did you mean [deploy]?');
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves an alias spelling when it is the uniquely closest command candidate', async () => {
    // Suggestions repeat the registered presentation spelling rather than a normalized variant.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'publish',
      aliases: ['Deploy'],
      handler,
    });
    setArguments('deply');

    const error = await expectValidationFailure(parser.execute());

    expect(error.issues[0]).toBeInstanceOf(UnknownCommandError);
    expect(error.issues[0]?.message).toContain('Did you mean [Deploy]?');
    expect(handler).not.toHaveBeenCalled();
  });

  it('suggests a visible global long option in command scope', async () => {
    // Global options participate in diagnostics wherever exact recognition would accept them.
    const handler = vi.fn();
    const parser = createStrictParser({
      globalOptions: [{ name: 'preserve-status', type: 'boolean' }],
    }).addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--preserve-stauts');

    const error = await expectValidationFailure(parser.execute());

    expect(error.issues[0]?.message).toContain('Did you mean [--preserve-status]?');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not suggest a command-local option before its explicit command', async () => {
    // Diagnostic candidates mirror exact recognition scope, so later command options are not visible yet.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'preserve-status', type: 'boolean' }],
      handler,
    });
    setArguments('--preserve-stauts', 'deploy');

    const error = await expectValidationFailure(parser.execute());
    const issue = error.issues.find(item => item instanceof UnknownOptionError);

    expect(issue).toBeInstanceOf(UnknownOptionError);
    expect(issue?.message).not.toContain('Did you mean [--preserve-status]?');
    expect(handler).not.toHaveBeenCalled();
  });

  it('suggests the automatic long help option without treating it as selected', async () => {
    // Automatic help is a candidate only for diagnostics after exact help recognition fails.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--hlep');

    const error = await expectValidationFailure(parser.execute());

    expect(error.issues[0]?.message).toContain('Did you mean [--help]?');
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['names shorter than four characters', 'cat', ['car']],
    ['a distant registered name', 'omega', ['alpha']],
    ['two equally close names', 'task', ['bask', 'mask']],
  ])('omits a suggestion for %s', async (_reason, input, commandNames) => {
    // Suggestions appear only for a unique candidate inside the conservative length and distance bounds.
    const handler = vi.fn();
    const parser = createStrictParser();
    for (const name of commandNames) {
      parser.addCommand({ name, handler });
    }
    setArguments(input);

    const error = await expectValidationFailure(parser.execute());

    expect(error.issues[0]).toBeInstanceOf(UnknownCommandError);
    expect(error.issues[0]?.message).not.toContain('Did you mean');
    expect(renderedOutput()).not.toContain('Did you mean');
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['abczefgh', true],
    ['abczefgy', true],
    ['abczxfgy', false],
  ])('applies the long-name distance boundary to %s', async (input, shouldSuggest) => {
    // Eight-character candidates allow at most two edits and still require rejection.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'abcdefgh', handler });
    setArguments(input);

    const error = await expectValidationFailure(parser.execute());
    const message = error.issues[0]?.message ?? '';

    if (shouldSuggest) {
      expect(message).toContain('Did you mean [abcdefgh]?');
    } else {
      expect(message).not.toContain('Did you mean');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('skips similarity when either compared spelling exceeds the diagnostic length guard', async () => {
    // Excessively long names remain ordinary unknown input without optional similarity work.
    const candidate = `a${'b'.repeat(128)}`;
    const input = `a${'b'.repeat(127)}c`;
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: candidate, handler });
    setArguments(input);

    const error = await expectValidationFailure(parser.execute());

    expect(error.issues[0]?.message).not.toContain('Did you mean');
    expect(handler).not.toHaveBeenCalled();
  });

  it('renders built-in error and relevant help before rejecting when no hook is configured', async () => {
    // The default human-facing path remains informative while programmatic failure stays typed.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'output', type: 'string' }],
      handler,
    });
    setArguments('deploy', '--unknown');

    await expectValidationFailure(parser.execute());

    expect(renderedOutput()).toContain('unknown');
    expect(renderedOutput()).toContain('deploy');
    expect(renderedOutput()).toContain('output');
    expect(handler).not.toHaveBeenCalled();
  });

  it('awaits an asynchronous error hook once and suppresses built-in invalid-input output', async () => {
    // Rejection occurs only after custom asynchronous presentation has completed.
    const events: string[] = [];
    const errorHandler = vi.fn(async () => {
      events.push('started');
      await Promise.resolve();
      events.push('finished');
    });
    const handler = vi.fn();
    const parser = createStrictParser({ errorHandler }).addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--unknown');

    const error = await expectValidationFailure(parser.execute());

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(error);
    expect(events).toEqual(['started', 'finished']);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('invokes a synchronous error hook once before rejecting the same aggregate', async () => {
    // Synchronous custom presentation has the same replacement and rejection contract as async presentation.
    const errorHandler = vi.fn();
    const handler = vi.fn();
    const parser = createStrictParser({ errorHandler }).addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--unknown');

    const error = await expectValidationFailure(parser.execute());

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(error);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves parser and presentation failures when a synchronous hook throws', async () => {
    // A presentation failure must not erase the aggregate that originally blocked execution.
    const presentationFailure = new Error('presentation failed');
    const handler = vi.fn();
    const parser = createStrictParser({
      errorHandler: () => {
        throw presentationFailure;
      },
    }).addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--unknown');

    const rejection = await captureRejection(parser.execute());

    expect(rejection).toBeInstanceOf(CommandLineErrorHandlerError);
    if (rejection instanceof CommandLineErrorHandlerError) {
      expect(rejection.code).toBe(ErrorCode.ERROR_HANDLER_FAILED);
      expect(rejection.parserError).toBeInstanceOf(CommandLineValidationError);
      expect(rejection.handlerError).toBe(presentationFailure);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves parser and presentation failures when an asynchronous hook rejects', async () => {
    // Rejected asynchronous presentation retains both causes in one typed wrapper.
    const presentationFailure = new Error('async presentation failed');
    const handler = vi.fn();
    const parser = createStrictParser({
      errorHandler: async () => {
        throw presentationFailure;
      },
    }).addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--unknown');

    const rejection = await captureRejection(parser.execute());

    expect(rejection).toBeInstanceOf(CommandLineErrorHandlerError);
    if (rejection instanceof CommandLineErrorHandlerError) {
      expect(rejection.parserError).toBeInstanceOf(CommandLineValidationError);
      expect(rejection.handlerError).toBe(presentationFailure);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('never terminates the process for a strict parser failure', async () => {
    // The library reports failure through rejection and leaves process policy to its caller.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('The command-line library must not terminate the process');
    });
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--unknown');

    await expectValidationFailure(parser.execute());

    expect(exitSpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses the configured parser name for an unknown top-level option', async () => {
    // Top-level option errors retain useful context even when no command can be selected.
    const parser = createStrictParser();
    setArguments('--bogus');

    const error = await expectValidationFailure(parser.execute());
    const issue = error.issues.find(item => item instanceof UnknownOptionError);

    expect(issue).toBeInstanceOf(UnknownOptionError);
    if (issue instanceof UnknownOptionError) {
      expect(issue.commandName).toBe('test-cli');
    }
    expect(renderedOutput()).toContain('test-cli');
  });

  it('keeps strict command lookup exact while legacy lookup remains normalized', async () => {
    // Case folding may produce a diagnostic hint but cannot change strict validity.
    const strictHandler = vi.fn();
    const strictParser = createStrictParser().addCommand({
      name: 'Deploy',
      handler: strictHandler,
    });
    setArguments('deploy');

    const strictError = await expectValidationFailure(strictParser.execute());

    expect(strictError.issues[0]).toBeInstanceOf(UnknownCommandError);
    expect(strictError.issues[0]?.message).toContain('Did you mean [Deploy]?');
    expect(strictHandler).not.toHaveBeenCalled();

    const legacyHandler = vi.fn();
    const legacyParser = new CommandLineParser({
      name: 'test-cli',
      version: '1.0.0',
      strict: false,
    }).addCommand({ name: 'Deploy', handler: legacyHandler });
    setArguments('deploy');

    await legacyParser.execute();

    expect(legacyHandler).toHaveBeenCalledTimes(1);
  });

  it('orders token issues before registered-option validation issues', async () => {
    // Consumers can rely on raw input order first and declaration-order validation afterward.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'required-value', type: 'string', required: true }],
      handler,
    });
    setArguments('deploy', '--unknown', 'plain');

    const error = await expectValidationFailure(parser.execute());

    expect(error.issues[0]).toBeInstanceOf(UnknownOptionError);
    expect(error.issues[1]).toBeInstanceOf(UnexpectedArgumentError);
    expect(error.issues[2]).toBeInstanceOf(MissingRequiredOptionError);
    expect(handler).not.toHaveBeenCalled();
  });
});
