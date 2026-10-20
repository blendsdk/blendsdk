import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
  ErrorCode,
  InvalidConfigurationError,
  MissingOptionDependencyError,
  UnknownOptionError,
} from '../src/index.js';

/** Replaces application arguments while retaining interpreter and script positions. */
function setArguments(...args: string[]): void {
  process.argv = ['node', 'test-cli.js', ...args];
}

describe('strict failure implementation', () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('requires at least one specific issue in a validation aggregate', () => {
    expect(() => new CommandLineValidationError([])).toThrow(TypeError);
  });

  it('copies and freezes aggregate issues against later caller mutation', () => {
    const source = [new UnknownOptionError('bad', 'deploy')];
    const aggregate = new CommandLineValidationError(source);

    source.push(new UnknownOptionError('later', 'deploy'));

    expect(aggregate.issues).toHaveLength(1);
    expect(Object.isFrozen(aggregate.issues)).toBe(true);
  });

  it('preserves a non-Error hook rejection beside the parser aggregate', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handlerFailure = { channel: 'diagnostics unavailable' };
    const parser = new CommandLineParser({
      name: 'test-cli',
      strict: true,
      errorHandler: async () => Promise.reject(handlerFailure),
    }).addCommand({ name: 'deploy', handler: vi.fn() });
    setArguments('deploy', '--unknown');

    try {
      await parser.execute();
      throw new Error('Expected strict execution to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(CommandLineErrorHandlerError);
      if (error instanceof CommandLineErrorHandlerError) {
        expect(error.parserError).toBeInstanceOf(CommandLineValidationError);
        expect(error.handlerError).toBe(handlerFailure);
      }
    }
  });

  it('exposes canonical dependency context through the public typed error', () => {
    const error = new MissingOptionDependencyError('upload', 'token', 'deploy');

    expect(error.code).toBe(ErrorCode.MISSING_OPTION_DEPENDENCY);
    expect(error.optionName).toBe('upload');
    expect(error.dependencyName).toBe('token');
    expect(error.commandName).toBe('deploy');
  });

  it.each([
    ['reserved alias', { name: 'deploy', aliases: ['help'] }],
    ['malformed alias', { name: 'deploy', aliases: ['bad alias'] }],
    ['duplicate normalized aliases', { name: 'deploy', aliases: ['Ship', 'ship'] }],
  ])('rejects %s during command registration', (_description, command) => {
    const parser = new CommandLineParser({ name: 'test-cli', strict: true });

    expect(() => parser.addCommand({ ...command, handler: vi.fn() })).toThrow(
      InvalidConfigurationError
    );
  });

  it('rejects a canonical command that collides with an existing alias', () => {
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'deploy',
      aliases: ['ship'],
      handler: vi.fn(),
    });

    expect(() => parser.addCommand({ name: 'SHIP', handler: vi.fn() })).toThrow(
      InvalidConfigurationError
    );
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

  it('preserves case-distinct option registration for legacy compatibility', () => {
    expect(() =>
      new CommandLineParser({
        name: 'test-cli',
        strict: false,
        globalOptions: [
          { name: 'profile', short: 'p' },
          { name: 'Profile', short: 'P' },
        ],
      }).addCommand({
        name: 'deploy',
        options: [
          { name: 'output', short: 'o' },
          { name: 'Output', short: 'O' },
        ],
        handler: vi.fn(),
      })
    ).not.toThrow();
  });

  it.each([
    ['global', { globalOptions: [{ name: 'host', short: 'h' }] }],
    ['command', {}],
  ])('rejects %s short h when automatic help is enabled', (owner, config) => {
    if (owner === 'global') {
      expect(() => new CommandLineParser({ name: 'test-cli', ...config })).toThrow(
        InvalidConfigurationError
      );
      return;
    }

    const parser = new CommandLineParser({ name: 'test-cli' });
    expect(() =>
      parser.addCommand({
        name: 'deploy',
        options: [{ name: 'host', short: 'h' }],
        handler: vi.fn(),
      })
    ).toThrow(InvalidConfigurationError);
  });

  it('allows short h when automatic help is disabled', () => {
    expect(() =>
      new CommandLineParser({
        name: 'test-cli',
        skipHelp: true,
        globalOptions: [{ name: 'host', short: 'h' }],
      }).addCommand({ name: 'deploy', handler: vi.fn() })
    ).not.toThrow();
  });

  it.each([
    ['global', true],
    ['command', false],
  ])('keeps uppercase short H distinct from automatic help for a %s option', async (_, global) => {
    const handler = vi.fn();
    const option = { name: 'host', short: 'H', type: 'string' as const };
    const parser = new CommandLineParser({
      name: 'test-cli',
      strict: false,
      globalOptions: global ? [option] : undefined,
    }).addCommand({
      name: 'deploy',
      options: global ? undefined : [option],
      handler,
    });
    setArguments('deploy', '-H=example.test');

    await parser.execute();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ host: 'example.test' }));
  });

  it('consumes case-distinct leading legacy globals by their exact spelling', async () => {
    const handler = vi.fn();
    const parser = new CommandLineParser({
      name: 'test-cli',
      strict: false,
      globalOptions: [
        { name: 'profile', type: 'boolean' },
        { name: 'Profile', type: 'string' },
      ],
    }).addCommand({ name: 'deploy', handler });
    setArguments('--Profile', 'release', 'deploy');

    await parser.execute();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ Profile: 'release' }));
  });

  it.each([
    ['strict', true],
    ['legacy', false],
  ])('detaches registered command data from caller mutation in %s mode', async (_, strict) => {
    const intendedHandler = vi.fn();
    const redirectedHandler = vi.fn();
    const statusHandler = vi.fn();
    const aliases = ['ship'];
    const choices = ['safe'];
    const conflicts = ['quiet'];
    const depends = ['token'];
    const commandOption = {
      name: 'upload',
      type: 'boolean' as const,
      conflicts,
      depends,
    };
    const command = {
      name: 'deploy',
      aliases,
      examples: ['deploy --upload --token=value'],
      options: [
        commandOption,
        { name: 'token', type: 'string' as const, choices },
        { name: 'quiet', type: 'boolean' as const },
      ],
      handler: intendedHandler,
    };
    const parser = new CommandLineParser({ name: 'test-cli', strict })
      .addCommand(command)
      .addCommand({ name: 'status', handler: statusHandler });

    aliases.push('status');
    choices.push('mutated');
    conflicts.push('token');
    depends.push('missing');
    commandOption.name = 'changed';
    command.name = 'renamed';
    command.handler = redirectedHandler;

    setArguments('status');
    await parser.execute();
    setArguments('deploy', '--upload', '--token=safe');
    await parser.execute();

    expect(statusHandler).toHaveBeenCalledTimes(1);
    expect(intendedHandler).toHaveBeenCalledTimes(1);
    expect(redirectedHandler).not.toHaveBeenCalled();
  });

  it.each([
    ['strict', true],
    ['legacy', false],
  ])(
    'detaches parser configuration and global options from caller mutation in %s mode',
    async (_, strict) => {
      const globalOption = { name: 'profile', short: 'p', type: 'string' as const };
      const globalOptions = [globalOption];
      const helpOption = { name: 'usage', short: 'u', description: 'Show usage' };
      const config = { name: 'test-cli', strict, globalOptions, helpOption };
      const handler = vi.fn();
      const parser = new CommandLineParser(config).addCommand({ name: 'deploy', handler });

      globalOption.name = 'changed';
      globalOption.short = 'x';
      globalOptions.push({ name: 'injected', type: 'string' });
      helpOption.name = 'changed-help';
      config.name = 'changed-cli';

      setArguments('--profile=production', 'deploy');
      await parser.execute();

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ profile: 'production' }));
    }
  );

  it.each(['--unknown', '-x', '--'])(
    'does not select a later legacy command after leading %s',
    async leading => {
      const handler = vi.fn();
      const parser = new CommandLineParser({ name: 'test-cli', strict: false }).addCommand({
        name: 'deploy',
        handler,
      });
      setArguments(leading, 'deploy');

      await expect(parser.execute()).resolves.toBeUndefined();

      expect(handler).not.toHaveBeenCalled();
    }
  );
});
