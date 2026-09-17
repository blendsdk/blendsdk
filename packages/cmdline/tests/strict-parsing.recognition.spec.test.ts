import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CommandLineParser,
  CommandLineValidationError,
  InvalidOptionValueError,
  MalformedArgumentError,
  MissingRequiredOptionError,
  UnexpectedArgumentError,
  UnknownCommandError,
  UnknownOptionError,
} from '../src/index.js';

/**
 * Replaces the application arguments while retaining the interpreter and script positions.
 */
function setArguments(...args: string[]): void {
  process.argv = ['node', 'test-cli.js', ...args];
}

/**
 * Returns all parser output as text without depending on its presentation formatting.
 */
function renderedOutput(): string {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .flat()
    .map(value => String(value))
    .join(' ');
}

/**
 * Captures the typed aggregate that strict parsing must reject with.
 */
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

/**
 * Creates the opt-in strict parser used by the public behavior specifications.
 */
function createStrictParser(): CommandLineParser {
  return new CommandLineParser({
    name: 'test-cli',
    version: '1.0.0',
    strict: true,
  });
}

describe('strict command recognition', () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('rejects a misspelled long option, shows command help, and blocks execution', async () => {
    // Unknown option spelling must fail closed while the registered spelling remains visible.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'preserve-status', type: 'boolean' }],
      handler,
    });
    setArguments('deploy', '--preserve-stauts');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof UnknownOptionError)).toBe(true);
    expect(renderedOutput()).toContain('deploy');
    expect(renderedOutput()).toContain('preserve-status');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an unregistered short option and blocks execution', async () => {
    // A short option is valid only when its exact one-character spelling is registered.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'deploy', handler });
    setArguments('deploy', '-x');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof UnknownOptionError)).toBe(true);
    expect(renderedOutput()).not.toContain('Did you mean');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not fall through to a default command after an explicit unknown command', async () => {
    // Explicit input always wins over default selection, even when that input is invalid.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'deploy', default: true, handler });
    setArguments('deply');

    const error = await expectStrictFailure(parser.execute());
    const issue = error.issues.find(item => item instanceof UnknownCommandError);

    expect(issue).toBeInstanceOf(UnknownCommandError);
    if (issue instanceof UnknownCommandError) {
      expect(issue.commandName).toBe('deply');
    }
    expect(renderedOutput()).toContain('test-cli');
    expect(renderedOutput()).toContain('deploy');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an unexpected positional argument and shows command help', async () => {
    // Plain tokens left after command selection are errors because no operand contract exists.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'deploy', handler });
    setArguments('deploy', 'extra');

    const error = await expectStrictFailure(parser.execute());
    const issue = error.issues.find(item => item instanceof UnexpectedArgumentError);

    expect(issue).toBeInstanceOf(UnexpectedArgumentError);
    if (issue instanceof UnexpectedArgumentError) {
      expect(issue.argument).toBe('extra');
    }
    expect(renderedOutput()).toContain('deploy');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a bare end-of-options marker as malformed input', async () => {
    // Passthrough syntax is unsupported, so a bare double dash cannot hide following input.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--');

    const error = await expectStrictFailure(parser.execute());
    const issue = error.issues.find(item => item instanceof MalformedArgumentError);

    expect(issue).toBeInstanceOf(MalformedArgumentError);
    if (issue instanceof MalformedArgumentError) {
      expect(issue.argument).toBe('--');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['--help', '-h'])('renders clean command help for %s without executing', async help => {
    // Automatic help is a successful informational request when no invalid input accompanies it.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'output', short: 'o', type: 'string', required: true }],
      handler,
    });
    setArguments('deploy', help);

    await parser.execute();

    expect(renderedOutput()).toContain('deploy');
    expect(renderedOutput()).toContain('output');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects invalid input even when automatic help is also requested', async () => {
    // Help must not mask a separate invalid token or allow command execution to continue.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--help', '--unknown');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof UnknownOptionError)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects help combined with a value of the wrong numeric type', async () => {
    // Help cannot hide a known option whose supplied value fails normal type validation.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'count', type: 'number' }],
      handler,
    });
    setArguments('deploy', '--help', '--count=not-a-number');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof InvalidOptionValueError)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects help combined with a value outside registered choices', async () => {
    // A help request succeeds only when every additionally supplied known option is valid.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'format', type: 'string', choices: ['json', 'yaml'] }],
      handler,
    });
    setArguments('deploy', '--help', '--format=xml');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof InvalidOptionValueError)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects help combined with a custom-validator failure', async () => {
    // Custom validation remains authoritative when help accompanies an otherwise known option.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'region', type: 'string', validator: () => 'Region is unavailable' }],
      handler,
    });
    setArguments('deploy', '--help', '--region=moon');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof InvalidOptionValueError)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('renders top-level help for an empty invocation without a default command', async () => {
    // An empty command line is a successful discovery request when no default can run.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'deploy', handler });
    setArguments();

    await parser.execute();

    expect(renderedOutput()).toContain('test-cli');
    expect(renderedOutput()).toContain('deploy');
    expect(handler).not.toHaveBeenCalled();
  });

  it('selects a default command only when no explicit command token is present', async () => {
    // Registered options may accompany an implicit default command and use canonical long keys.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      default: true,
      options: [{ name: 'output', short: 'o', type: 'string' }],
      handler,
    });
    setArguments('--output=release');

    await parser.execute();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: 'release' }));
  });

  it.each([[['--output=x']], [['--output', 'x']], [['-o=x']], [['-ox']], [['-o', 'x']]])(
    'accepts the registered string-option spelling %j',
    async args => {
      // Attached, separate, long, and compact short values map to the same canonical option key.
      const handler = vi.fn();
      const parser = createStrictParser().addCommand({
        name: 'deploy',
        options: [{ name: 'output', short: 'o', type: 'string' }],
        handler,
      });
      setArguments('deploy', ...args);

      await parser.execute();

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: 'x' }));
    }
  );

  it.each([
    [['--enabled'], true],
    [['--enabled=false'], false],
    [['--enabled', 'false'], false],
  ])('parses boolean input %j as %s', async (args, expected) => {
    // A bare boolean means true, while an explicit false literal must remain false.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'enabled', type: 'boolean' }],
      handler,
    });
    setArguments('deploy', ...args);

    await parser.execute();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ enabled: expected }));
  });

  it('accumulates repeated values in source order only for a multiple option', async () => {
    // Repetition preserves every supplied value when the option explicitly enables accumulation.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'file', type: 'string', multiple: true }],
      handler,
    });
    setArguments('deploy', '--file=a', '--file=b');

    await parser.execute();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ file: ['a', 'b'] }));
  });

  it('rejects a missing required option, renders help, and blocks execution', async () => {
    // Required-option validation is a strict parser failure rather than a successful no-op.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'output', type: 'string', required: true }],
      handler,
    });
    setArguments('deploy');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof MissingRequiredOptionError)).toBe(true);
    expect(renderedOutput()).toContain('output');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a value whose runtime type does not match the registered option type', async () => {
    // Type validation produces a typed issue and prevents the command from receiving invalid data.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'retries', type: 'number' }],
      handler,
    });
    setArguments('deploy', '--retries=not-a-number');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof InvalidOptionValueError)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['--count=', '--count=   '])(
    'treats attached numeric value %j as supplied but invalid',
    async argument => {
      // Empty and whitespace-only attachments are values, then normal numeric validation rejects them.
      const handler = vi.fn();
      const parser = createStrictParser().addCommand({
        name: 'deploy',
        options: [{ name: 'count', type: 'number' }],
        handler,
      });
      setArguments('deploy', argument);

      const error = await expectStrictFailure(parser.execute());

      expect(error.issues.some(issue => issue instanceof InvalidOptionValueError)).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    }
  );

  it('rejects a value outside the registered choices', async () => {
    // Choice validation is enforced before execution and reports a typed invalid-value issue.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'format', type: 'string', choices: ['json', 'yaml'] }],
      handler,
    });
    setArguments('deploy', '--format=xml');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof InvalidOptionValueError)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a value refused by its custom validator', async () => {
    // A false or explanatory validator result is a typed failure and cannot reach the handler.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'region', type: 'string', validator: () => 'Region is unavailable' }],
      handler,
    });
    setArguments('deploy', '--region=moon');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues.some(issue => issue instanceof InvalidOptionValueError)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes defaults, allowed choices, successful validation, and negative numbers', async () => {
    // Valid semantic checks produce canonical values, including a negative numeric option value.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [
        { name: 'region', type: 'string', default: 'eu', validator: value => value === 'eu' },
        { name: 'format', type: 'string', choices: ['json', 'yaml'] },
        { name: 'label', type: 'string', validator: value => value === 'stable' },
        { name: 'offset', type: 'number' },
      ],
      handler,
    });
    setArguments('deploy', '--format=json', '--label=stable', '--offset', '-2');

    await parser.execute();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'eu', format: 'json', label: 'stable', offset: -2 })
    );
  });

  it('preserves source order when an unknown option is followed by a plain token', async () => {
    // Unknown options consume nothing, so the following plain token remains a separate issue.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({ name: 'deploy', handler });
    setArguments('deploy', '--unknown', 'plain');

    const error = await expectStrictFailure(parser.execute());

    expect(error.issues[0]).toBeInstanceOf(UnknownOptionError);
    expect(error.issues[1]).toBeInstanceOf(UnexpectedArgumentError);
    if (error.issues[0] instanceof UnknownOptionError) {
      expect(error.issues[0].optionName).toBe('unknown');
    }
    if (error.issues[1] instanceof UnexpectedArgumentError) {
      expect(error.issues[1].argument).toBe('plain');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['--output', '-o'])(
    'rejects non-boolean option %s when its value is missing',
    async arg => {
      // Recognizing an option without its required value is malformed input, not an implicit flag.
      const handler = vi.fn();
      const parser = createStrictParser().addCommand({
        name: 'deploy',
        options: [{ name: 'output', short: 'o', type: 'string' }],
        handler,
      });
      setArguments('deploy', arg);

      const error = await expectStrictFailure(parser.execute());

      expect(error.issues.some(issue => issue instanceof MalformedArgumentError)).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    }
  );

  it('treats an attached empty string as a supplied value', async () => {
    // An explicit equals sign supplies an empty string and must reach ordinary validation.
    const validator = vi.fn(value => value === '');
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'output', type: 'string', validator }],
      handler,
    });
    setArguments('deploy', '--output=');

    await parser.execute();

    expect(validator).toHaveBeenCalledWith('');
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: '' }));
  });

  it('keeps required and explicit values fresh across success, failure, and later success', async () => {
    // Reusing a parser cannot let a successful invocation satisfy a later missing required option.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'output', type: 'string', required: true }],
      handler,
    });

    setArguments('deploy', '--output=first');
    await parser.execute();
    setArguments('deploy');
    await expectStrictFailure(parser.execute());
    setArguments('deploy', '--output=third');
    await parser.execute();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, expect.objectContaining({ output: 'first' }));
    expect(handler).toHaveBeenNthCalledWith(2, expect.objectContaining({ output: 'third' }));
  });

  it('does not let a help invocation suppress a later valid execution', async () => {
    // Help state belongs to one invocation and must not remain active for the next command line.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      options: [{ name: 'output', type: 'string', required: true }],
      handler,
    });

    setArguments('deploy', '--help');
    await parser.execute();
    setArguments('deploy', '--output=release');
    await parser.execute();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ output: 'release' }));
  });

  it('rebuilds default and repeated values for every invocation', async () => {
    // Default-backed values recur, but arrays contain only values supplied by the current run.
    const handler = vi.fn();
    const parser = createStrictParser().addCommand({
      name: 'deploy',
      default: true,
      options: [
        { name: 'mode', type: 'string', default: 'safe' },
        { name: 'file', type: 'string', multiple: true },
      ],
      handler,
    });

    setArguments('--file=a', '--file=b');
    await parser.execute();
    setArguments('--file=c');
    await parser.execute();

    expect(handler).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: 'safe', file: ['a', 'b'] })
    );
    expect(handler).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: 'safe', file: ['c'] })
    );
  });

  it.each(['-h', '--help'])(
    'treats %s as unknown in strict mode but leaves it permissive in legacy mode',
    async help => {
      // Disabling automatic help removes its spellings without making legacy parsing strict.
      const strictHandler = vi.fn();
      const strictParser = new CommandLineParser({
        name: 'test-cli',
        version: '1.0.0',
        strict: true,
        skipHelp: true,
      }).addCommand({ name: 'deploy', handler: strictHandler });
      setArguments('deploy', help);

      const error = await expectStrictFailure(strictParser.execute());

      expect(error.issues.some(issue => issue instanceof UnknownOptionError)).toBe(true);
      expect(strictHandler).not.toHaveBeenCalled();

      const legacyHandler = vi.fn();
      const legacyParser = new CommandLineParser({
        name: 'test-cli',
        version: '1.0.0',
        strict: false,
        skipHelp: true,
      }).addCommand({ name: 'deploy', handler: legacyHandler });
      setArguments('deploy', help);

      await legacyParser.execute();

      expect(legacyHandler).toHaveBeenCalledTimes(1);
    }
  );
});
