import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CommandLineParser,
  CommandLineValidationError,
  ConflictingOptionsError,
  InvalidConfigurationError,
  MissingOptionDependencyError,
} from '../src/index.js';

type ParserMode = readonly [name: string, strict: boolean];

const parserModes: readonly ParserMode[] = [
  ['strict', true],
  ['legacy', false],
];

/** Replaces application arguments while retaining interpreter and script positions. */
function setArguments(...args: string[]): void {
  process.argv = ['node', 'test-cli.js', ...args];
}

/** Creates a parser whose mode is explicit so compatibility expectations cannot drift. */
function createParser(
  strict: boolean,
  overrides: {
    globalOptions?: Array<{
      name: string;
      short?: string;
      type?: 'string' | 'number' | 'boolean';
    }>;
  } = {}
): CommandLineParser {
  return new CommandLineParser({
    name: 'test-cli',
    version: '1.0.0',
    strict,
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

/** Captures the aggregate produced by a strict validation failure. */
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
    return error;
  }

  throw new Error('Expected strict command-line parsing to reject');
}

describe('strict parsing compatibility and activated configuration', () => {
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

  describe('legacy compatibility', () => {
    it('continues past an unknown option and an extra positional argument', async () => {
      const handler = vi.fn();
      const parser = createParser(false).addCommand({ name: 'deploy', handler });
      setArguments('deploy', '--unknown', 'extra');

      await expect(parser.execute()).resolves.toBeUndefined();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('renders help and resolves when a required option is missing', async () => {
      const handler = vi.fn();
      const parser = createParser(false).addCommand({
        name: 'deploy',
        options: [{ name: 'output', type: 'string', required: true }],
        handler,
      });
      setArguments('deploy');

      await expect(parser.execute()).resolves.toBeUndefined();

      expect(renderedOutput()).toContain('output');
      expect(handler).not.toHaveBeenCalled();
    });

    it('renders help and resolves when a known option has an invalid value', async () => {
      const handler = vi.fn();
      const parser = createParser(false).addCommand({
        name: 'deploy',
        options: [{ name: 'port', type: 'number' }],
        handler,
      });
      setArguments('deploy', '--port=invalid');

      await expect(parser.execute()).resolves.toBeUndefined();

      expect(renderedOutput()).toContain('port');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('aliases and global options', () => {
    it.each(parserModes)(
      'uses an alias to invoke canonical handler state in %s mode',
      async (_, strict) => {
        const handler = vi.fn();
        const parser = createParser(strict).addCommand({
          name: 'deploy',
          aliases: ['ship'],
          options: [{ name: 'output', type: 'string' }],
          handler,
        });
        setArguments('ship', '--output=release');

        await parser.execute();

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
    )('accepts a global option %s', async (_, strict, args) => {
      const handler = vi.fn();
      const parser = createParser(strict, {
        globalOptions: [{ name: 'profile', short: 'p', type: 'string' }],
      }).addCommand({ name: 'deploy', handler });
      setArguments(...args);

      await parser.execute();

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ profile: 'release' }));
    });
  });

  describe('conflicts and dependencies in both modes', () => {
    it('rejects conflicting options in strict mode and blocks the handler', async () => {
      const handler = vi.fn();
      const parser = createParser(true).addCommand({
        name: 'deploy',
        options: [
          { name: 'quiet', type: 'boolean', conflicts: ['verbose'] },
          { name: 'verbose', type: 'boolean' },
        ],
        handler,
      });
      setArguments('deploy', '--quiet', '--verbose');

      const error = await expectValidationFailure(parser.execute());

      expect(error.issues.filter(issue => issue instanceof ConflictingOptionsError)).toHaveLength(
        1
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it('renders help and resolves for conflicting options in legacy mode', async () => {
      const handler = vi.fn();
      const parser = createParser(false).addCommand({
        name: 'deploy',
        options: [
          { name: 'quiet', type: 'boolean', conflicts: ['verbose'] },
          { name: 'verbose', type: 'boolean' },
        ],
        handler,
      });
      setArguments('deploy', '--quiet', '--verbose');

      await expect(parser.execute()).resolves.toBeUndefined();

      expect(renderedOutput()).toContain('quiet');
      expect(renderedOutput()).toContain('verbose');
      expect(handler).not.toHaveBeenCalled();
    });

    it('rejects a missing dependency in strict mode and blocks the handler', async () => {
      const handler = vi.fn();
      const parser = createParser(true).addCommand({
        name: 'deploy',
        options: [
          { name: 'upload', type: 'boolean', depends: ['token'] },
          { name: 'token', type: 'string' },
        ],
        handler,
      });
      setArguments('deploy', '--upload');

      const error = await expectValidationFailure(parser.execute());

      expect(
        error.issues.filter(issue => issue instanceof MissingOptionDependencyError)
      ).toHaveLength(1);
      expect(handler).not.toHaveBeenCalled();
    });

    it('renders help and resolves for a missing dependency in legacy mode', async () => {
      const handler = vi.fn();
      const parser = createParser(false).addCommand({
        name: 'deploy',
        options: [
          { name: 'upload', type: 'boolean', depends: ['token'] },
          { name: 'token', type: 'string' },
        ],
        handler,
      });
      setArguments('deploy', '--upload');

      await expect(parser.execute()).resolves.toBeUndefined();

      expect(renderedOutput()).toContain('upload');
      expect(renderedOutput()).toContain('token');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('configuration collisions', () => {
    it('rejects a global and command option with the same long name', () => {
      const parser = createParser(true, {
        globalOptions: [{ name: 'output', type: 'string' }],
      });

      expect(() =>
        parser.addCommand({
          name: 'deploy',
          options: [{ name: 'output', type: 'string' }],
          handler: vi.fn(),
        })
      ).toThrow(InvalidConfigurationError);
    });

    it('rejects a global and command option with the same short name', () => {
      const parser = createParser(true, {
        globalOptions: [{ name: 'profile', short: 'p', type: 'string' }],
      });

      expect(() =>
        parser.addCommand({
          name: 'deploy',
          options: [{ name: 'port', short: 'p', type: 'number' }],
          handler: vi.fn(),
        })
      ).toThrow(InvalidConfigurationError);
    });

    it('rejects an alias that collides with a canonical command', () => {
      const parser = createParser(true).addCommand({ name: 'deploy', handler: vi.fn() });

      expect(() =>
        parser.addCommand({ name: 'publish', aliases: ['DEPLOY'], handler: vi.fn() })
      ).toThrow(InvalidConfigurationError);
    });

    it('rejects aliases that collide after normalization', () => {
      const parser = createParser(true).addCommand({
        name: 'deploy',
        aliases: ['Ship'],
        handler: vi.fn(),
      });

      expect(() =>
        parser.addCommand({ name: 'publish', aliases: ['ship'], handler: vi.fn() })
      ).toThrow(InvalidConfigurationError);
    });
  });

  describe('explicit occurrence and deterministic validation', () => {
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
      setArguments('deploy', '--cache=false', '--refresh=false');

      const error = await expectValidationFailure(parser.execute());

      expect(error.issues.filter(issue => issue instanceof ConflictingOptionsError)).toHaveLength(
        1
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not activate a conflict or dependency from a default-only owner', async () => {
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
      setArguments('deploy', '--refresh');

      await parser.execute();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ cache: false, refresh: true })
      );
    });

    it('lets an explicit false dependency owner use a default false target', async () => {
      const handler = vi.fn();
      const parser = createParser(true).addCommand({
        name: 'deploy',
        options: [
          { name: 'cache', type: 'boolean', depends: ['offline'] },
          { name: 'offline', type: 'boolean', default: false },
        ],
        handler,
      });
      setArguments('deploy', '--cache=false');

      await parser.execute();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ cache: false, offline: false })
      );
    });

    it('lets an explicitly supplied false target satisfy a dependency', async () => {
      const handler = vi.fn();
      const parser = createParser(true).addCommand({
        name: 'deploy',
        options: [
          { name: 'cache', type: 'boolean', depends: ['offline'] },
          { name: 'offline', type: 'boolean' },
        ],
        handler,
      });
      setArguments('deploy', '--cache', '--offline=false');

      await parser.execute();

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ cache: true, offline: false })
      );
    });

    it('deduplicates reciprocal conflicts and orders pairs by registration then declaration', async () => {
      const parser = createParser(true).addCommand({
        name: 'deploy',
        options: [
          { name: 'alpha', type: 'boolean', conflicts: ['gamma', 'beta'] },
          { name: 'beta', type: 'boolean', conflicts: ['alpha'] },
          { name: 'gamma', type: 'boolean', conflicts: ['alpha'] },
        ],
        handler: vi.fn(),
      });
      setArguments('deploy', '--alpha', '--alpha', '--beta', '--gamma');

      const error = await expectValidationFailure(parser.execute());
      const conflicts = error.issues.filter(
        (issue): issue is ConflictingOptionsError => issue instanceof ConflictingOptionsError
      );

      expect(conflicts.map(issue => issue.conflictingOptions)).toEqual([
        ['alpha', 'gamma'],
        ['alpha', 'beta'],
      ]);
    });

    it('deduplicates repeated missing dependencies in deterministic order', async () => {
      const parser = createParser(true).addCommand({
        name: 'deploy',
        options: [
          {
            name: 'alpha',
            type: 'string',
            multiple: true,
            depends: ['target-b', 'target-a'],
          },
          { name: 'beta', type: 'boolean', depends: ['target-c'] },
          { name: 'target-a', type: 'string' },
          { name: 'target-b', type: 'string' },
          { name: 'target-c', type: 'string' },
        ],
        handler: vi.fn(),
      });
      setArguments('deploy', '--alpha=one', '--alpha=two', '--beta');

      const error = await expectValidationFailure(parser.execute());
      const dependencies = error.issues.filter(
        (issue): issue is MissingOptionDependencyError =>
          issue instanceof MissingOptionDependencyError
      );

      expect(dependencies.map(issue => [issue.optionName, issue.dependencyName])).toEqual([
        ['alpha', 'target-b'],
        ['alpha', 'target-a'],
        ['beta', 'target-c'],
      ]);
    });
  });

  it.each(parserModes)(
    'disables an effective default when multiple commands exist in %s mode',
    async (_, strict) => {
      const defaultHandler = vi.fn();
      const otherHandler = vi.fn();
      const parser = createParser(strict)
        .addCommand({ name: 'deploy', default: true, handler: defaultHandler })
        .addCommand({ name: 'inspect', handler: otherHandler });
      setArguments();

      await parser.execute();

      expect(renderedOutput()).toContain('deploy');
      expect(renderedOutput()).toContain('inspect');
      expect(defaultHandler).not.toHaveBeenCalled();
      expect(otherHandler).not.toHaveBeenCalled();
    }
  );
});
