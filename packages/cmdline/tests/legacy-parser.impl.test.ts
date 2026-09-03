import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandLineParser, MalformedArgumentError } from '../src/index.js';
import type { ICommandOption, IToken, OptionValueType } from '../src/types.js';

/** Exposes protected legacy helpers for focused branch and invariant coverage. */
class InspectableCommandLineParser extends CommandLineParser {
  /** Applies the legacy quote and escape normalization. */
  public quote(argument: string): string {
    return this.processQuotedArgument(argument);
  }

  /** Applies legacy argument-shape validation. */
  public validateArgumentShape(argument: string): void {
    this.validateArgument(argument);
  }

  /** Runs legacy tokenization against the current process arguments. */
  public tokenize(): IToken[] {
    return this.parseTokens();
  }

  /** Runs legacy semantic validation against prepared tokens. */
  public validatePrepared(tokens: IToken[]): { errors: string[] } {
    return this.validate(tokens);
  }
}

/** Creates one command token for direct legacy semantic validation. */
function commandToken(name = 'deploy'): IToken {
  return {
    index: 0,
    arg: name,
    isCommand: true,
    isOption: false,
    isValue: false,
    value: name,
  };
}

/** Creates one canonical option token with a caller-selected runtime value. */
function optionToken(name: string, value: OptionValueType, index: number): IToken {
  return {
    index,
    arg: name,
    isCommand: false,
    isOption: true,
    isLongOption: true,
    isValue: false,
    value,
  };
}

describe('legacy parser implementation boundaries', () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('normalizes paired quotes and escaped characters', () => {
    const parser = new InspectableCommandLineParser({ name: 'test-cli' });

    expect(parser.quote('"hello world"')).toBe('hello world');
    expect(parser.quote("'hello world'")).toBe('hello world');
    expect(parser.quote('hello\\ world')).toBe('hello world');
  });

  it.each(['', '-', '--', '--bad$name', '-1x'])(
    'rejects malformed legacy argument %j',
    argument => {
      const parser = new InspectableCommandLineParser({ name: 'test-cli' });

      expect(() => parser.validateArgumentShape(argument)).toThrow(MalformedArgumentError);
    }
  );

  it.each(['deploy', '--output=value', '-3', '-3.5'])(
    'accepts well-formed legacy argument %j',
    argument => {
      const parser = new InspectableCommandLineParser({ name: 'test-cli' });

      expect(() => parser.validateArgumentShape(argument)).not.toThrow();
    }
  );

  it('tokenizes compact, attached, separate, quoted, and JSON-shaped legacy values', () => {
    const parser = new InspectableCommandLineParser({
      name: 'test-cli',
      globalOptions: [{ name: 'profile', short: 'p', type: 'string' }],
    });
    parser.addCommand({
      name: 'Deploy',
      options: [
        { name: 'output', short: 'o', type: 'string' },
        { name: 'enabled', short: 'e', type: 'boolean' },
      ],
      handler: vi.fn(),
    });
    process.argv = [
      'node',
      'test-cli.js',
      '-p=release',
      'DEPLOY',
      '-o',
      '=artifact',
      '--enabled=false',
      '--unknown={"ok":true}',
    ];

    const tokens = parser.tokenize();

    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ arg: 'deploy', isCommand: true }),
        expect.objectContaining({ arg: 'p', value: 'release' }),
        expect.objectContaining({ arg: 'o', value: 'artifact' }),
        expect.objectContaining({ arg: 'enabled', value: false }),
      ])
    );
  });

  it('reports every invalid default type and validator result in legacy validation', () => {
    const options: ICommandOption[] = [
      { name: 'string-value', type: 'string', default: 5 },
      { name: 'number-value', type: 'number', default: 'bad' },
      { name: 'boolean-value', type: 'boolean', default: 'bad' },
      { name: 'email-type', type: 'email', default: 5 },
      { name: 'email-format', type: 'email', default: 'bad' },
      { name: 'domain-type', type: 'domain', default: 5 },
      { name: 'domain-format', type: 'domain', default: '.bad' },
      { name: 'validator-false', default: 'value', validator: () => false },
      { name: 'validator-message', default: 'value', validator: () => 'custom default failure' },
    ];
    const parser = new InspectableCommandLineParser({ name: 'test-cli' });
    parser.addCommand({
      name: 'deploy',
      options,
      handler: vi.fn(),
    });

    const result = parser.validatePrepared([commandToken()]);

    expect(result.errors).toHaveLength(9);
    expect(result.errors).toContain('custom default failure');
  });

  it('reports supplied type, format, choice, and validator failures in legacy validation', () => {
    const options: ICommandOption[] = [
      { name: 'string-value', type: 'string' },
      { name: 'number-value', type: 'number' },
      { name: 'boolean-value', type: 'boolean' },
      { name: 'email-type', type: 'email' },
      { name: 'email-format', type: 'email' },
      { name: 'domain-type', type: 'domain' },
      { name: 'domain-format', type: 'domain' },
      { name: 'choice', choices: ['allowed'] },
      { name: 'validator-false', validator: () => false },
      { name: 'validator-message', validator: () => 'custom supplied failure' },
    ];
    const parser = new InspectableCommandLineParser({ name: 'test-cli' });
    parser.addCommand({
      name: 'deploy',
      options,
      handler: vi.fn(),
    });
    const values: OptionValueType[] = [
      5,
      'bad',
      '.bad',
      5,
      'bad',
      5,
      '.bad',
      'denied',
      'value',
      'value',
    ];
    const tokens = options.map((option, index) =>
      optionToken(option.name, values[index]!, index + 1)
    );

    const result = parser.validatePrepared([commandToken(), ...tokens]);

    expect(result.errors).toHaveLength(10);
    expect(result.errors).toContain('custom supplied failure');
  });

  it('renders malformed legacy input as help and resolves', async () => {
    const handler = vi.fn();
    const parser = new CommandLineParser({ name: 'test-cli' }).addCommand({
      name: 'deploy',
      handler,
    });
    process.argv = ['node', 'test-cli.js', 'deploy', '--'];

    await expect(parser.execute()).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalled();
  });

  it('provides a callable legacy showHelp helper to a successful handler', async () => {
    const handler = vi.fn((options: Record<string, unknown>) => {
      const showHelp = Reflect.get(options, 'showHelp');
      if (typeof showHelp === 'function') {
        showHelp();
      }
    });
    const parser = new CommandLineParser({ name: 'test-cli' }).addCommand({
      name: 'deploy',
      handler,
    });
    process.argv = ['node', 'test-cli.js', 'deploy'];

    await parser.execute();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalled();
  });
});
